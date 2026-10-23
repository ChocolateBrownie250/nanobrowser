// One attached tab: the Puppeteer connection, the raw command channel with per-command timeouts,
// event fan-out keyed by (tabId, sessionId), and detach handling.
import { LayerError } from '../protocol/errors';
import type { Attacher, CdpPort, DetachInfo, PagePort, SessionId, TabAttachment, TopologyPort } from '../core/ports';
import { DEFAULT_COMMAND_TIMEOUT_MS, normalizeSessionId, sendRaw } from './cdp-session';
import { connectTab, disconnectTab } from './puppeteer';
import type { PuppeteerConnection } from './puppeteer';
import { PuppeteerFrameTopology } from './frame-topology';
import { PuppeteerPagePort } from './page-port';
import { isRestrictedPageUrl } from '../core/url-policy';

/** Chrome's refusal when a debugger is on the tab already: "Another debugger is already attached to the tab ...". */
const ALREADY_ATTACHED = /already attached/i;

type EventHandler = (params: unknown, sessionId: SessionId) => void;

/** Pages the debugger cannot attach to (restricted pages): the same schemes layer 1 refuses, see `isRestrictedPageUrl`. */
export function isRestrictedUrl(url: string): boolean {
  return isRestrictedPageUrl(url);
}

const connections = new Map<number, ChromeTabConnection>();
/** Connections being made, one per tab: a second open of a tab shares the first instead of detaching it. */
const opening = new Map<number, Promise<ChromeTabConnection>>();
/** A detach that came while a tab's connection was still being made; applied when the connection is registered. */
const detachedWhileOpening = new Map<number, DetachInfo>();
let listening = false;

/** Registers the debugger's event listeners, once. Called at worker start so no event is missed. */
function listen() {
  if (listening) return;
  listening = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    connections.get(source.tabId)?.dispatch(normalizeSessionId(source.sessionId), method, params);
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    const connection = connections.get(source.tabId);
    if (connection) connection.markDetached({ reason });
    else if (opening.has(source.tabId)) detachedWhileOpening.set(source.tabId, { reason });
  });
}

let swept: Promise<void> | undefined;

/**
 * Detaches the debugger from every tab it is still on when the worker starts. A restarted worker has no connection
 * object for them, and a session left behind can keep Fetch interception on, which freezes the tab's page loads.
 * Chrome only lets an extension detach its own sessions, so DevTools and other extensions are not affected: their
 * detach fails and is ignored. Runs once; every attach waits for it. Does nothing without chrome.debugger.
 */
export function releaseLeftoverDebuggerSessions(): Promise<void> {
  if (swept) return swept;
  if (typeof chrome === 'undefined' || !chrome.debugger?.getTargets) return (swept = Promise.resolve());
  listen();
  swept = (async () => {
    try {
      const targets = await chrome.debugger.getTargets();
      await Promise.all(
        targets
          .filter(t => t.attached && t.tabId !== undefined && !connections.has(t.tabId))
          .map(t => chrome.debugger.detach({ tabId: t.tabId }).catch(() => undefined)),
      );
    } catch {
      // Nothing to release, or the browser would not say.
    }
  })();
  return swept;
}

class ChromeCdpPort implements CdpPort {
  constructor(private readonly connection: ChromeTabConnection) {}

  get tabId() {
    return this.connection.tabId;
  }

  send<T = unknown>(sessionId: SessionId, method: string, params: object = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    return this.connection.send<T>(sessionId, method, params, timeoutMs);
  }

  on(method: string, handler: EventHandler, only?: { sessionId: SessionId }): () => void {
    return this.connection.subscribe(method, handler, only?.sessionId, only !== undefined);
  }
}

export class ChromeTabConnection implements TabAttachment {
  readonly cdp: CdpPort;
  readonly topology: TopologyPort;
  readonly page: PagePort;
  #detached: DetachInfo | null = null;
  /** Puppeteer is disconnected once: a second disconnect detaches again, and Chrome's refusal goes uncaught. */
  #disconnected = false;
  #detachHandlers = new Set<(info: DetachInfo) => void>();
  #rejectDetached!: (error: Error) => void;
  /** Settles (rejects) when the tab detaches; raced against every pending command. */
  readonly #detachedSignal: Promise<never>;
  #handlers = new Map<string, Set<{ handler: EventHandler; sessionId: SessionId; scoped: boolean }>>();

  private constructor(
    readonly tabId: number,
    private readonly puppeteer: PuppeteerConnection,
  ) {
    this.#detachedSignal = new Promise<never>((_, reject) => (this.#rejectDetached = reject));
    this.#detachedSignal.catch(() => undefined);
    this.cdp = new ChromeCdpPort(this);
    this.topology = new PuppeteerFrameTopology(puppeteer.page, this.cdp);
    this.page = new PuppeteerPagePort(puppeteer.page, this.cdp);
  }

  /** The tab's connection: the live one, or the one being made (one attach per tab at a time). */
  static open(tabId: number): Promise<ChromeTabConnection> {
    listen();
    const existing = connections.get(tabId);
    if (existing && !existing.detached) return Promise.resolve(existing);
    let pending = opening.get(tabId);
    if (!pending) {
      pending = ChromeTabConnection.#connect(tabId).finally(() => {
        opening.delete(tabId);
        detachedWhileOpening.delete(tabId);
      });
      opening.set(tabId, pending);
    }
    return pending;
  }

  static async #connect(tabId: number): Promise<ChromeTabConnection> {
    // Sessions a restarted worker left behind go first, so they cannot be mistaken for another debugger.
    await releaseLeftoverDebuggerSessions();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new LayerError('TAB_NOT_IN_SESSION', `Tab ${tabId} does not exist`);
    if (isRestrictedUrl(tab.url ?? tab.pendingUrl ?? '')) {
      throw new LayerError('PAGE_NOT_SUPPORTED', `Tab ${tabId} shows a page that cannot be controlled: ${tab.url}`);
    }
    let puppeteer: PuppeteerConnection;
    try {
      puppeteer = await connectTab(tabId).catch(async error => {
        // This extension's debugger is still on the tab though no connection here knows it: the service worker
        // restarted while the tab was attached. Detach it and attach again. Another client's debugger cannot be
        // detached from here, and the second attempt then fails with the same error.
        if (!ALREADY_ATTACHED.test(error instanceof Error ? error.message : String(error))) throw error;
        await chrome.debugger.detach({ tabId }).catch(() => undefined);
        return connectTab(tabId);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ALREADY_ATTACHED.test(message)) {
        throw new LayerError(
          'PAGE_NOT_SUPPORTED',
          `Another debugger (DevTools, or another extension) is attached to tab ${tabId}, so it cannot be controlled. Close it and try again.`,
        );
      }
      if (/cannot access|cannot attach|chrome:\/\/|extensions gallery/i.test(message)) {
        throw new LayerError('PAGE_NOT_SUPPORTED', `Cannot attach to tab ${tabId}: ${message}`);
      }
      throw new LayerError('INTERNAL', `Cannot attach to tab ${tabId}: ${message}`);
    }
    const connection = new ChromeTabConnection(tabId, puppeteer);
    connections.set(tabId, connection);
    // A detach that came while the connection was being made is applied now, so no one is handed a dead connection
    // that looks live.
    const early = detachedWhileOpening.get(tabId);
    if (early) {
      connection.markDetached(early);
      return connection;
    }
    // The operated tab may sit in a window the user is not in; keep the page behaving as focused.
    await connection.cdp
      .send(undefined, 'Emulation.setFocusEmulationEnabled', { enabled: true })
      .catch(() => undefined);
    return connection;
  }

  /** Puppeteer's page, for diagnostics in the test extension's checks only. The layer never uses it. */
  get diagnosticPage(): unknown {
    return this.puppeteer.page;
  }

  get detached(): DetachInfo | null {
    return this.#detached;
  }

  send<T>(sessionId: SessionId, method: string, params: object, timeoutMs: number): Promise<T> {
    if (this.#detached) {
      return Promise.reject(
        new LayerError('DEBUGGER_DETACHED', `Tab ${this.tabId} is detached (${this.#detached.reason})`, {
          delivered: 'unknown',
        }),
      );
    }
    return sendRaw<T>(this.tabId, sessionId, method, params, timeoutMs, this.#detachedSignal).catch(error => {
      // Chrome says the tab is gone before (or without) an onDetach event: the connection is dead from now on.
      if (error instanceof LayerError && error.code === 'DEBUGGER_DETACHED')
        this.markDetached({ reason: 'command_failed' });
      throw error;
    });
  }

  subscribe(method: string, handler: EventHandler, sessionId: SessionId, scoped: boolean): () => void {
    let set = this.#handlers.get(method);
    if (!set) this.#handlers.set(method, (set = new Set()));
    const entry = { handler, sessionId, scoped };
    set.add(entry);
    return () => set!.delete(entry);
  }

  dispatch(sessionId: SessionId, method: string, params: unknown): void {
    const set = this.#handlers.get(method);
    if (!set) return;
    for (const entry of [...set]) {
      if (entry.scoped && entry.sessionId !== sessionId) continue;
      try {
        entry.handler(params, sessionId);
      } catch (error) {
        console.error('[browser-control] event handler failed', method, error);
      }
    }
  }

  markDetached(info: DetachInfo): void {
    if (this.#detached) return;
    this.#detached = info;
    if (connections.get(this.tabId) === this) connections.delete(this.tabId);
    this.#rejectDetached(
      new LayerError('DEBUGGER_DETACHED', `The debugger detached from tab ${this.tabId} (${info.reason})`, {
        delivered: 'unknown',
      }),
    );
    for (const handler of [...this.#detachHandlers]) {
      try {
        handler(info);
      } catch (error) {
        console.error('[browser-control] detach handler failed', error);
      }
    }
    // Let Puppeteer drop its state, unless close() already did.
    void this.#disconnect().catch(() => undefined);
  }

  #disconnect(): Promise<void> {
    if (this.#disconnected) return Promise.resolve();
    this.#disconnected = true;
    return disconnectTab(this.puppeteer);
  }

  onDetach(handler: (info: DetachInfo) => void): () => void {
    this.#detachHandlers.add(handler);
    return () => this.#detachHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.#detached) return;
    if (connections.get(this.tabId) === this) connections.delete(this.tabId);
    try {
      await this.#disconnect();
    } finally {
      this.markDetached({ reason: 'closed_by_layer' });
    }
  }
}

export const chromeAttacher: Attacher = {
  attach: tabId => ChromeTabConnection.open(tabId),
};

// The only module that imports Puppeteer. It connects through ExtensionTransport (chrome.debugger) and
// hands out the page whose frame manager tracks frames, out-of-process iframes included.
import { connect, ExtensionTransport } from 'puppeteer-core/internal/puppeteer-core-browser.js';
import type { KeyInput, PageEvent, ProtocolType } from 'puppeteer-core/internal/puppeteer-core-browser.js';
import type { Browser } from 'puppeteer-core/internal/api/Browser.js';
import type { Frame } from 'puppeteer-core/internal/api/Frame.js';
import type { Page } from 'puppeteer-core/internal/api/Page.js';
import { _keyDefinitions } from 'puppeteer-core/internal/common/USKeyboardLayout.js';

export type { Browser, Frame, KeyInput, Page, PageEvent };

/** Whether Puppeteer's US layout has a key of this name (or for this character). */
export function isKnownKey(key: string): key is KeyInput {
  return Object.prototype.hasOwnProperty.call(_keyDefinitions, key);
}

export interface PuppeteerConnection {
  tabId: number;
  browser: Browser;
  page: Page;
  /** The debugger transport: closing it detaches the debugger even when Puppeteer does not answer. */
  transport: { close(): void };
}

/** Puppeteer's own commands (key events, back and forward, the first frame tree) wait this long, not its 180 s. */
export const PROTOCOL_TIMEOUT_MS = 30_000;
/** Attaching, and connecting Puppeteer, each; the debugger is detached again when one does not finish. */
export const CONNECT_TIMEOUT_MS = 20_000;
/** Disconnecting; the transport is closed directly when Puppeteer does not finish. */
export const DISCONNECT_TIMEOUT_MS = 5_000;

class DeadlineError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not finish within ${ms} ms`);
    this.name = 'DeadlineError';
  }
}

/**
 * Waits for `work` for at most `ms`. When it finishes only after the deadline, `discard` is given what it produced, so
 * a late result does not keep a debugger attached.
 */
async function within<T>(work: Promise<T>, ms: number, what: string, discard: (late: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new DeadlineError(what, ms));
    }, ms);
  });
  work.then(
    late => {
      if (expired) discard(late);
    },
    () => undefined,
  );
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function connectTab(tabId: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<PuppeteerConnection> {
  const transport = await within(ExtensionTransport.connectTab(tabId), timeoutMs, `Attaching to tab ${tabId}`, late =>
    late.close(),
  );
  // The debugger is attached from here on: any failure detaches it again, or the tab could not be attached later.
  const made: { browser?: Browser } = {};
  try {
    const connected = (async (): Promise<PuppeteerConnection> => {
      const browser = (made.browser = await connect({
        transport,
        defaultViewport: null,
        protocol: 'cdp' as ProtocolType,
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
      }));
      const [page] = await browser.pages();
      if (!page) throw new Error(`No page target for tab ${tabId}`);
      return { tabId, browser, page, transport };
    })();
    return await within(connected, timeoutMs, `Connecting to tab ${tabId}`, late => {
      void late.browser.disconnect().catch(() => late.transport.close());
    });
  } catch (error) {
    // Disconnecting closes the transport; without a browser, or when it does not answer, the transport is closed directly.
    if (made.browser) {
      await within(made.browser.disconnect(), timeoutMs, `Disconnecting from tab ${tabId}`, () => undefined).catch(() =>
        transport.close(),
      );
    } else transport.close();
    throw error;
  }
}

export async function disconnectTab(connection: PuppeteerConnection, timeoutMs = DISCONNECT_TIMEOUT_MS): Promise<void> {
  // Disconnecting closes the transport, which detaches the debugger. If Puppeteer does not answer in time, the
  // transport is closed directly, so the tab is never left attached.
  const what = `Disconnecting from tab ${connection.tabId}`;
  try {
    await within(connection.browser.disconnect(), timeoutMs, what, () => undefined);
  } catch (error) {
    if (error instanceof DeadlineError) connection.transport.close();
    throw error;
  }
}

// The host's tab connection against a fake chrome.debugger: one attach per tab, detach events that come early, commands
// that fail because the tab is gone, and the sweep of sessions a restarted worker left behind.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PuppeteerConnection } from '../puppeteer';

type DetachListener = (source: { tabId?: number }, reason: string) => void;

const connectTab = vi.fn();
const disconnectTab = vi.fn(async () => undefined);
vi.mock('../puppeteer', () => ({
  connectTab: (...args: unknown[]) => connectTab(...args),
  disconnectTab: (...args: unknown[]) => (disconnectTab as (...a: unknown[]) => Promise<void>)(...args),
}));

const debuggerApi = {
  onEvent: { addListener: vi.fn() },
  onDetach: { addListener: vi.fn() },
  sendCommand: vi.fn(),
  detach: vi.fn(),
  getTargets: vi.fn(),
};
const tabsApi = { get: vi.fn() };

function puppeteerFor(tabId: number): PuppeteerConnection {
  return { tabId, browser: {}, page: {}, transport: { close: vi.fn() } } as unknown as PuppeteerConnection;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** The module under test is loaded afresh per test: it keeps the connections and the sweep in module state. */
async function load() {
  vi.resetModules();
  return import('../connection');
}

function fireDetach(tabId: number, reason: string) {
  for (const [listener] of debuggerApi.onDetach.addListener.mock.calls) (listener as DetachListener)({ tabId }, reason);
}

beforeEach(() => {
  vi.clearAllMocks();
  connectTab.mockImplementation(async (tabId: number) => puppeteerFor(tabId));
  debuggerApi.sendCommand.mockResolvedValue({});
  debuggerApi.detach.mockResolvedValue(undefined);
  debuggerApi.getTargets.mockResolvedValue([]);
  tabsApi.get.mockImplementation(async (id: number) => ({ id, url: 'https://example.com/' }));
  vi.stubGlobal('chrome', { debugger: debuggerApi, tabs: tabsApi });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('isRestrictedUrl', () => {
  it.each([
    'chrome://settings',
    'chrome:kill',
    'Chrome:/version',
    'chrome-extension://abc/x.html',
    'chrome-search://local-ntp/',
    'chrome-untrusted://x/',
    'devtools://devtools/x.html',
    'edge://settings',
    'EDGE:settings',
    'view-source:https://example.com/',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/category/extensions',
  ])('restricts %s', async url => {
    const { isRestrictedUrl } = await load();
    expect(isRestrictedUrl(url)).toBe(true);
  });

  it.each([
    '',
    'about:blank',
    'https://example.com/',
    'http://localhost:3000/',
    // A host that only starts with the Web Store's name is not the Web Store.
    'https://chromewebstore.google.com.evil.test/',
    'https://chrome.google.com/other',
  ])('does not restrict %j', async url => {
    const { isRestrictedUrl } = await load();
    expect(isRestrictedUrl(url)).toBe(false);
  });
});

describe('ChromeTabConnection.open', () => {
  it('attaches a tab once however many opens overlap', async () => {
    const { ChromeTabConnection } = await load();
    const gate = deferred<PuppeteerConnection>();
    connectTab.mockReturnValueOnce(gate.promise);
    const first = ChromeTabConnection.open(7);
    const second = ChromeTabConnection.open(7);
    await vi.waitFor(() => expect(connectTab).toHaveBeenCalledTimes(1));
    gate.resolve(puppeteerFor(7));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(connectTab).toHaveBeenCalledTimes(1);
    expect(debuggerApi.detach).not.toHaveBeenCalled();
    // A later open of the live tab reuses it.
    await expect(ChromeTabConnection.open(7)).resolves.toBe(a);
    expect(connectTab).toHaveBeenCalledTimes(1);
  });

  it('refuses a restricted page and a missing tab without attaching', async () => {
    const { ChromeTabConnection } = await load();
    tabsApi.get.mockResolvedValueOnce({ id: 7, url: 'chrome:kill' });
    await expect(ChromeTabConnection.open(7)).rejects.toMatchObject({ code: 'PAGE_NOT_SUPPORTED' });
    tabsApi.get.mockRejectedValueOnce(new Error('No tab with id: 8'));
    await expect(ChromeTabConnection.open(8)).rejects.toMatchObject({ code: 'TAB_NOT_IN_SESSION' });
    expect(connectTab).not.toHaveBeenCalled();
  });

  it('applies a detach that arrives while the connection is being made', async () => {
    const { ChromeTabConnection } = await load();
    const gate = deferred<PuppeteerConnection>();
    connectTab.mockReturnValueOnce(gate.promise);
    const opening = ChromeTabConnection.open(7);
    await vi.waitFor(() => expect(connectTab).toHaveBeenCalledTimes(1));
    fireDetach(7, 'canceled_by_user');
    gate.resolve(puppeteerFor(7));
    const connection = await opening;
    expect(connection.detached).toEqual({ reason: 'canceled_by_user' });
    await expect(connection.send(undefined, 'Page.enable', {}, 1000)).rejects.toMatchObject({
      code: 'DEBUGGER_DETACHED',
    });
    // The dead connection is not handed out again: the next open attaches afresh.
    await ChromeTabConnection.open(7);
    expect(connectTab).toHaveBeenCalledTimes(2);
  });

  it('does not carry a detach over to the next attach of the tab', async () => {
    const { ChromeTabConnection } = await load();
    const gate = deferred<PuppeteerConnection>();
    connectTab.mockReturnValueOnce(gate.promise);
    const first = ChromeTabConnection.open(7);
    await vi.waitFor(() => expect(connectTab).toHaveBeenCalledTimes(1));
    fireDetach(7, 'target_closed');
    gate.resolve(puppeteerFor(7));
    await first;
    const second = await ChromeTabConnection.open(7);
    expect(second.detached).toBeNull();
  });

  it('detaches this extension’s leftover session and attaches again', async () => {
    const { ChromeTabConnection } = await load();
    connectTab.mockRejectedValueOnce(new Error('Another debugger is already attached to the tab with id: 7.'));
    const connection = await ChromeTabConnection.open(7);
    expect(connection.detached).toBeNull();
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 7 });
    expect(connectTab).toHaveBeenCalledTimes(2);
  });

  it('says another debugger holds the tab when detaching does not help', async () => {
    const { ChromeTabConnection } = await load();
    connectTab.mockRejectedValue(new Error('Another debugger is already attached to the tab with id: 7.'));
    const error = await ChromeTabConnection.open(7).catch(e => e);
    expect(error).toMatchObject({ code: 'PAGE_NOT_SUPPORTED' });
    expect(error.message).toMatch(/Another debugger \(DevTools, or another extension\)/);
    expect(error.message).not.toMatch(/internal/i);
  });

  it('types other attach failures', async () => {
    const { ChromeTabConnection } = await load();
    connectTab.mockRejectedValueOnce(new Error('Cannot access a chrome:// URL'));
    await expect(ChromeTabConnection.open(7)).rejects.toMatchObject({ code: 'PAGE_NOT_SUPPORTED' });
    connectTab.mockRejectedValueOnce(new Error('Attaching to tab 7 did not finish within 20000 ms'));
    await expect(ChromeTabConnection.open(7)).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('commands of a connection', () => {
  it('marks the connection detached when Chrome says the tab is gone', async () => {
    const { ChromeTabConnection } = await load();
    const connection = await ChromeTabConnection.open(7);
    debuggerApi.sendCommand.mockRejectedValueOnce(new Error('Detached while handling command.'));
    await expect(connection.send(undefined, 'Runtime.evaluate', {}, 1000)).rejects.toMatchObject({
      code: 'DEBUGGER_DETACHED',
      delivered: 'unknown',
    });
    expect(connection.detached).toEqual({ reason: 'command_failed' });
    // Puppeteer is told to drop its state, and the next open attaches again.
    expect(disconnectTab).toHaveBeenCalledTimes(1);
    await ChromeTabConnection.open(7);
    expect(connectTab).toHaveBeenCalledTimes(2);
  });

  it('keeps the connection after an ordinary command error and after a timeout', async () => {
    vi.useFakeTimers();
    const { ChromeTabConnection } = await load();
    const connection = await ChromeTabConnection.open(7);
    debuggerApi.sendCommand.mockRejectedValueOnce(new Error('Cannot find context with specified id'));
    await expect(connection.send(undefined, 'Runtime.callFunctionOn', {}, 1000)).rejects.toMatchObject({
      name: 'CdpCommandError',
    });
    debuggerApi.sendCommand.mockReturnValueOnce(new Promise(() => undefined));
    const timed = connection.send(undefined, 'Page.captureScreenshot', {}, 1000);
    const assertion = expect(timed).rejects.toMatchObject({ name: 'CdpTimeoutError', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(connection.detached).toBeNull();
  });

  it('rejects a pending command at once when the tab detaches', async () => {
    const { ChromeTabConnection } = await load();
    const connection = await ChromeTabConnection.open(7);
    debuggerApi.sendCommand.mockReturnValueOnce(new Promise(() => undefined));
    const pending = connection.send(undefined, 'Page.navigate', { url: 'about:blank' }, 60_000);
    fireDetach(7, 'target_closed');
    await expect(pending).rejects.toMatchObject({ code: 'DEBUGGER_DETACHED' });
    expect(connection.detached).toEqual({ reason: 'target_closed' });
  });

  it('closes once, and a close after a detach does nothing', async () => {
    const { ChromeTabConnection } = await load();
    const connection = await ChromeTabConnection.open(7);
    await connection.close();
    await connection.close();
    expect(connection.detached).toEqual({ reason: 'closed_by_layer' });
    expect(disconnectTab).toHaveBeenCalledTimes(1);
    await expect(ChromeTabConnection.open(7)).resolves.not.toBe(connection);
  });

  it('does not unregister a newer connection of the tab when an older one closes', async () => {
    const { ChromeTabConnection } = await load();
    const older = await ChromeTabConnection.open(7);
    fireDetach(7, 'target_closed');
    const newer = await ChromeTabConnection.open(7);
    await older.close();
    await expect(ChromeTabConnection.open(7)).resolves.toBe(newer);
    expect(connectTab).toHaveBeenCalledTimes(2);
  });
});

describe('releaseLeftoverDebuggerSessions (worker start)', () => {
  it('detaches every attached tab, ignoring targets without a tab and failures', async () => {
    const { releaseLeftoverDebuggerSessions } = await load();
    debuggerApi.getTargets.mockResolvedValue([
      { id: 'a', type: 'page', tabId: 1, attached: true },
      { id: 'b', type: 'page', tabId: 2, attached: false },
      { id: 'c', type: 'worker', attached: true },
      { id: 'd', type: 'page', tabId: 4, attached: true },
    ]);
    // DevTools or another extension holds tab 4: Chrome refuses this extension's detach, which is no failure.
    debuggerApi.detach.mockImplementation(async ({ tabId }: { tabId: number }) => {
      if (tabId === 4) throw new Error('Debugger is not attached to the tab with id: 4.');
    });
    await releaseLeftoverDebuggerSessions();
    expect(debuggerApi.detach.mock.calls.map(c => c[0])).toEqual([{ tabId: 1 }, { tabId: 4 }]);
  });

  it('registers the debugger listeners at once, before anything is awaited', async () => {
    const { releaseLeftoverDebuggerSessions } = await load();
    void releaseLeftoverDebuggerSessions();
    expect(debuggerApi.onEvent.addListener).toHaveBeenCalledTimes(1);
    expect(debuggerApi.onDetach.addListener).toHaveBeenCalledTimes(1);
  });

  it('runs once, and the first attach waits for it', async () => {
    const { releaseLeftoverDebuggerSessions, ChromeTabConnection } = await load();
    const gate = deferred<unknown[]>();
    debuggerApi.getTargets.mockReturnValueOnce(gate.promise);
    const sweep = releaseLeftoverDebuggerSessions();
    const opening = ChromeTabConnection.open(7);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(connectTab).not.toHaveBeenCalled();
    gate.resolve([{ id: 'a', type: 'page', tabId: 7, attached: true }]);
    await Promise.all([sweep, opening]);
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 7 });
    // The sweep's detach came before the attach.
    expect(debuggerApi.detach.mock.invocationCallOrder[0]).toBeLessThan(connectTab.mock.invocationCallOrder[0]);
    await releaseLeftoverDebuggerSessions();
    expect(debuggerApi.getTargets).toHaveBeenCalledTimes(1);
  });

  it('lets an attach go on when the browser cannot list its targets', async () => {
    const { ChromeTabConnection } = await load();
    debuggerApi.getTargets.mockRejectedValue(new Error('boom'));
    await expect(ChromeTabConnection.open(7)).resolves.toBeTruthy();
  });

  it('does nothing without chrome.debugger', async () => {
    vi.stubGlobal('chrome', {});
    const { releaseLeftoverDebuggerSessions } = await load();
    await expect(releaseLeftoverDebuggerSessions()).resolves.toBeUndefined();
    expect(debuggerApi.getTargets).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.stubGlobal('chrome', undefined);
    const again = await load();
    await expect(again.releaseLeftoverDebuggerSessions()).resolves.toBeUndefined();
  });
});

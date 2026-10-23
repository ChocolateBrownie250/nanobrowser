import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Puppeteer's browser build is replaced: the test controls what connect and pages do, and sees the transport closed.
const transport = { close: vi.fn() };
const connectExtension = vi.fn(async (_tabId: number): Promise<typeof transport> => transport);
const browser = { pages: vi.fn(), disconnect: vi.fn() };
const connect = vi.fn();
vi.mock('puppeteer-core/internal/puppeteer-core-browser.js', () => ({
  connect: (...args: unknown[]) => connect(...args),
  ExtensionTransport: { connectTab: (tabId: number) => connectExtension(tabId) },
}));
vi.mock('puppeteer-core/internal/common/USKeyboardLayout.js', () => ({ _keyDefinitions: {} }));

const { connectTab, disconnectTab, PROTOCOL_TIMEOUT_MS } = await import('../puppeteer');

describe('connectTab (a failed attach leaves the debugger detached)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browser.disconnect.mockResolvedValue(undefined);
  });

  it('closes the transport when Puppeteer cannot connect', async () => {
    connect.mockRejectedValue(new Error('Target.setDiscoverTargets timed out'));
    await expect(connectTab(7)).rejects.toThrow('timed out');
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('disconnects the browser when listing its pages fails', async () => {
    connect.mockResolvedValue(browser);
    browser.pages.mockRejectedValue(new Error('Protocol error'));
    await expect(connectTab(7)).rejects.toThrow('Protocol error');
    expect(browser.disconnect).toHaveBeenCalledTimes(1);
    expect(transport.close).not.toHaveBeenCalled();
  });

  it('closes the transport itself when disconnecting fails', async () => {
    connect.mockResolvedValue(browser);
    browser.pages.mockResolvedValue([]);
    browser.disconnect.mockRejectedValue(new Error('already closed'));
    await expect(connectTab(7)).rejects.toThrow('No page target');
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the connection when it succeeds', async () => {
    const page = {};
    connect.mockResolvedValue(browser);
    browser.pages.mockResolvedValue([page]);
    await expect(connectTab(7)).resolves.toMatchObject({ tabId: 7, page });
    expect(browser.disconnect).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
  });
});

describe('connectTab and disconnectTab have a budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    connectExtension.mockImplementation(async () => transport);
    browser.disconnect.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('gives Puppeteer a protocol timeout well under its default of 180 s', async () => {
    connect.mockResolvedValue(browser);
    browser.pages.mockResolvedValue([{}]);
    await connectTab(7);
    expect(PROTOCOL_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ protocolTimeout: PROTOCOL_TIMEOUT_MS, transport }));
  });

  it('gives up on a connect that never answers and closes the transport', async () => {
    connect.mockReturnValue(new Promise(() => undefined));
    const result = expect(connectTab(7, 1000)).rejects.toThrow('did not finish within 1000 ms');
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('disconnects a browser that connected only after the deadline', async () => {
    let finish!: (b: typeof browser) => void;
    connect.mockReturnValue(new Promise(resolve => (finish = resolve)));
    browser.pages.mockResolvedValue([{}]);
    const result = expect(connectTab(7, 1000)).rejects.toThrow('did not finish');
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    finish(browser);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.disconnect).toHaveBeenCalledTimes(1);
  });

  it('gives up on an attach that never answers, and detaches it if it answers later', async () => {
    let finish!: (t: typeof transport) => void;
    connectExtension.mockReturnValue(new Promise(resolve => (finish = resolve)));
    const result = expect(connectTab(7, 1000)).rejects.toThrow('Attaching to tab 7 did not finish');
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(connect).not.toHaveBeenCalled();
    finish(transport);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('closes the transport itself when Puppeteer does not finish disconnecting', async () => {
    browser.disconnect.mockReturnValue(new Promise(() => undefined));
    const result = expect(disconnectTab({ tabId: 7, browser, page: {}, transport } as never, 500)).rejects.toThrow(
      'did not finish within 500 ms',
    );
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('leaves the transport to Puppeteer when it disconnects in time', async () => {
    await disconnectTab({ tabId: 7, browser, page: {}, transport } as never, 500);
    expect(browser.disconnect).toHaveBeenCalledTimes(1);
    expect(transport.close).not.toHaveBeenCalled();
  });
});

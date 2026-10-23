import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The test panel's port can reach raw CDP and the layer's policy setters, so only the test panel page may use it.
type Listener = (port: unknown) => void;

function fakePort(name: string, url: string | undefined, id = 'ext-id') {
  const messages: unknown[] = [];
  let onMessage: ((message: unknown) => void) | undefined;
  return {
    name,
    sender: { id, url },
    disconnect: vi.fn(),
    postMessage: (message: unknown) => void messages.push(message),
    onDisconnect: { addListener: vi.fn() },
    onMessage: { addListener: (fn: (message: unknown) => void) => void (onMessage = fn) },
    messages,
    send: (message: unknown) => onMessage?.(message),
  };
}

describe('test panel port', () => {
  let listener: Listener;

  beforeEach(async () => {
    vi.resetModules();
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        id: 'ext-id',
        getURL: (path: string) => `chrome-extension://ext-id${path}`,
        onConnect: { addListener: (fn: Listener) => void (listener = fn) },
      },
    };
    const rpc = await import('../rpc');
    rpc.register('ping', async () => 'pong');
    await import('../panel-port');
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('serves the test panel page', async () => {
    const port = fakePort('test-panel', 'chrome-extension://ext-id/testpanel.html#tab=3');
    listener(port);
    expect(port.disconnect).not.toHaveBeenCalled();
    port.send({ id: 1, method: 'ping' });
    await vi.waitFor(() => expect(port.messages).toContainEqual({ id: 1, ok: true, result: 'pong' }));
  });

  it.each(['sidepanel.html', 'options.html', 'welcome.html', 'offscreen.html', 'permission.html'])(
    'disconnects a port from %s',
    async page => {
      const port = fakePort('test-panel', `chrome-extension://ext-id/${page}`);
      listener(port);
      expect(port.disconnect).toHaveBeenCalledTimes(1);
      port.send({ id: 1, method: 'ping' });
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(port.messages).toEqual([]);
    },
  );

  it('disconnects a port with no sender url or from another extension', () => {
    const noUrl = fakePort('test-panel', undefined);
    listener(noUrl);
    expect(noUrl.disconnect).toHaveBeenCalled();
    const other = fakePort('test-panel', 'chrome-extension://other/testpanel.html', 'other');
    listener(other);
    expect(other.disconnect).toHaveBeenCalled();
  });

  it('ignores a port with another name', () => {
    const port = fakePort('something-else', 'chrome-extension://ext-id/sidepanel.html');
    listener(port);
    expect(port.disconnect).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// saveText: Stop and a clock end the wait for the download, which is then cancelled.
function fakeDownloads() {
  const listeners = new Set<(delta: unknown) => void>();
  const downloads = {
    download: vi.fn(async () => 7),
    cancel: vi.fn(async () => undefined),
    search: vi.fn(async () => [{ id: 7, state: 'in_progress', filename: '/home/u/Downloads/notes.txt' }]),
    onChanged: {
      addListener: (l: (delta: unknown) => void) => listeners.add(l),
      removeListener: (l: (delta: unknown) => void) => listeners.delete(l),
    },
    onDeterminingFilename: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'me',
      getURL: (p: string) => p,
      getContexts: async () => [{}],
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      sendMessage: vi.fn(async (m: { type: string }) => (m.type === 'blob-url' ? { url: 'blob:x' } : { held: 0 })),
    },
    offscreen: { createDocument: vi.fn(), closeDocument: vi.fn(async () => undefined) },
    downloads,
  });
  return { downloads, listeners };
}

describe('saveText', () => {
  const file = { filename: 'notes.txt', content: 'hello', mimeType: 'text/plain' };

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ends at Stop, cancels the download and removes the listener', async () => {
    const { downloads, listeners } = fakeDownloads();
    const { saveText } = await import('../downloads');
    const stop = new AbortController();
    const saving = saveText(file, true, stop.signal);
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    stop.abort();
    const saved = await saving;
    expect(saved).toMatchObject({ state: 'interrupted', error: 'USER_CANCELED', downloadId: 7 });
    expect(downloads.cancel).toHaveBeenCalledWith(7);
    expect(listeners.size).toBe(0);
  });

  it('ends at Stop while the Save as call is still waiting for the dialog', async () => {
    const { downloads, listeners } = fakeDownloads();
    let finish: (id: number) => void = () => undefined;
    downloads.download.mockImplementation(() => new Promise<number>(resolve => (finish = resolve)));
    const { saveText } = await import('../downloads');
    const stop = new AbortController();
    const saving = saveText(file, true, stop.signal);
    await vi.waitFor(() => expect(downloads.download).toHaveBeenCalled());
    stop.abort();
    expect(await saving).toMatchObject({ state: 'interrupted', error: 'USER_CANCELED' });
    // The dialog answers later: the download it started is cancelled.
    finish(9);
    await vi.waitFor(() => expect(downloads.cancel).toHaveBeenCalledWith(9));
    expect(listeners.size).toBe(0);
  });

  it('gives up after 2 minutes (10 with Save as) and cancels', async () => {
    const { downloads, listeners } = fakeDownloads();
    const { saveText } = await import('../downloads');
    let ended = false;
    const plain = saveText(file).then(saved => ((ended = true), saved));
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await plain).toMatchObject({ state: 'interrupted', error: 'TIMED_OUT' });
    expect(downloads.cancel).toHaveBeenCalledWith(7);
    expect(listeners.size).toBe(0);

    ended = false;
    const dialog = saveText(file, true).then(saved => ((ended = true), saved));
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    expect(await dialog).toMatchObject({ state: 'interrupted', error: 'TIMED_OUT' });
    expect(listeners.size).toBe(0);
  });

  it('still returns a download that completes', async () => {
    const { listeners } = fakeDownloads();
    const { saveText } = await import('../downloads');
    const saving = saveText(file);
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    for (const l of listeners) l({ id: 7, state: { current: 'complete' } });
    expect(await saving).toMatchObject({ state: 'complete', name: 'notes.txt', downloadId: 7 });
  });
});

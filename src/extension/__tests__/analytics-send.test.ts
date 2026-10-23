import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The send path runs inside the serialised chain that counting, the switches and Delete everything also use, so a
// connection that never answers must end as a failed send after the clock.

function fakeLocal() {
  const data: Record<string, unknown> = {};
  const area = {
    get: vi.fn(async (keys: string[] | string | null) => {
      if (keys === null) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : keys;
      return structuredClone(Object.fromEntries(list.filter(k => k in data).map(k => [k, data[k]])));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, structuredClone(items));
    }),
    remove: vi.fn(async (keys: string[] | string) => {
      for (const k of typeof keys === 'string' ? [keys] : keys) delete data[k];
    }),
    onChanged: { addListener: () => undefined },
  };
  vi.stubGlobal('chrome', { storage: { local: area }, runtime: { getManifest: () => ({ version: '0.3.0' }) } });
  vi.stubGlobal('navigator', { language: 'en-US' });
  return { data, area };
}

/** A fetch that never answers and, like the real one, rejects when it is aborted. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );
}

describe('analytics sending with a stalled connection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubEnv('WXT_AUTORUN_URL', 'http://fixtures.test');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('ends a send after the clock, keeps the queue and lets later work through', async () => {
    const { data } = fakeLocal();
    const fetchStub = hangingFetch();
    vi.stubGlobal('fetch', fetchStub);
    const analytics = await import('../analytics');
    // Two past days of counts are due, besides today's ping: three events, but only the first may wait for the clock.
    data['nb.analytics.counts'] = { '2020-01-01': { 'runs.ended.done': 1 }, '2020-01-02': { 'runs.ended.done': 2 } };
    const sent = analytics.sendDue('run', new Date('2020-01-03T10:00:00Z'));
    let finished = false;
    void sent.then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await sent;
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const queue = data['nb.analytics.queue'] as Array<{ tries: number }>;
    expect(queue).toHaveLength(3);
    expect(queue.map(q => q.tries)).toEqual([1, 0, 0]);

    // The chain is free again: a count and Delete everything are not stuck behind the dead send.
    await analytics.count('runs.ended.done');
    await analytics.deleteKeepingChoices(async () => undefined);
    expect(data['nb.analytics.queue']).toBeUndefined();
  });
});

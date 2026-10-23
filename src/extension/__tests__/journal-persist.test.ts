import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Journal, MAX_STORED_BYTES, MAX_TOTAL_BYTES, newestWithin, slimEvent } from '../journal';
import type { PanelEvent } from '@src/ui/protocol';

/** chrome.storage.session as a plain map; `fail` makes every write throw, as a full area does. */
function fakeSession(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = structuredClone(initial);
  const state = { fail: false, delayGet: 0 };
  const area = {
    get: vi.fn(async (keys: string | string[] | null) => {
      if (state.delayGet) await new Promise(r => setTimeout(r, state.delayGet));
      if (keys === null) return structuredClone(store);
      const list = typeof keys === 'string' ? [keys] : keys;
      return structuredClone(Object.fromEntries(list.filter(k => k in store).map(k => [k, store[k]])));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      if (state.fail) throw new Error('QUOTA_BYTES quota exceeded');
      Object.assign(store, structuredClone(items));
    }),
    remove: vi.fn(async (key: string) => void delete store[key]),
  };
  vi.stubGlobal('chrome', { storage: { session: area } });
  return { store, state, area };
}

const toolEnd = (i: number, size: number) =>
  ({
    type: 'tool_execution_end',
    messageId: 'm',
    row: {
      toolCallId: `t${i}`,
      tool: 'snapshot',
      args: { tabId: 1 },
      status: 'done',
      text: 'x'.repeat(size),
      result: { ok: true, data: 'y'.repeat(size) },
      thumbnail: 'data:image/png;base64,' + 'z'.repeat(size),
    },
  }) as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Journal after a worker restart', () => {
  const stored = (seq: number) => ({
    seq,
    events: Array.from({ length: 5 }, (_, i) => ({
      type: 'turn_start',
      turn: i,
      seq: seq - 4 + i,
      conversationId: 'c1',
    })),
  });

  it('numbers an event emitted before the stored window loaded after that window, and replays it', async () => {
    fakeSession({ 'nb.journal.c1': stored(105) });
    const journal = new Journal();
    const live: PanelEvent[] = [];
    journal.subscribe('c1', e => live.push(e));
    // RunManager.restore() emits right at worker start, before anything has loaded.
    journal.emit('c1', { type: 'run_status', status: 'interrupted', reason: 'The extension restarted.' });
    expect(live).toEqual([]);
    await journal.ready('c1');
    expect(live.map(e => [e.type, e.seq])).toEqual([['run_status', 106]]);
    // The panel reconnects with the last seq it saw and gets the status it missed.
    const missed = journal.since('c1', 105);
    expect(missed?.map(e => [e.type, e.seq])).toEqual([['run_status', 106]]);
    expect(journal.currentSeq('c1')).toBe(106);
  });

  it('keeps the order of events emitted while loading and after', async () => {
    fakeSession({ 'nb.journal.c1': stored(10) });
    const journal = new Journal();
    const live: PanelEvent[] = [];
    journal.subscribe('c1', e => live.push(e));
    journal.emit('c1', { type: 'turn_start', turn: 1 });
    journal.emit('c1', { type: 'turn_start', turn: 2 });
    await journal.ready('c1');
    journal.emit('c1', { type: 'turn_start', turn: 3 });
    expect(live.map(e => e.seq)).toEqual([11, 12, 13]);
  });
});

describe('Journal storage use', () => {
  it('drops bulky fields from the stored copy but not from memory', () => {
    const event = { ...toolEnd(1, 30_000), seq: 1, conversationId: 'c' } as PanelEvent;
    const slim = slimEvent(event) as Extract<PanelEvent, { type: 'tool_execution_end' }>;
    expect(slim.row).toEqual({ toolCallId: 't1', tool: 'snapshot', args: { tabId: 1 }, status: 'done' });
    expect(JSON.stringify(slim).length).toBeLessThan(400);
    const big = slimEvent({
      ...event,
      row: { ...(event as never as { row: object }).row, args: { content: 'q'.repeat(5000) } },
    } as PanelEvent);
    expect((big as typeof slim).row.args).toEqual({});
  });

  it('keeps the newest events that fit', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ type: 'turn_start', turn: i, seq: i + 1 }) as PanelEvent);
    const one = JSON.stringify(events[0]).length + 1;
    expect(newestWithin(events, one * 3 + 2).map(e => e.seq)).toEqual([8, 9, 10]);
    expect(newestWithin(events, 5)).toEqual([]);
  });

  it('stores 300 events of 30 KB under the cap, newest first kept', async () => {
    const { store } = fakeSession();
    const journal = new Journal();
    for (let i = 0; i < 300; i++) journal.emit('c1', toolEnd(i, 30_000));
    await vi.advanceTimersByTimeAsync(300);
    const value = store['nb.journal.c1'] as { seq: number; events: PanelEvent[] };
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(MAX_STORED_BYTES + 100);
    expect(value.seq).toBe(300);
    // The full rows stay in memory for a live replay.
    expect(journal.since('c1', 299)).toHaveLength(1);
    const last = value.events.at(-1) as Extract<PanelEvent, { type: 'tool_execution_end' }>;
    expect(last.seq).toBe(300);
    expect(last.row.text).toBeUndefined();
    // Large-event case: a window of oversized message events is trimmed by bytes, oldest first.
    for (let i = 0; i < 40; i++)
      journal.emit('c2', {
        type: 'message_end',
        entry: { kind: 'user', id: `u${i}`, text: 'w'.repeat(20_000), at: 'now' },
      });
    await vi.advanceTimersByTimeAsync(300);
    const c2 = store['nb.journal.c2'] as { seq: number; events: PanelEvent[] };
    expect(JSON.stringify(c2).length).toBeLessThanOrEqual(MAX_STORED_BYTES + 100);
    expect(c2.events.length).toBeLessThan(40);
    expect(c2.events.at(-1)?.seq).toBe(40);
  });

  it('drops the stored windows of idle conversations when all of them pass the budget', async () => {
    const filler = (seq: number) => ({ seq, events: [{ type: 'notice-filler', seq, pad: 'p'.repeat(1_000_000) }] });
    // Four earlier windows of about 1 MB each, left by an earlier worker.
    const { store, area } = fakeSession({
      'nb.journal.old1': filler(1),
      'nb.journal.old2': filler(2),
      'nb.journal.old3': filler(3),
      'nb.journal.old4': filler(4),
      'nb.live.keep': { model: 'x' },
    });
    const journal = new Journal();
    // old4 has a panel on it, so it stays whatever the budget says.
    journal.subscribe('old4', () => undefined);
    // 4 MB of old windows plus a small new one is under the 4 MiB budget: nothing goes.
    journal.emit('c1', { type: 'message_end', entry: { kind: 'user', id: 'u', text: 'a'.repeat(50_000), at: 'now' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(
      Object.keys(store)
        .filter(k => k.startsWith('nb.journal.'))
        .sort(),
    ).toEqual(['nb.journal.c1', 'nb.journal.old1', 'nb.journal.old2', 'nb.journal.old3', 'nb.journal.old4']);
    // A second conversation tips it over: the idle old windows go, oldest first, until it fits.
    journal.emit('c2', { type: 'message_end', entry: { kind: 'user', id: 'u', text: 'b'.repeat(200_000), at: 'now' } });
    await vi.advanceTimersByTimeAsync(300);
    const left = Object.keys(store)
      .filter(k => k.startsWith('nb.journal.'))
      .sort();
    expect(left).toContain('nb.journal.c2');
    expect(left).toContain('nb.journal.old4');
    expect(left).not.toContain('nb.journal.old1');
    expect(area.remove).toHaveBeenCalledWith('nb.journal.old1');
    // Only journals are evicted.
    expect(store['nb.live.keep']).toEqual({ model: 'x' });
    const total = Object.entries(store)
      .filter(([k]) => k.startsWith('nb.journal.'))
      .reduce((n, [, v]) => n + JSON.stringify(v).length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });

  it('survives a full storage area: emit and later writes do not throw', async () => {
    const { state, store } = fakeSession();
    state.fail = true;
    const journal = new Journal();
    const seen: PanelEvent[] = [];
    journal.subscribe('c1', e => seen.push(e));
    journal.emit('c1', { type: 'turn_start', turn: 1 });
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toHaveLength(1);
    expect(store['nb.journal.c1']).toBeUndefined();
    state.fail = false;
    journal.emit('c1', { type: 'turn_start', turn: 2 });
    await vi.advanceTimersByTimeAsync(300);
    expect((store['nb.journal.c1'] as { seq: number }).seq).toBe(2);
  });
});

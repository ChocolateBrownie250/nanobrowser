import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  activeBranch,
  appendEntry,
  branchFrom,
  closeDb,
  createConversation,
  deleteBlob,
  deleteConversation,
  getBlob,
  getConversation,
  getEntries,
  getRun,
  listConversations,
  listRuns,
  putBlob,
  putRun,
  setLeaf,
  sweepOrphanBlobs,
  titleFrom,
  updateConversation,
} from '../index';
import { EMPTY_GUARDS, ZERO_USAGE } from '../types';
import type { StoredBlob, StoredMessage } from '../types';

const user = (text: string): StoredMessage => ({ role: 'user', parts: [{ type: 'text', text }] });

afterEach(async () => {
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
});

describe('conversations', () => {
  it('appends entries as a tree and reads the active branch', async () => {
    const c = await createConversation({ mode: 'ask' });
    const a = await appendEntry(c.id, { type: 'message', message: user('first') });
    const b = await appendEntry(c.id, {
      type: 'message',
      message: { role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
    });
    expect(b.parentId).toBe(a.id);
    expect((await activeBranch(c.id)).map(e => e.id)).toEqual([a.id, b.id]);

    // Editing the first message starts a new branch from its parent; the old branch stays in the store.
    const edited = await appendEntry(c.id, { type: 'message', message: user('first, edited') }, { parentId: null });
    expect((await activeBranch(c.id)).map(e => e.id)).toEqual([edited.id]);
    expect(await getEntries(c.id)).toHaveLength(3);
    await setLeaf(c.id, b.id);
    expect((await activeBranch(c.id)).map(e => e.id)).toEqual([a.id, b.id]);
  });

  it('keeps every entry type', async () => {
    const c = await createConversation({ mode: 'auto' });
    await appendEntry(c.id, { type: 'intent', toolCallId: 't1', tool: 'click', args: { target: { ref: 'e1' } } });
    await appendEntry(c.id, { type: 'ui', kind: 'notice', data: { text: 'x' } });
    await appendEntry(c.id, { type: 'context_edit', targetId: 'x', replacement: '[elided]' });
    await appendEntry(c.id, {
      type: 'compaction',
      ledger: [{ turn: 1, kind: 'action', text: 'click' }],
      summary: null,
      firstKeptId: 'x',
      tokensBefore: 10,
      tokensAfter: 5,
    });
    await appendEntry(c.id, { type: 'model_change', model: { providerId: 'p', model: 'n' } });
    await appendEntry(c.id, { type: 'mode_change', mode: 'ask' });
    expect((await activeBranch(c.id)).map(e => e.type)).toEqual([
      'intent',
      'ui',
      'context_edit',
      'compaction',
      'model_change',
      'mode_change',
    ]);
  });

  it('lists newest first, searches titles, renames and deletes everything of a conversation', async () => {
    const old = await createConversation({ mode: 'ask', title: 'Compare laptops' });
    await new Promise(r => setTimeout(r, 5));
    const recent = await createConversation({ mode: 'ask', title: 'Book a table' });
    expect((await listConversations()).map(c => c.id)).toEqual([recent.id, old.id]);
    expect((await listConversations('LAPTOP')).map(c => c.id)).toEqual([old.id]);

    await updateConversation(old.id, { title: 'Laptops', titleByUser: true });
    expect((await getConversation(old.id))?.title).toBe('Laptops');

    await appendEntry(old.id, { type: 'message', message: user('hi') });
    await putBlob({
      id: 'b1',
      conversationId: old.id,
      name: 'a.txt',
      mimeType: 'text/plain',
      size: 1,
      data: new Blob(['a']),
      createdAt: '',
    });
    await putRun({
      conversationId: old.id,
      runId: 'r1',
      leafEntryId: null,
      status: 'done',
      steering: [],
      turns: 1,
      usage: ZERO_USAGE,
      debt: [],
      guards: EMPTY_GUARDS,
      tabs: [],
      startedAt: '',
      updatedAt: '',
    });
    expect(await getRun(old.id)).toBeDefined();
    await deleteConversation(old.id);
    expect(await getConversation(old.id)).toBeUndefined();
    expect(await getEntries(old.id)).toEqual([]);
    expect(await listRuns()).toEqual([]);
  });

  it('refuses an entry for a conversation that does not exist', async () => {
    await expect(appendEntry('nope', { type: 'mode_change', mode: 'ask' })).rejects.toThrow(/does not exist/);
  });
});

const blob = (id: string, conversationId: string, createdAt: string): StoredBlob => ({
  id,
  conversationId,
  name: `${id}.txt`,
  mimeType: 'text/plain',
  size: 1,
  data: new Blob(['x']),
  createdAt,
});
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

describe('stored files', () => {
  it('deleteBlob removes the row', async () => {
    await putBlob(blob('a', '', ago(0)));
    await putBlob(blob('b', '', ago(0)));
    await deleteBlob('a');
    expect(await getBlob('a')).toBeUndefined();
    expect(await getBlob('b')).toBeDefined();
    // Removing a file that is not there is not an error.
    await expect(deleteBlob('a')).resolves.toBeUndefined();
  });

  it('the sweep removes old unowned files and keeps fresh ones and those of a conversation', async () => {
    const c = await createConversation({ mode: 'ask' });
    await putBlob(blob('old', '', ago(2 * DAY)));
    await putBlob(blob('old2', '', ago(3 * DAY)));
    await putBlob(blob('fresh', '', ago(60_000)));
    await putBlob(blob('owned', c.id, ago(10 * DAY)));
    expect(await sweepOrphanBlobs(DAY)).toBe(2);
    expect(await getBlob('old')).toBeUndefined();
    expect(await getBlob('old2')).toBeUndefined();
    expect(await getBlob('fresh')).toBeDefined();
    expect(await getBlob('owned')).toBeDefined();
    expect(await sweepOrphanBlobs(DAY)).toBe(0);
  });
});

describe('activeBranch', () => {
  it('equals walking the whole entry list, for every leaf of a branched conversation', async () => {
    const c = await createConversation({ mode: 'ask' });
    const other = await createConversation({ mode: 'ask' });
    const a = await appendEntry(c.id, { type: 'message', message: user('a') });
    const b = await appendEntry(c.id, { type: 'message', message: user('b') });
    const c1 = await appendEntry(c.id, { type: 'message', message: user('c1') });
    const d = await appendEntry(c.id, { type: 'message', message: user('d') }, { parentId: b.id });
    const e = await appendEntry(c.id, { type: 'message', message: user('e') });
    const root2 = await appendEntry(c.id, { type: 'message', message: user('r2') }, { parentId: null });
    const f = await appendEntry(c.id, { type: 'message', message: user('f') });
    // An entry whose parent was never stored, and an entry of another conversation under the same id space.
    const orphan = await appendEntry(
      c.id,
      { type: 'message', message: user('o') },
      { parentId: 'ghost', keepLeaf: true },
    );
    const foreign = await appendEntry(other.id, { type: 'message', message: user('x') });
    await setLeaf(c.id, e.id);

    const all = await getEntries(c.id);
    const leaves: Array<string | null | undefined> = [
      undefined,
      null,
      'unknown',
      ...[a, b, c1, d, e, root2, f, orphan, foreign].map(x => x.id),
    ];
    for (const leaf of leaves) {
      const expected = branchFrom(all, leaf === undefined ? e.id : leaf);
      expect((await activeBranch(c.id, leaf)).map(x => x.id)).toEqual(expected.map(x => x.id));
    }
    expect((await activeBranch(c.id)).map(x => x.id)).toEqual([a.id, b.id, d.id, e.id]);
    expect((await activeBranch(c.id, orphan.id)).map(x => x.id)).toEqual([orphan.id]);
    expect(await activeBranch(c.id, foreign.id)).toEqual([]);
    expect(await activeBranch('nope')).toEqual([]);
  });

  it('reads only the entries of the path', async () => {
    const c = await createConversation({ mode: 'ask' });
    const root = await appendEntry(c.id, { type: 'message', message: user('root') });
    for (let i = 0; i < 20; i++)
      await appendEntry(c.id, { type: 'message', message: user(`dead ${i}`) }, { parentId: root.id, keepLeaf: true });
    const leaf = await appendEntry(c.id, { type: 'message', message: user('live') }, { parentId: root.id });
    const gets = vi.spyOn(IDBObjectStore.prototype, 'get');
    const getAll = vi.spyOn(IDBIndex.prototype, 'getAll');
    try {
      expect((await activeBranch(c.id)).map(x => x.id)).toEqual([root.id, leaf.id]);
      // The conversation, then one read per entry on the path; no read of the whole conversation.
      expect(gets).toHaveBeenCalledTimes(3);
      expect(getAll).not.toHaveBeenCalled();
    } finally {
      gets.mockRestore();
      getAll.mockRestore();
    }
  });
});

describe('titleFrom', () => {
  it('takes the start of the first message on one line', () => {
    expect(titleFrom('  Compare\nthe   laptops ')).toBe('Compare the laptops');
    const long = titleFrom('x'.repeat(100));
    expect(long).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
  });

  it('never cuts an emoji in half', () => {
    const title = titleFrom(`${'a'.repeat(58)}😀 and more words after it`);
    expect(title).toBe(`${'a'.repeat(58)}…`);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(title)).toBe(false);
  });
});

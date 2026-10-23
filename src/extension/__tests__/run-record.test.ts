import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RunWriter } from '@src/agent/records';
import { createConversation, getRun } from '@src/store/conversations';
import { closeDb } from '@src/store/db';
import { EMPTY_GUARDS, ZERO_USAGE } from '@src/store/types';
import type { RunRecord } from '@src/store/types';
import { beginRunRecord, patchRunRecord } from '../run-record';

const at = '2026-01-01T00:00:00.000Z';

function record(conversationId: string, patch: Partial<RunRecord> = {}): RunRecord {
  return {
    conversationId,
    runId: 'r1',
    leafEntryId: null,
    status: 'running',
    steering: [],
    turns: 0,
    usage: ZERO_USAGE,
    debt: [],
    guards: EMPTY_GUARDS,
    tabs: [],
    startedAt: at,
    updatedAt: at,
    ...patch,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
afterEach(async () => {
  await closeDb();
});

describe('the run record writer', () => {
  it('a status change after the loop wrote its progress keeps pendingPrompt, steering, turns and debt', async () => {
    const c = await createConversation({ mode: 'ask' });
    await beginRunRecord(record(c.id));
    const writer = new RunWriter(c.id, 'r1');
    // The loop's writes (loop.ts), then the queue's, then the status change a card opening causes.
    await writer.run({ turns: 4, debt: [{ toolCallId: 'x' } as never] });
    await writer.run({
      pendingPrompt: {
        kind: 'handover',
        request: { tabId: 1 },
        openedAt: at,
        answers: { toolCallId: 'f', partialResult: {} },
      },
    });
    await patchRunRecord(c.id, null, { steering: [{ id: 'q', text: 'queued', attachments: [], at }] });
    await patchRunRecord(c.id, 'r1', { status: 'awaiting_user', reason: undefined });
    const stored = (await getRun(c.id))!;
    expect(stored.status).toBe('awaiting_user');
    expect(stored.pendingPrompt?.kind).toBe('handover');
    expect(stored.steering.map(q => q.text)).toEqual(['queued']);
    expect(stored.turns).toBe(4);
    expect(stored.debt).toHaveLength(1);
  });

  it('patches started together all land, in order', async () => {
    const c = await createConversation({ mode: 'ask' });
    await beginRunRecord(record(c.id));
    await Promise.all([
      patchRunRecord(c.id, 'r1', { turns: 1 }),
      patchRunRecord(c.id, 'r1', { reason: 'a' }),
      patchRunRecord(c.id, 'r1', stored => ({ turns: stored.turns + 1 })),
      patchRunRecord(c.id, 'r1', { tabs: [3] }),
      patchRunRecord(c.id, 'r1', stored => ({ turns: stored.turns + 10 })),
    ]);
    expect(await getRun(c.id)).toMatchObject({ turns: 12, reason: 'a', tabs: [3] });
  });

  it('a patch of a run that ended does not touch the run after it, and a missing row stays missing', async () => {
    const c = await createConversation({ mode: 'ask' });
    await beginRunRecord(record(c.id, { runId: 'old' }));
    await beginRunRecord(record(c.id, { runId: 'new', turns: 7 }));
    const result = await patchRunRecord(c.id, 'old', { status: 'failed', turns: 0 });
    expect(result?.runId).toBe('new');
    expect(await getRun(c.id)).toMatchObject({ runId: 'new', status: 'running', turns: 7 });
    expect(await patchRunRecord('gone', null, { turns: 1 })).toBeUndefined();
    expect(await getRun('gone')).toBeUndefined();
  });

  it('a function patch that returns null writes nothing, and a failed one does not block the next', async () => {
    const c = await createConversation({ mode: 'ask' });
    await beginRunRecord(record(c.id));
    const before = (await getRun(c.id))!.updatedAt;
    await patchRunRecord(c.id, 'r1', () => null);
    expect((await getRun(c.id))!.updatedAt).toBe(before);
    await expect(
      patchRunRecord(c.id, 'r1', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await patchRunRecord(c.id, 'r1', { turns: 2 });
    expect((await getRun(c.id))!.turns).toBe(2);
  });
});

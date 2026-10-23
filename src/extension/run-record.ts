// The worker's writes to a run's stored record. The record is one row per conversation with several writers (the run
// manager's status changes, the card a run waits on, the queue, and the loop's own progress), so a writer never puts
// back a copy it read earlier: it states a patch, and the patch is merged into the row as stored, in one IndexedDB
// transaction, one after another per conversation. Only a run's first write replaces the row.
import { db } from '@src/store/db';
import type { RunRecord } from '@src/store/types';

/** What a patch may be: fields to set, or a function of the stored row that says them (null: write nothing). */
export type RunPatch = Partial<RunRecord> | ((stored: RunRecord) => Partial<RunRecord> | null);

const chains = new Map<string, Promise<unknown>>();

/** Runs the work after the earlier writes of the same conversation, whether or not they failed. */
function inOrder<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
  const next = (chains.get(conversationId) ?? Promise.resolve()).then(work, work);
  const tail = next.catch(() => undefined);
  chains.set(conversationId, tail);
  void tail.then(() => {
    if (chains.get(conversationId) === tail) chains.delete(conversationId);
  });
  return next;
}

/** A new run's record replaces the row of the run before it. */
export function beginRunRecord(record: RunRecord): Promise<void> {
  return inOrder(record.conversationId, async () => {
    await (await db()).put('runs', { ...record, updatedAt: new Date().toISOString() });
  });
}

/**
 * Merges a patch into the stored record of run `runId` (any run when `runId` is null) and returns the result. A row
 * that is gone, or belongs to another run, is left alone: a run that ended cannot write over the one that followed it.
 */
export function patchRunRecord(
  conversationId: string,
  runId: string | null,
  patch: RunPatch,
): Promise<RunRecord | undefined> {
  return inOrder(conversationId, async () => {
    const tx = (await db()).transaction('runs', 'readwrite');
    const stored = await tx.store.get(conversationId);
    if (!stored || (runId !== null && stored.runId !== runId)) {
      await tx.done;
      return stored;
    }
    const fields = typeof patch === 'function' ? patch(stored) : patch;
    if (!fields) {
      await tx.done;
      return stored;
    }
    const next: RunRecord = { ...stored, ...fields, updatedAt: new Date().toISOString() };
    await tx.store.put(next);
    await tx.done;
    return next;
  });
}

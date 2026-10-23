// The worker's writes to a run's stored record. The record is one row per conversation with several writers (the run
// manager's status changes, the card a run waits on, the queue, and the loop's own progress), so a writer never puts
// back a copy it read earlier: it states a patch, and the patch is merged into the row as stored, in one IndexedDB
// transaction, one after another per conversation (the store does that; the loop's writer uses the same path). Only a
// run's first write replaces the row.
import { beginRun, patchRun } from '@src/store/conversations';
import type { RunPatch } from '@src/store/conversations';
import type { RunRecord } from '@src/store/types';

export type { RunPatch };

/** A new run's record replaces the row of the run before it. */
export function beginRunRecord(record: RunRecord): Promise<void> {
  return beginRun(record);
}

/**
 * Merges a patch into the stored record of run `runId` (any run when `runId` is null) and returns the result. A row
 * that is gone, or belongs to another run, is left alone.
 */
export function patchRunRecord(
  conversationId: string,
  runId: string | null,
  patch: RunPatch,
): Promise<RunRecord | undefined> {
  return patchRun(conversationId, runId, patch);
}

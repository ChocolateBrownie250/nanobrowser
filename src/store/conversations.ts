// Conversations as append-only entry trees. The active branch is the path from the root to the conversation's leaf.
// Each write is awaited until its transaction completes, so an entry the caller was told about is on disk (the intent
// record before a mutation relies on this).
import { db } from './db';
import type { Conversation, Entry, EntryBody, PermissionMode, RunRecord, StoredBlob } from './types';

export const TITLE_LENGTH = 60;

function now(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

/** A title from the user's first message: its start, on one line. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= TITLE_LENGTH) return line;
  // The cut never falls between the two halves of a surrogate pair (an emoji at the cut would leave a lone half).
  let end = TITLE_LENGTH - 1;
  const before = line.charCodeAt(end - 1);
  if (before >= 0xd800 && before <= 0xdbff) end--;
  return `${line.slice(0, end).trimEnd()}…`;
}

/**
 * A record without the model field that older versions stored (the model now lives with the live conversation):
 * writes spread the stored record, so the field is dropped on the next write.
 */
function current(record: Conversation): Conversation {
  if (!('model' in record)) return record;
  const copy = { ...record } as Conversation & { model?: unknown };
  delete copy.model;
  return copy;
}

export async function createConversation(init: {
  mode: PermissionMode;
  title?: string;
  tabs?: number[];
}): Promise<Conversation> {
  const at = now();
  const conversation: Conversation = {
    id: newId(),
    title: init.title ?? '',
    createdAt: at,
    updatedAt: at,
    leafId: null,
    mode: init.mode,
    tabs: init.tabs ?? [],
    status: 'idle',
  };
  await (await db()).put('conversations', conversation);
  return conversation;
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  return (await db()).get('conversations', id);
}

/** Newest first. A query matches the title, case-insensitively. */
export async function listConversations(query?: string): Promise<Conversation[]> {
  const all = await (await db()).getAllFromIndex('conversations', 'updatedAt');
  const q = query?.trim().toLowerCase();
  return all.reverse().filter(c => !q || c.title.toLowerCase().includes(q));
}

export async function updateConversation(
  id: string,
  patch: Partial<Omit<Conversation, 'id' | 'createdAt'>>,
): Promise<Conversation | undefined> {
  const database = await db();
  const tx = database.transaction('conversations', 'readwrite');
  const stored = await tx.store.get(id);
  if (!stored) {
    await tx.done;
    return undefined;
  }
  const next = { ...current(stored), ...patch, updatedAt: patch.updatedAt ?? now() };
  await tx.store.put(next);
  await tx.done;
  return next;
}

/** Deletes a conversation with its entries, attachments and run record. */
export async function deleteConversation(id: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(['conversations', 'entries', 'blobs', 'runs'], 'readwrite');
  await tx.objectStore('conversations').delete(id);
  for (const store of ['entries', 'blobs'] as const) {
    const keys = await tx.objectStore(store).index('conversationId').getAllKeys(id);
    for (const key of keys) await tx.objectStore(store).delete(key);
  }
  await tx.objectStore('runs').delete(id);
  await tx.done;
}

/**
 * Appends an entry under `parentId` (default: the current leaf) and makes it the leaf, in one transaction.
 * Resolves once the transaction is complete.
 */
export async function appendEntry<T extends EntryBody>(
  conversationId: string,
  body: T,
  options: { parentId?: string | null; keepLeaf?: boolean; id?: string } = {},
): Promise<Entry & T> {
  const database = await db();
  const tx = database.transaction(['conversations', 'entries'], 'readwrite');
  const conversations = tx.objectStore('conversations');
  const conversation = await conversations.get(conversationId);
  if (!conversation) {
    await tx.done;
    throw new Error(`Conversation ${conversationId} does not exist`);
  }
  const entry = {
    ...body,
    id: options.id ?? newId(),
    parentId: options.parentId !== undefined ? options.parentId : conversation.leafId,
    conversationId,
    at: now(),
  } as Entry & T;
  await tx.objectStore('entries').put(entry);
  if (!options.keepLeaf) await conversations.put({ ...current(conversation), leafId: entry.id, updatedAt: entry.at });
  await tx.done;
  return entry;
}

/** Replaces an entry in place (used for entries that are updated as they complete, never for messages sent). */
export async function putEntry(entry: Entry): Promise<void> {
  await (await db()).put('entries', entry);
}

export async function getEntries(conversationId: string): Promise<Entry[]> {
  return (await db()).getAllFromIndex('entries', 'conversationId', conversationId);
}

/**
 * The path from the root to `leafId` (default: the conversation's leaf), oldest first. It follows `parentId` from the
 * leaf in one read-only transaction, so only the entries of the path are read (the other branches, with their inline
 * images, stay on disk). Like `branchFrom`, it stops at an entry that is missing or belongs to another conversation.
 */
export async function activeBranch(conversationId: string, leafId?: string | null): Promise<Entry[]> {
  const tx = (await db()).transaction(['conversations', 'entries'], 'readonly');
  const entries = tx.objectStore('entries');
  let id =
    leafId !== undefined ? leafId : ((await tx.objectStore('conversations').get(conversationId))?.leafId ?? null);
  const path: Entry[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const entry = await entries.get(id);
    if (!entry || entry.conversationId !== conversationId) break;
    path.push(entry);
    id = entry.parentId;
  }
  await tx.done;
  return path.reverse();
}

export function branchFrom(entries: Entry[], leafId: string | null): Entry[] {
  const byId = new Map(entries.map(e => [e.id, e]));
  const path: Entry[] = [];
  let id = leafId;
  while (id) {
    const entry = byId.get(id);
    if (!entry) break;
    path.push(entry);
    id = entry.parentId;
  }
  return path.reverse();
}

export async function setLeaf(conversationId: string, leafId: string | null): Promise<void> {
  await updateConversation(conversationId, { leafId });
}

export async function getRun(conversationId: string): Promise<RunRecord | undefined> {
  return (await db()).get('runs', conversationId);
}

export async function putRun(run: RunRecord): Promise<void> {
  await (await db()).put('runs', { ...run, updatedAt: now() });
}

/** What a patch of a run record may be: fields to set, or a function of the stored row that says them (null: nothing). */
export type RunPatch = Partial<RunRecord> | ((stored: RunRecord) => Partial<RunRecord> | null);

// A run's record is one row per conversation with several writers (the run manager, the card a run waits on, the
// queue, the loop). Their writes run one after another per conversation, each as a single transaction, so a writer
// never puts back a copy it read earlier.
const runChains = new Map<string, Promise<unknown>>();

/** Runs the work after the earlier writes of the same conversation, whether or not they failed. */
function inRunOrder<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
  const next = (runChains.get(conversationId) ?? Promise.resolve()).then(work, work);
  const tail = next.catch(() => undefined);
  runChains.set(conversationId, tail);
  void tail.then(() => {
    if (runChains.get(conversationId) === tail) runChains.delete(conversationId);
  });
  return next;
}

/** A new run's record replaces the row of the run before it. */
export function beginRun(record: RunRecord): Promise<void> {
  return inRunOrder(record.conversationId, async () => {
    await (await db()).put('runs', { ...record, updatedAt: now() });
  });
}

/**
 * Merges a patch into the stored record of run `runId` (any run when `runId` is null) and returns the result. A row
 * that is gone, or belongs to another run, is left alone: a run that ended cannot write over the one that followed it.
 */
export function patchRun(
  conversationId: string,
  runId: string | null,
  patch: RunPatch,
): Promise<RunRecord | undefined> {
  return inRunOrder(conversationId, async () => {
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
    const next: RunRecord = { ...stored, ...fields, updatedAt: now() };
    await tx.store.put(next);
    await tx.done;
    return next;
  });
}

export async function listRuns(): Promise<RunRecord[]> {
  return (await db()).getAll('runs');
}

export async function putBlob(blob: StoredBlob): Promise<void> {
  await (await db()).put('blobs', blob);
}

export async function getBlob(id: string): Promise<StoredBlob | undefined> {
  return (await db()).get('blobs', id);
}

/** Removes one stored file (one the user took out of the composer, or one the worker refused). */
export async function deleteBlob(id: string): Promise<void> {
  await (await db()).delete('blobs', id);
}

/**
 * Removes the files that never reached a conversation (conversationId '') and were added more than `maxAgeMs` ago:
 * files left in the composer when the panel closed, and ones a send did not take. Returns how many were removed.
 */
export async function sweepOrphanBlobs(maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const tx = (await db()).transaction('blobs', 'readwrite');
  let removed = 0;
  let cursor = await tx.store.index('conversationId').openCursor('');
  while (cursor) {
    if (cursor.value.createdAt < cutoff) {
      await cursor.delete();
      removed += 1;
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return removed;
}

export async function listBlobs(conversationId: string): Promise<StoredBlob[]> {
  return (await db()).getAllFromIndex('blobs', 'conversationId', conversationId);
}

export async function deleteEverything(): Promise<void> {
  const database = await db();
  const names = ['conversations', 'entries', 'runs', 'blobs'] as const;
  const tx = database.transaction([...names], 'readwrite');
  await Promise.all(names.map(name => tx.objectStore(name).clear()));
  await tx.done;
}

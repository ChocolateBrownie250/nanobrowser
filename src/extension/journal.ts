// The panel journal. Every event for a conversation gets the next sequence number and goes to the panels subscribed to
// it. A bounded window of recent events (without the streaming text updates) is kept in storage.session, so a panel
// that reconnects with `sinceSeq` gets what it missed; the reply streaming now is kept apart and sent whole. Text
// updates are coalesced to about 50 ms.
//
// storage.session holds 10 MB for the whole extension, and the tab scope and the live model pairs live there too, so
// the stored copy is bounded in bytes: bulky fields are left out of it, the oldest events go first, and the journals of
// idle conversations are dropped when all of them together pass a budget. The copy in memory is not touched.
import type { PanelEvent, PanelEventBody } from '@src/ui/protocol';

const WINDOW = 300;
const COALESCE_MS = 50;
const PERSIST_MS = 250;
/** The most one conversation's stored window may take (characters of its JSON). */
export const MAX_STORED_BYTES = 256 * 1024;
/** The most all stored windows may take together; past it, idle conversations' windows are dropped. */
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
/** A tool call's arguments kept in the stored copy; a longer one (a file to save, a long form) is left out. */
const MAX_STORED_ARGS = 2_000;
const PREFIX = 'nb.journal.';

interface ConversationJournal {
  seq: number;
  events: PanelEvent[];
  streaming?: { id: string; text: string };
  pendingUpdate?: ReturnType<typeof setTimeout>;
  persistTimer?: ReturnType<typeof setTimeout>;
  loaded: Promise<void>;
  /** False until the stored window is merged: events emitted before that wait, so they are numbered after it. */
  ready: boolean;
  early: Array<{ body: PanelEventBody; keep: boolean }>;
}

export type Sink = (event: PanelEvent) => void;

const sessionStorage = () => globalThis.chrome?.storage?.session;

/**
 * The event as it is stored: a tool row keeps what the activity block shows, not the text the model saw, the structured
 * result or the screenshot thumbnail. A panel that reconnects after a worker restart gets those from the snapshot.
 */
export function slimEvent(event: PanelEvent): PanelEvent {
  if (
    event.type !== 'tool_execution_start' &&
    event.type !== 'tool_execution_update' &&
    event.type !== 'tool_execution_end'
  )
    return event;
  const { toolCallId, tool, status, allowedBy, args } = event.row;
  const small = JSON.stringify(args ?? null).length <= MAX_STORED_ARGS;
  return { ...event, row: { toolCallId, tool, status, ...(allowedBy ? { allowedBy } : {}), args: small ? args : {} } };
}

/** The newest events whose JSON fits `limit` characters, in order. */
export function newestWithin(events: PanelEvent[], limit: number): PanelEvent[] {
  let total = 0;
  let from = events.length;
  while (from > 0) {
    const size = JSON.stringify(events[from - 1]).length + 1;
    if (total + size > limit) break;
    total += size;
    from--;
  }
  return events.slice(from);
}

export class Journal {
  #journals = new Map<string, ConversationJournal>();
  #sinks = new Map<string, Set<Sink>>();
  /** What each conversation's stored window takes, and when it was last written, for the shared budget. */
  #stored = new Map<string, { bytes: number; at: number }>();
  #seeded: Promise<void> | null = null;

  #journal(conversationId: string): ConversationJournal {
    let journal = this.#journals.get(conversationId);
    if (!journal) {
      // With no storage area there is no window to wait for.
      const created: ConversationJournal = {
        seq: 0,
        events: [],
        loaded: Promise.resolve(),
        ready: !sessionStorage(),
        early: [],
      };
      if (!created.ready)
        created.loaded = (async () => {
          const key = `${PREFIX}${conversationId}`;
          const stored = (await sessionStorage()?.get(key))?.[key] as { seq: number; events: PanelEvent[] } | undefined;
          if (stored && stored.seq > created.seq) {
            created.seq = stored.seq;
            created.events = stored.events;
          }
        })()
          .catch(() => undefined)
          .then(() => {
            // What was emitted while the window loaded is numbered and sent now, after the stored events.
            created.ready = true;
            const early = created.early.splice(0);
            for (const { body, keep } of early) this.#number(conversationId, body, keep);
          });
      this.#journals.set(conversationId, created);
      journal = created;
    }
    return journal;
  }

  /** Waits until the stored window is loaded, so sequence numbers continue after a worker restart. */
  async ready(conversationId: string): Promise<void> {
    await this.#journal(conversationId).loaded;
  }

  subscribe(conversationId: string, sink: Sink): () => void {
    let sinks = this.#sinks.get(conversationId);
    if (!sinks) this.#sinks.set(conversationId, (sinks = new Set()));
    sinks.add(sink);
    return () => sinks!.delete(sink);
  }

  hasSubscribers(conversationId: string): boolean {
    return (this.#sinks.get(conversationId)?.size ?? 0) > 0;
  }

  currentSeq(conversationId: string): number {
    return this.#journal(conversationId).seq;
  }

  streaming(conversationId: string): { id: string; text: string } | undefined {
    return this.#journal(conversationId).streaming;
  }

  /** The events after `sinceSeq`, or null when the window no longer reaches back that far. */
  since(conversationId: string, sinceSeq: number): PanelEvent[] | null {
    const journal = this.#journal(conversationId);
    if (sinceSeq >= journal.seq) return [];
    const first = journal.events[0]?.seq;
    if (first === undefined || first > sinceSeq + 1) return null;
    return journal.events.filter(e => e.seq > sinceSeq);
  }

  emit(conversationId: string, body: PanelEventBody): void {
    const journal = this.#journal(conversationId);
    if (body.type === 'message_update') {
      journal.streaming = { id: body.id, text: body.text };
      // Coalesced: the latest text goes out at most every 50 ms.
      journal.pendingUpdate ??= setTimeout(() => {
        journal.pendingUpdate = undefined;
        const current = journal.streaming;
        if (current) this.#send(conversationId, { type: 'message_update', id: current.id, text: current.text }, false);
      }, COALESCE_MS);
      return;
    }
    if (body.type === 'message_start') journal.streaming = { id: body.id, text: '' };
    if (body.type === 'message_end' || body.type === 'agent_end') {
      clearTimeout(journal.pendingUpdate);
      journal.pendingUpdate = undefined;
      journal.streaming = undefined;
    }
    this.#send(conversationId, body, body.type !== 'snapshot' && body.type !== 'history' && body.type !== 'export');
  }

  /** Sends to one sink only (a snapshot or a replay for a panel that just subscribed). */
  direct(conversationId: string | null, sink: Sink, body: PanelEventBody): void {
    const seq = conversationId ? this.#journal(conversationId).seq : 0;
    sink({ ...body, seq, conversationId } as PanelEvent);
  }

  #send(conversationId: string, body: PanelEventBody, keep: boolean): void {
    const journal = this.#journal(conversationId);
    // Before the stored window is merged the sequence number is not known yet: the event waits its turn.
    if (!journal.ready) {
      journal.early.push({ body, keep });
      return;
    }
    this.#number(conversationId, body, keep);
  }

  #number(conversationId: string, body: PanelEventBody, keep: boolean): void {
    const journal = this.#journal(conversationId);
    const event = { ...body, seq: ++journal.seq, conversationId } as PanelEvent;
    if (keep) {
      journal.events.push(event);
      if (journal.events.length > WINDOW) journal.events.splice(0, journal.events.length - WINDOW);
      journal.persistTimer ??= setTimeout(() => {
        journal.persistTimer = undefined;
        void this.#persist(conversationId, journal).catch(() => undefined);
      }, PERSIST_MS);
    }
    for (const sink of this.#sinks.get(conversationId) ?? []) {
      try {
        sink(event);
      } catch {
        // A panel that closed mid-send.
      }
    }
  }

  /** Writes the bounded copy of the window. A full storage area is not an error: the window stays in memory. */
  async #persist(conversationId: string, journal: ConversationJournal): Promise<void> {
    const area = sessionStorage();
    if (!area) return;
    const events = newestWithin(journal.events.map(slimEvent), MAX_STORED_BYTES);
    const value = { seq: journal.seq, events };
    const bytes = JSON.stringify(value).length;
    await this.#seed();
    // Counted before the write, so the budget holds even when the write is refused.
    this.#stored.set(conversationId, { bytes, at: Date.now() });
    await this.#makeRoom(conversationId);
    await area.set({ [`${PREFIX}${conversationId}`]: value });
  }

  /** What an earlier worker left in storage.session counts against the budget too. */
  #seed(): Promise<void> {
    this.#seeded ??= (async () => {
      const all = (await sessionStorage()?.get(null)) ?? {};
      for (const [key, value] of Object.entries(all)) {
        const id = key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null;
        if (id && !this.#stored.has(id)) this.#stored.set(id, { bytes: JSON.stringify(value).length, at: 0 });
      }
    })().catch(() => undefined);
    return this.#seeded;
  }

  /** Drops the stored windows of conversations nobody is watching, least recently written first, while over budget. */
  async #makeRoom(keep: string): Promise<void> {
    let total = 0;
    for (const { bytes } of this.#stored.values()) total += bytes;
    if (total <= MAX_TOTAL_BYTES) return;
    const idle = [...this.#stored.entries()]
      .filter(([id]) => id !== keep && !this.hasSubscribers(id))
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, { bytes }] of idle) {
      if (total <= MAX_TOTAL_BYTES) break;
      total -= bytes;
      this.#stored.delete(id);
      await sessionStorage()
        ?.remove(`${PREFIX}${id}`)
        .catch(() => undefined);
    }
  }

  forget(conversationId: string): void {
    const journal = this.#journals.get(conversationId);
    clearTimeout(journal?.pendingUpdate);
    clearTimeout(journal?.persistTimer);
    this.#journals.delete(conversationId);
    this.#stored.delete(conversationId);
    void sessionStorage()
      ?.remove(`${PREFIX}${conversationId}`)
      .catch(() => undefined);
  }
}

// What the model is sent, built from the active branch. Stored messages become the AI SDK's messages; entries that are
// not messages are left out; a `context_edit` replaces a stored text; consecutive messages of one role are sent as one
// message with several parts, so roles alternate on the wire and a note is still a part of its own.
import type { ModelMessage } from '@src/llm';
import type { Entry, EntryOf, MessagePart, StoredMessage } from '@src/store/types';
import { applyCompaction, latestCompaction } from './compaction';
import { note } from './records';

/** The result a call gets when none was recorded (a worker killed or a write failed mid-batch). */
export const MISSING_RESULT =
  'error INTERNAL (delivery unknown)\nNo result was recorded for this call. Look at the page before retrying.';

/** The line that stands in for an image that is no longer sent. */
export const IMAGE_DROPPED_LINE = note('an image was shown here earlier; it is no longer sent to you.');

type UserPart = { type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string };
type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerOptions?: never };
type ToolPart = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: { type: 'text'; value: string } | { type: 'error-text'; value: string };
};

export interface ContextOptions {
  /** Images are removed for models without vision. */
  vision: boolean;
  /** Only the newest image is kept. */
  keepImages?: number;
  /** Actions still unverified: the ledger marks their lines. */
  unverified?: ReadonlySet<string>;
}

/** The messages of a branch, with the elisions of `context_edit` entries applied. */
export function messageEntries(branch: Entry[]): Array<EntryOf<'message'>> {
  const edits = new Map<string, string | null>();
  for (const e of branch) if (e.type === 'context_edit') edits.set(e.targetId, e.replacement);
  const out: Array<EntryOf<'message'>> = [];
  for (const e of branch) {
    if (e.type !== 'message') continue;
    const replacement = edits.get(e.id);
    if (replacement === undefined) {
      out.push(e);
      continue;
    }
    if (replacement === null) continue;
    out.push({ ...e, message: elide(e.message, replacement) });
  }
  return out;
}

/** Replaces attached content, or a tool result's text, with a stub; the user's own words stay. */
function elide(message: StoredMessage, stub: string): StoredMessage {
  return {
    ...message,
    parts: message.parts.map(p => {
      if (p.type === 'text' && p.attached) return { ...p, text: stub };
      if (p.type === 'tool-result') return { ...p, text: stub };
      return p;
    }),
  };
}

function userParts(parts: MessagePart[], images: { keep: Set<MessagePart> }): UserPart[] {
  const out: UserPart[] = [];
  for (const p of parts) {
    if (p.type === 'text') out.push({ type: 'text', text: p.text });
    else if (p.type === 'image') {
      if (images.keep.has(p)) {
        out.push({ type: 'text', text: p.note });
        out.push({ type: 'image', image: p.data, mediaType: p.mediaType });
      } else {
        // A dropped image leaves one line, so the model knows something was shown and is gone.
        out.push({ type: 'text', text: IMAGE_DROPPED_LINE });
      }
    }
  }
  return out;
}

/**
 * Puts each reply's tool results right after it: providers require every result before the next message. A note
 * stored between them (after a restart, a hand-over answered later) moves after the results; nothing is dropped.
 */
export function groupResults(entries: Array<EntryOf<'message'>>): Array<EntryOf<'message'>> {
  const out: Array<EntryOf<'message'>> = [];
  // The calls of the last reply that have no result yet, by id, with the reply they belong to.
  let waiting = new Map<string, string>();
  let owner: EntryOf<'message'> | null = null;
  let held: Array<EntryOf<'message'>> = [];
  // A call whose result was never recorded gets an error result, so the conversation can always be sent: providers
  // refuse a request in which a call has no result. This only happens once something else follows the call.
  const closeOrphans = () => {
    if (waiting.size && owner) {
      out.push({
        type: 'message',
        id: `${owner.id}:missing`,
        parentId: owner.id,
        conversationId: owner.conversationId,
        at: owner.at,
        message: {
          role: 'tool',
          parts: [...waiting].map(([toolCallId, toolName]) => ({
            type: 'tool-result' as const,
            toolCallId,
            toolName,
            text: MISSING_RESULT,
            isError: true,
          })),
        },
      });
    }
    waiting = new Map();
  };
  const flush = () => {
    out.push(...held);
    held = [];
  };
  for (const e of entries) {
    const m = e.message;
    if (m.role === 'tool' && waiting.size) {
      out.push(e);
      for (const p of m.parts) if (p.type === 'tool-result') waiting.delete(p.toolCallId);
      if (!waiting.size) flush();
      continue;
    }
    if (m.role === 'assistant') {
      closeOrphans();
      flush();
      out.push(e);
      owner = e;
      waiting = new Map(
        m.parts
          .filter((p): p is Extract<MessagePart, { type: 'tool-call' }> => p.type === 'tool-call')
          .map(p => [p.toolCallId, p.toolName]),
      );
      continue;
    }
    if (waiting.size) held.push(e);
    else out.push(e);
  }
  // At the end, calls still waiting are in flight, unless a message of the user or a note already follows them.
  if (held.length) closeOrphans();
  flush();
  return out;
}

/** Converts a branch to the AI SDK's messages. */
export function toModelMessages(branch: Entry[], options: ContextOptions): ModelMessage[] {
  let entries = groupResults(messageEntries(branch));
  const compaction = latestCompaction(branch);
  if (compaction) entries = applyCompaction(entries, compaction, options.unverified ?? new Set());
  // Images to keep: the newest ones, and none for a model without vision.
  // The newest image the user attached and the newest the agent's screenshot took are kept separately, so a screenshot
  // does not push out the picture the user asked about.
  const keepCount = options.vision ? (options.keepImages ?? 1) : 0;
  const imagesOf = (tool: boolean) =>
    entries.flatMap(e => ((e.message.role === 'tool') === tool ? e.message.parts.filter(p => p.type === 'image') : []));
  const keep = new Set<MessagePart>(
    keepCount ? [...imagesOf(false).slice(-keepCount), ...imagesOf(true).slice(-keepCount)] : [],
  );

  const out: ModelMessage[] = [];
  const push = (message: ModelMessage) => {
    const last = out[out.length - 1];
    if (last && last.role === message.role && Array.isArray(last.content) && Array.isArray(message.content)) {
      (last.content as unknown[]).push(...(message.content as unknown[]));
      return;
    }
    out.push(message);
  };
  // An image that belongs to a tool result travels in a user message after all of its reply's results: a user message
  // between two results leaves the later call without a result, and the request is refused.
  let images: UserPart[] = [];
  const flushImages = () => {
    if (images.length) push({ role: 'user', content: images } as ModelMessage);
    images = [];
  };
  for (const e of entries) {
    const m = e.message;
    if (m.role !== 'tool') flushImages();
    if (m.role === 'user') {
      const content = userParts(m.parts, { keep });
      if (content.length) push({ role: 'user', content } as ModelMessage);
    } else if (m.role === 'assistant') {
      const content: AssistantPart[] = [];
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
        if (p.type === 'tool-call') {
          content.push({
            type: 'tool-call',
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            input: p.input,
            ...(p.providerOptions ? { providerOptions: p.providerOptions as never } : {}),
          });
        }
      }
      // An empty reply (aborted before any text) is not sent: providers refuse empty assistant messages.
      if (content.length) push({ role: 'assistant', content } as ModelMessage);
    } else {
      const content: ToolPart[] = m.parts
        .filter((p): p is Extract<MessagePart, { type: 'tool-result' }> => p.type === 'tool-result')
        .map(p => ({
          type: 'tool-result',
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          output: p.isError ? { type: 'error-text', value: p.text } : { type: 'text', value: p.text },
        }));
      if (content.length) push({ role: 'tool', content } as ModelMessage);
      images.push(
        ...userParts(
          m.parts.filter(p => p.type === 'image'),
          { keep },
        ),
      );
    }
  }
  flushImages();
  return out;
}

/** Characters of a request's messages, for the size estimate; an image counts as 6,000. */
export function contextChars(messages: ModelMessage[], system = ''): number {
  let chars = system.length;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
      continue;
    }
    for (const p of m.content as Array<Record<string, unknown>>) {
      if (p.type === 'text') chars += String(p.text).length;
      else if (p.type === 'image' || p.type === 'file') chars += 6000;
      else if (p.type === 'tool-call') chars += JSON.stringify(p.input ?? {}).length + String(p.toolName).length;
      else if (p.type === 'tool-result') chars += String((p.output as { value?: unknown })?.value ?? '').length;
    }
  }
  return chars;
}

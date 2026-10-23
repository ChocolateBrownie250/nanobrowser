// Small text helpers for the strings the agent itself writes into the model's context: cuts that never split a
// surrogate pair, and quoting that defuses the extension's own labels, as the layer's session does for its results.
import { defuse, quote } from '@src/browser-control';

/**
 * The extension's own labels, defused wherever page text holds them. The layer's session defuses them inside the
 * `text` of every result; the strings the agent re-renders from structured results (tab titles, addresses, targets,
 * dialog text) go through here so they get the same treatment. The extension's session (src/extension/agent-session.ts)
 * takes its list from here, so the two cannot differ.
 */
export const AGENT_LABELS: readonly string[] = [
  '[Nanobrowser note',
  'browser-state',
  'agent-notes',
  'custom-instructions',
];

/** Page text with the extension's labels and the boundary marker's shape defused. */
export function defuseText(text: string): string {
  return defuse(text, { labels: AGENT_LABELS });
}

/** The layer's quote rule (`«…»`, one line), with the extension's labels defused inside the fragment. */
export function agentQuote(text: string | undefined | null, max = 200): string {
  return quote(text, max, { labels: AGENT_LABELS });
}

/** Defuses the labels inside every quoted fragment of a line the layer rendered (a receipt target, a dialog line). */
export function defuseQuotes(text: string): string {
  return text.replace(/«[^«»\n]*»/g, fragment => `«${defuseText(fragment.slice(1, -1))}»`);
}

/**
 * The end index for cutting `text` after `end` units: one less when the cut would fall between the two halves of a
 * surrogate pair, so a cut never leaves a lone surrogate.
 */
export function cutIndex(text: string, end: number): number {
  const at = Math.max(0, Math.min(Math.floor(end), text.length));
  if (at > 0 && at < text.length) {
    const before = text.charCodeAt(at - 1);
    const after = text.charCodeAt(at);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) return at - 1;
  }
  return at;
}

/** The first `end` units of `text`, never ending inside a surrogate pair. */
export function safeHead(text: string, end: number): string {
  return text.slice(0, cutIndex(text, end));
}

/** `text.slice(start, end)` with both cuts moved off the middle of a surrogate pair (the start moves back). */
export function safeSlice(text: string, start: number, end: number): string {
  const from = cutIndex(text, start);
  const to = Math.max(from, cutIndex(text, end));
  return text.slice(from, to);
}

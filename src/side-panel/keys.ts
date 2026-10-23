// Keys the panel handles for the whole document.

/** Whether a key event belongs to an input method (IME): Esc there closes the candidate list and does nothing else. */
export function isComposingKey(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return !!e.isComposing || e.keyCode === 229;
}

/**
 * Whether Esc stops the running task. It does not while an input method is composing, when the key is already
 * handled (`defaultPrevented`), or while a dialog is open or focus is inside a menu, which take Esc first.
 */
export function escapeStopsRun(
  e: { key: string; defaultPrevented: boolean; isComposing?: boolean; keyCode?: number },
  doc: Pick<Document, 'querySelector' | 'activeElement'>,
): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented || isComposingKey(e)) return false;
  return !doc.querySelector('[role="dialog"]') && !doc.activeElement?.closest('[role="menu"]');
}

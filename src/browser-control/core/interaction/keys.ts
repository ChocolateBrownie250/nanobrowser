// Which key a press or a typed text actually dispatches, for the confirmation gate and policy layer 2.
// The classification follows the key Puppeteer sends, not the name the agent wrote: its US layout sends Enter for
// "Enter", "NumpadEnter", "\r" and "\n", and Space for "Space" and " ".

/**
 * What a key does to an element, for the gate: `activate` clicks it, `enter` may submit a form or send what a field
 * holds, `delete` is a delete shortcut (Delete, Backspace or `#` on an element that is not a text field), `none` nothing
 * the gate classifies.
 */
export type KeyMode = 'activate' | 'enter' | 'none' | 'delete';

/** The element a key goes to, as far as the gate cares. */
export interface KeyElement {
  tag: string;
  type: string;
  contentEditable?: boolean;
  /** The element's role attribute, as the probe reads it (any case). */
  role?: string;
}

/** Tags that are controls, not places to type: whatever editing region they sit in or role they carry, keys activate them. */
const CONTROL_TAGS = new Set(['button', 'a', 'area', 'summary', 'select', 'option', 'input', 'textarea']);
/** Roles of activating controls. An element with one of these is activated by keys, not typed into. */
const CONTROL_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'treeitem',
]);

/**
 * An element that is a text-editing host without being a native field: a contenteditable element (or text inside
 * one), or one whose role says it is a text box or search box. Chat, comment and composer widgets are built this way,
 * and the keys typed into them edit text, while Enter often sends. The element's own tag and role are judged first:
 * every descendant of an editing region reports `contentEditable`, and a role can be put on anything, so a button, a
 * link or a `role=button` element in such a region (or a button given `role=textbox`) is a control that the keys
 * activate, not a place to type. Native inputs and textareas are decided by their tag and type, not here.
 */
export function editsTextHost(el: KeyElement): boolean {
  const role = (el.role ?? '').trim().toLowerCase();
  if (CONTROL_TAGS.has(el.tag) || CONTROL_ROLES.has(role)) return false;
  return !!el.contentEditable || role === 'textbox' || role === 'searchbox';
}

/** A chord split as the page port presses it: parts trimmed, empty parts dropped, the last part is the key. */
export function splitChord(keys: string): { modifiers: string[]; key: string } {
  const parts = keys
    .split('+')
    .map(p => p.trim())
    .filter(Boolean);
  const key = parts.pop() ?? '';
  return { modifiers: parts, key };
}

/** The key Puppeteer dispatches for a key name or a typed character, as far as the gate cares. */
export function dispatchedKey(key: string): string {
  if (key === 'Enter' || key === 'NumpadEnter' || key === '\r' || key === '\n') return 'Enter';
  if (key === ' ' || key === 'Space') return 'Space';
  // The numpad's decimal key (and the NUL character, which the layout maps to it) sends the key code of Delete.
  if (key === 'NumpadDecimal' || key === '\u0000') return 'Delete';
  // Shift+Digit3 is `#`: the layout names the physical key, and the chord supplies the Shift.
  if (key === 'Digit3') return '3';
  return key;
}

/**
 * Whether releasing a key is what activates: Space clicks a button, a checkbox, a radio or a summary on keyup, where
 * Enter acts on keydown. What the release does is decided when it arrives, after the keydown's handlers ran.
 */
export function releaseActivates(key: string): boolean {
  return dispatchedKey(key) === 'Space';
}

const BUTTON_TYPES = ['button', 'submit', 'image', 'reset'];
const TOGGLE_TYPES = ['checkbox', 'radio'];
/** Input types that take no typed text: a key sent to them is a key press, not editing. */
const NON_TEXT_TYPES = [...BUTTON_TYPES, ...TOGGLE_TYPES, 'range', 'color', 'file', 'hidden'];

/** Whether keys sent to the element edit text: a textarea, a text-like input, a contenteditable or a text box by role. */
export function editsText(el: KeyElement): boolean {
  return el.tag === 'textarea' || (el.tag === 'input' && !NON_TEXT_TYPES.includes(el.type)) || editsTextHost(el);
}

/**
 * Whether a key is a delete shortcut when it goes to something that is not a text field: Delete (the numpad's one
 * included), Backspace and `#` (Shift+3, however the layout names the key), which pages bind to "delete the selected
 * item" (a mail list, a file list, a board). Best effort: printable letters are not judged. `key` is the dispatched
 * key (`dispatchedKey`); `modifiers` are the chord's other parts.
 */
function deleteShortcut(key: string, modifiers: readonly string[]): boolean {
  if (key === 'Delete' || key === 'Backspace' || key === '#') return true;
  return key === '3' && modifiers.some(m => m.toLowerCase() === 'shift');
}

/**
 * What a pressed key does to an element. Enter in an input (a checkbox or radio included), a select or a textarea
 * may submit its form; Enter or Space on a button, link or any other element activates it; Space toggles a checkbox
 * or radio; Space in a field or textarea is text. A contenteditable element or a text box by role is a field as well:
 * Enter in it is `enter` (so the rule for a text field with no form applies), Space is text. Errs toward a prompt: a
 * false positive costs one question. Delete, Backspace and `#` (Shift+3) sent to something that is not a text field
 * are `delete`: pages bind them to deleting the selected item.
 */
export function keyMode(key: string, el: KeyElement, modifiers: readonly string[] = []): KeyMode {
  const k = dispatchedKey(key);
  // A delete shortcut outside a text field; in one, the key only edits text.
  if (deleteShortcut(k, modifiers)) return editsText(el) ? 'none' : 'delete';
  if (k !== 'Enter' && k !== 'Space') return 'none';
  const button = el.tag === 'input' && BUTTON_TYPES.includes(el.type);
  if ((el.tag === 'input' && !button) || el.tag === 'select' || el.tag === 'textarea') {
    if (k === 'Enter') return 'enter';
    return el.tag === 'input' && TOGGLE_TYPES.includes(el.type) ? 'activate' : 'none';
  }
  // A text-editing host is a field too: Space is text, and Enter may send what it holds (a chat box).
  if (editsTextHost(el)) return k === 'Enter' ? 'enter' : 'none';
  return 'activate';
}

/**
 * The key in a typed text that can submit or activate: typing presses a key for every character the layout knows,
 * so "\n" or "\r" is Enter and " " is Space. Enter is returned before Space.
 */
export function typedKey(text: string): 'Enter' | 'Space' | null {
  if (/[\r\n]/.test(text)) return 'Enter';
  if (text.includes(' ')) return 'Space';
  return null;
}

const STRENGTH: Record<KeyMode, number> = { none: 0, activate: 1, enter: 2, delete: 3 };

/**
 * What typing a text (then Enter, with submit) does to an element. Typed keys in a textarea only edit it; elsewhere
 * they count as presses. A typed newline in a contenteditable element or a text box by role is Enter, which sends in
 * a chat box; a typed space there is text. The stronger mode wins when both apply.
 */
export function typedMode(text: string, submit: boolean, el: KeyElement): KeyMode {
  const typed = typedKey(text);
  const fromKey: KeyMode = typed && el.tag !== 'textarea' ? keyMode(typed, el) : 'none';
  // A typed `#` (or the NUL character, which the layout types as the numpad's Delete) is a key press too: outside a
  // text field it can be a delete shortcut.
  const fromHash: KeyMode = text.includes('#') || text.includes('\u0000') ? keyMode('#', el) : 'none';
  const fromText = STRENGTH[fromHash] > STRENGTH[fromKey] ? fromHash : fromKey;
  const fromSubmit = submit ? keyMode('Enter', el) : 'none';
  return STRENGTH[fromSubmit] >= STRENGTH[fromText] ? fromSubmit : fromText;
}

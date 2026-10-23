import { describe, expect, it } from 'vitest';
import {
  dispatchedKey,
  editsTextHost,
  keyMode,
  releaseActivates,
  splitChord,
  typedKey,
  typedMode,
} from '../interaction/keys';

const text = { tag: 'input', type: 'text' };
const button = { tag: 'button', type: 'submit' };
const link = { tag: 'a', type: '' };
const checkbox = { tag: 'input', type: 'checkbox' };
const textarea = { tag: 'textarea', type: 'textarea' };
const editable = { tag: 'div', type: '', contentEditable: true };
const textboxRole = { tag: 'div', type: '', role: 'textbox' };

describe('keys the gate classifies', () => {
  it('splits a chord as the page port presses it', () => {
    expect(splitChord('Control+A')).toEqual({ modifiers: ['Control'], key: 'A' });
    expect(splitChord(' Shift + Enter ')).toEqual({ modifiers: ['Shift'], key: 'Enter' });
    expect(splitChord(' Enter')).toEqual({ modifiers: [], key: 'Enter' });
  });

  it('follows the key Puppeteer dispatches, not the name written', () => {
    for (const k of ['Enter', 'NumpadEnter', '\r', '\n']) expect(dispatchedKey(k)).toBe('Enter');
    for (const k of [' ', 'Space']) expect(dispatchedKey(k)).toBe('Space');
    expect(dispatchedKey('Escape')).toBe('Escape');
  });

  it('knows which key activates when it is released', () => {
    for (const k of [' ', 'Space']) expect(releaseActivates(k)).toBe(true);
    for (const k of ['Enter', 'NumpadEnter', '\n', 'Shift', 'a']) expect(releaseActivates(k)).toBe(false);
  });

  it('classifies a pressed key by the element it goes to', () => {
    expect(keyMode('NumpadEnter', text)).toBe('enter');
    expect(keyMode('Enter', textarea)).toBe('enter');
    expect(keyMode('Enter', { tag: 'select', type: 'select-one' })).toBe('enter');
    // Enter in a checkbox submits its form implicitly; Space toggles it.
    expect(keyMode('Enter', checkbox)).toBe('enter');
    expect(keyMode('Space', checkbox)).toBe('activate');
    expect(keyMode('NumpadEnter', button)).toBe('activate');
    expect(keyMode('Space', link)).toBe('activate');
    expect(keyMode('Space', text)).toBe('none');
    expect(keyMode('Escape', button)).toBe('none');
  });

  it('treats typed newlines and spaces as Enter and Space', () => {
    expect(typedKey('a\nb')).toBe('Enter');
    expect(typedKey('a\r')).toBe('Enter');
    expect(typedKey('hello world')).toBe('Space');
    expect(typedKey('hello')).toBeNull();
    expect(typedMode('4111\n', false, text)).toBe('enter');
    expect(typedMode(' ', false, button)).toBe('activate');
    expect(typedMode('hello world', false, text)).toBe('none');
    expect(typedMode('hello', false, text)).toBe('none');
    expect(typedMode('hello', true, text)).toBe('enter');
  });

  it('lets typed keys edit a textarea, but not submit:true', () => {
    expect(typedMode('line one\nline two', false, textarea)).toBe('none');
    expect(typedMode('done', true, textarea)).toBe('enter');
  });

  it('treats a contenteditable or role=textbox/searchbox host as a field (a chat box sends on Enter)', () => {
    for (const host of [
      editable,
      textboxRole,
      { tag: 'div', type: '', role: 'searchbox' },
      { tag: 'div', type: '', role: ' TextBox ' },
    ]) {
      expect(keyMode('Enter', host)).toBe('enter');
      expect(keyMode('NumpadEnter', host)).toBe('enter');
      // Space in an editing host is text, not an activation.
      expect(keyMode('Space', host)).toBe('none');
      expect(keyMode('Escape', host)).toBe('none');
      expect(typedMode('hello', true, host)).toBe('enter');
      expect(typedMode('a b', false, host)).toBe('none');
      // A typed newline is an Enter press, which may send.
      expect(typedMode('a b\n', false, host)).toBe('enter');
    }
    // Other roles and plain divs still activate on both keys.
    expect(keyMode('Enter', { tag: 'div', type: '', role: 'button' })).toBe('activate');
    expect(keyMode('Space', { tag: 'div', type: '', role: 'combobox' })).toBe('activate');
    expect(keyMode('Enter', { tag: 'div', type: '' })).toBe('activate');
  });

  it('decides a text host on the element itself: buttons, links and the like are never one', () => {
    // A control inside an editing region reports contentEditable (it inherits it), and role can be set on anything;
    // neither makes a button or a link accept typed text, so Enter and Space still activate it.
    const controls = [
      { tag: 'button', type: 'submit', contentEditable: true },
      { tag: 'button', type: 'submit', role: 'textbox' },
      { tag: 'button', type: 'button', role: 'searchbox', contentEditable: true },
      { tag: 'a', type: '', contentEditable: true },
      { tag: 'a', type: '', role: 'searchbox' },
      { tag: 'summary', type: '', role: 'textbox' },
      { tag: 'select', type: 'select-one', contentEditable: true },
      { tag: 'div', type: '', role: 'button', contentEditable: true },
      { tag: 'span', type: '', role: 'link', contentEditable: true },
      { tag: 'div', type: '', role: ' Checkbox ', contentEditable: true },
      { tag: 'li', type: '', role: 'menuitem', contentEditable: true },
    ];
    for (const el of controls.filter(c => c.tag !== 'select')) {
      expect(keyMode('Enter', el), JSON.stringify(el)).toBe('activate');
      expect(keyMode('Space', el), JSON.stringify(el)).toBe('activate');
      expect(typedMode('a b', false, el), JSON.stringify(el)).toBe('activate');
      // Delete keys are not edits there.
      expect(keyMode('Delete', el), JSON.stringify(el)).toBe('delete');
    }
    // A native input button or toggle with a textbox role is still a button.
    expect(keyMode('Space', { tag: 'input', type: 'submit', role: 'textbox' })).toBe('activate');
    expect(keyMode('Enter', { tag: 'input', type: 'button', role: 'searchbox', contentEditable: true })).toBe(
      'activate',
    );
    expect(editsTextHost({ tag: 'button', type: 'submit', contentEditable: true })).toBe(false);
    // A descendant of an editing region that is plain text is still edited by the keys.
    const inner = { tag: 'span', type: '', contentEditable: true };
    expect(keyMode('Enter', inner)).toBe('enter');
    expect(keyMode('Space', inner)).toBe('none');
    expect(keyMode('Delete', inner)).toBe('none');
  });

  it('classifies Delete, Backspace and # as delete shortcuts, but only outside text fields', () => {
    const row = { tag: 'div', type: '', role: 'row' };
    const body = { tag: 'body', type: '' };
    for (const el of [row, body, link, button, checkbox, { tag: 'select', type: 'select-one' }]) {
      expect(keyMode('Delete', el)).toBe('delete');
      expect(keyMode('Backspace', el)).toBe('delete');
      expect(keyMode('#', el)).toBe('delete');
      expect(keyMode('3', el, ['Shift'])).toBe('delete');
      expect(keyMode('3', el, ['shift'])).toBe('delete');
    }
    // The same keys under the names Puppeteer's layout gives them: Shift+Digit3 sends `#`, and the numpad's decimal
    // key sends the code of Delete (key "\u0000"); neither can be a way around the check.
    for (const el of [row, body, link, button]) {
      expect(keyMode('Digit3', el, ['Shift']), 'Digit3').toBe('delete');
      expect(keyMode('Digit3', el, ['shift']), 'Digit3').toBe('delete');
      expect(keyMode('NumpadDecimal', el), 'NumpadDecimal').toBe('delete');
      expect(keyMode('\u0000', el), 'NUL').toBe('delete');
      expect(typedMode('\u0000', false, el)).toBe('delete');
    }
    expect(keyMode('Digit3', row)).toBe('none');
    expect(keyMode('Digit3', row, ['Control'])).toBe('none');
    for (const el of [text, textarea, editable]) {
      expect(keyMode('Digit3', el, ['Shift'])).toBe('none');
      expect(keyMode('NumpadDecimal', el)).toBe('none');
    }
    expect(dispatchedKey('NumpadDecimal')).toBe('Delete');
    expect(dispatchedKey('Digit3')).toBe('3');
    // Printable letters, digits without Shift and other keys are not judged.
    for (const key of ['e', 'a', 'j', '3', 'Escape', 'Tab', 'ArrowDown', 'F2']) {
      expect(keyMode(key, row), key).toBe('none');
    }
    expect(keyMode('3', row, ['Control'])).toBe('none');
    // In a text field a delete key only edits.
    for (const el of [text, textarea, editable, textboxRole, { tag: 'input', type: 'email' }]) {
      expect(keyMode('Delete', el)).toBe('none');
      expect(keyMode('Backspace', el)).toBe('none');
      expect(keyMode('#', el)).toBe('none');
      expect(keyMode('3', el, ['Shift'])).toBe('none');
    }
    // Enter and Space keep their own rules.
    expect(keyMode('Enter', row)).toBe('activate');
  });

  it('judges a typed # like a key press: delete outside a text field, nothing inside one', () => {
    expect(typedMode('#', false, { tag: 'body', type: '' })).toBe('delete');
    expect(typedMode('go #1', false, { tag: 'div', type: '', role: 'row' })).toBe('delete');
    expect(typedMode('#', false, text)).toBe('none');
    expect(typedMode('#', false, editable)).toBe('none');
    expect(typedMode('#', true, text)).toBe('enter');
    // The strongest wins: a delete shortcut outranks a newline.
    expect(typedMode('#\n', false, { tag: 'div', type: '', role: 'row' })).toBe('delete');
  });

  it('takes the stronger mode when typed keys and submit differ', () => {
    expect(typedMode(' ', true, checkbox)).toBe('enter');
    expect(typedMode(' ', false, checkbox)).toBe('activate');
  });
});

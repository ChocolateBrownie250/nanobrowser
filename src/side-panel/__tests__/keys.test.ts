import { describe, expect, it } from 'vitest';
import { escapeStopsRun, isComposingKey } from '../keys';

const plain = { querySelector: () => null, activeElement: null } as Pick<Document, 'querySelector' | 'activeElement'>;
const key = (extra: Partial<Parameters<typeof escapeStopsRun>[0]> = {}) => ({
  key: 'Escape',
  defaultPrevented: false,
  ...extra,
});

describe('Esc stops the run', () => {
  it('a plain Esc does', () => {
    expect(escapeStopsRun(key(), plain)).toBe(true);
  });

  it('not while an input method is composing (its Esc closes the candidate list)', () => {
    expect(escapeStopsRun(key({ isComposing: true }), plain)).toBe(false);
    // Some browsers report the composing key as keyCode 229 with isComposing false.
    expect(escapeStopsRun(key({ keyCode: 229 }), plain)).toBe(false);
    expect(isComposingKey({ isComposing: false, keyCode: 27 })).toBe(false);
  });

  it('not for another key, a handled key, an open dialog or a focused menu', () => {
    expect(escapeStopsRun(key({ key: 'Enter' }), plain)).toBe(false);
    expect(escapeStopsRun(key({ defaultPrevented: true }), plain)).toBe(false);
    expect(escapeStopsRun(key(), { ...plain, querySelector: () => ({}) as Element })).toBe(false);
    const inMenu = { closest: (selector: string) => (selector === '[role="menu"]' ? {} : null) } as unknown as Element;
    expect(escapeStopsRun(key(), { ...plain, activeElement: inMenu })).toBe(false);
  });
});

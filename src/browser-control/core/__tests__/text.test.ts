// cutText and quote never leave half of a surrogate pair at a cut (a lone surrogate is rejected by some model APIs).
import { describe, expect, it } from 'vitest';
import { cutText, quote, sliceWhole, untrusted } from '../text';

const NONCE = '3f9a2c1b7e04';
const HINT = '… cut; read on with offset';

/** True when the string holds a high surrogate without a low one after it, or a low one without a high one before. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const EMOJI = 'a😀b👩‍💻c𠮷d🇯🇵e';

describe('surrogate-safe cuts', () => {
  it('sliceWhole backs up from the middle of a pair, at every position', () => {
    for (let end = 0; end <= EMOJI.length + 2; end++) {
      const cut = sliceWhole(EMOJI, end);
      expect(hasLoneSurrogate(cut), `end ${end}`).toBe(false);
      expect(EMOJI.startsWith(cut)).toBe(true);
      // It loses at most the one unit that was half of a pair.
      expect(cut.length).toBeGreaterThanOrEqual(Math.min(end, EMOJI.length) - 1);
    }
  });

  it('quote leaves no lone surrogate at any length and always ends with the ellipsis and the closing mark', () => {
    for (let max = 1; max <= EMOJI.length + 1; max++) {
      const q = quote(EMOJI, max);
      expect(hasLoneSurrogate(q), `max ${max}`).toBe(false);
      expect(q.startsWith('«') && q.endsWith('»')).toBe(true);
      if (EMOJI.length > max) expect(q.endsWith('…»')).toBe(true);
    }
  });

  it('cutText on plain text leaves no lone surrogate at any cut position and keeps the hint', () => {
    const text = EMOJI.repeat(3);
    for (let max = 0; max < text.length; max++) {
      const cut = cutText(text, max, HINT);
      expect(hasLoneSurrogate(cut), `max ${max}`).toBe(false);
      expect(cut.endsWith(HINT)).toBe(true);
    }
  });

  it('cutText inside a boundary leaves no lone surrogate and keeps the end marker at every cut position', () => {
    const wrapped = `before\n${untrusted(NONCE, EMOJI.repeat(4))}\nafter`;
    const end = `<<<end-page-content ${NONCE}>>>`;
    const opening = `<<<page-content ${NONCE}>>>`;
    const bodyStart = wrapped.indexOf(opening) + opening.length;
    for (let max = 0; max < wrapped.length; max++) {
      const cut = cutText(wrapped, max, HINT);
      expect(hasLoneSurrogate(cut), `max ${max}`).toBe(false);
      expect(cut.endsWith(HINT)).toBe(true);
      // A cut that falls after the opening marker has kept the end marker.
      if (max >= bodyStart && max < wrapped.indexOf(end) + end.length) {
        expect(cut, `max ${max}`).toContain(end);
      }
    }
  });
});

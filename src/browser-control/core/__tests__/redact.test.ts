import { describe, expect, it } from 'vitest';
import { redactArgs } from '../redact';

describe('redactArgs for upload and press', () => {
  it('replaces the bytes of an uploaded file with their count and keeps its name', () => {
    const base64 = Buffer.from('top secret contents').toString('base64');
    const out = redactArgs('upload', {
      target: { ref: 'e3' },
      attachments: [{ name: 'tax.pdf', mimeType: 'application/pdf', base64 }],
    });
    expect(out).toEqual({
      target: { ref: 'e3' },
      attachments: [{ name: 'tax.pdf', mimeType: 'application/pdf', base64: '‹19 bytes›' }],
    });
    expect(JSON.stringify(out)).not.toContain(base64);
  });

  it('counts the bytes of padded and unpadded base64 alike', () => {
    const count = (bytes: number) =>
      (
        redactArgs('upload', {
          attachments: [{ name: 'a', mimeType: 'x', base64: Buffer.alloc(bytes, 1).toString('base64') }],
        }) as { attachments: Array<{ base64: string }> }
      ).attachments[0]!.base64;
    expect([count(1), count(2), count(3), count(0)]).toEqual(['‹1 byte›', '‹2 bytes›', '‹3 bytes›', '‹0 bytes›']);
  });

  it('keeps only the number of local paths', () => {
    expect(redactArgs('upload', { paths: ['/home/me/a.pdf', '/home/me/b.pdf'] })).toEqual({ paths: '‹2 paths›' });
    expect(redactArgs('upload', { paths: ['/home/me/a.pdf'] })).toEqual({ paths: '‹1 path›' });
  });

  it('does not change the original arguments', () => {
    const original = { attachments: [{ name: 'a', mimeType: 'x', base64: 'AAAA' }], paths: ['/x'] };
    redactArgs('upload', original);
    expect(original.attachments[0]!.base64).toBe('AAAA');
    expect(original.paths).toEqual(['/x']);
  });

  it('leaves malformed upload arguments as they are, without throwing', () => {
    expect(redactArgs('upload', { attachments: 'x', paths: 3 })).toEqual({ attachments: 'x', paths: 3 });
    expect(redactArgs('upload', { attachments: [null, { name: 'a' }] })).toEqual({
      attachments: [null, { name: 'a' }],
    });
  });

  it('keeps a chord readable and redacts a long run of keys', () => {
    expect(redactArgs('press', { keys: 'Control+Shift+ArrowLeft' })).toEqual({ keys: 'Control+Shift+ArrowLeft' });
    expect(redactArgs('press', { keys: 'Enter' })).toEqual({ keys: 'Enter' });
    expect(redactArgs('press', { keys: 'Control+Shift+Alt+Meta+ArrowDown' })).toEqual({
      keys: 'Control+Shift+Alt+Meta+ArrowDown',
    });
    const run = 'hunter2hunter2hunter2hunter2hunter2hunter2';
    expect(redactArgs('press', { keys: run })).toEqual({ keys: `‹redacted, ${run.length} characters›` });
  });
});

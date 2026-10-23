// Upper bounds on the strings and lists an agent may send. An oversized value is INVALID_ARGUMENT, before anything runs.
import { describe, expect, it } from 'vitest';
import {
  ClickArgsSchema,
  FillFormArgsSchema,
  FindArgsSchema,
  HandleDialogArgsSchema,
  NavigateArgsSchema,
  PressArgsSchema,
  SetArgsSchema,
  TabsArgsSchema,
  TypeArgsSchema,
  UploadArgsSchema,
  WaitArgsSchema,
} from '../index';
import { Controller } from '../../core/controller';
import type { TabHost } from '../../core/ports';

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const target = { ref: 'e1' };

describe('size limits of the request schemas', () => {
  it('bounds typed text at 20 000 characters and a value set in one command at 200 000', () => {
    expect(ok(TypeArgsSchema, { text: 'a'.repeat(20_000) })).toBe(true);
    expect(ok(TypeArgsSchema, { text: 'a'.repeat(20_001) })).toBe(false);
    expect(ok(SetArgsSchema, { target, value: 'a'.repeat(100_000) })).toBe(true);
    expect(ok(SetArgsSchema, { target, value: 'a'.repeat(200_000) })).toBe(true);
    expect(ok(SetArgsSchema, { target, value: 'a'.repeat(200_001) })).toBe(false);
    expect(ok(SetArgsSchema, { target, value: ['a'.repeat(200_001)] })).toBe(false);
    expect(ok(SetArgsSchema, { target, value: true })).toBe(true);
    expect(ok(HandleDialogArgsSchema, { accept: true, promptText: 'a'.repeat(20_001) })).toBe(false);
  });

  it('bounds the keys of a press', () => {
    expect(ok(PressArgsSchema, { keys: 'Control+A' })).toBe(true);
    expect(ok(PressArgsSchema, { keys: 'a'.repeat(2_001) })).toBe(false);
  });

  it('bounds fill_form at 50 fields', () => {
    const field = { target, value: 'x' };
    expect(ok(FillFormArgsSchema, { fields: Array.from({ length: 50 }, () => field) })).toBe(true);
    expect(ok(FillFormArgsSchema, { fields: Array.from({ length: 51 }, () => field) })).toBe(false);
    expect(ok(FillFormArgsSchema, { fields: [{ target, value: 'a'.repeat(200_001) }] })).toBe(false);
    expect(ok(FillFormArgsSchema, { fields: [] })).toBe(false);
  });

  it('bounds addresses at 8 192 characters', () => {
    const url = (n: number) => `https://example.com/${'a'.repeat(n - 'https://example.com/'.length)}`;
    expect(ok(NavigateArgsSchema, { url: url(8_192) })).toBe(true);
    expect(ok(NavigateArgsSchema, { url: url(8_193) })).toBe(false);
    expect(ok(TabsArgsSchema, { action: 'open', url: url(8_193) })).toBe(false);
  });

  it('bounds selectors, names, search strings and expectations at 2 000 characters', () => {
    const long = 'a'.repeat(2_001);
    const fits = 'a'.repeat(2_000);
    expect(ok(ClickArgsSchema, { target: { selector: fits } })).toBe(true);
    expect(ok(ClickArgsSchema, { target: { selector: long } })).toBe(false);
    expect(ok(ClickArgsSchema, { target: { role: 'button', name: long } })).toBe(false);
    expect(ok(FindArgsSchema, { name: long })).toBe(false);
    expect(ok(FindArgsSchema, { text: long })).toBe(false);
    expect(ok(FindArgsSchema, { name: fits, text: fits })).toBe(true);
    expect(ok(WaitArgsSchema, { text: long })).toBe(false);
    expect(ok(WaitArgsSchema, { textGone: long })).toBe(false);
    expect(ok(WaitArgsSchema, { url: long })).toBe(false);
    expect(ok(ClickArgsSchema, { target, expect: { text: long } })).toBe(false);
    expect(ok(ClickArgsSchema, { target, expect: { url: long } })).toBe(false);
    expect(ok(ClickArgsSchema, { target, expect: { textGone: long } })).toBe(false);
    expect(ok(ClickArgsSchema, { target, expect: { value: 'a'.repeat(200_001) } })).toBe(false);
    expect(ok(ClickArgsSchema, { target, expect: { text: fits, url: fits, textGone: fits } })).toBe(true);
  });

  it('bounds an uploaded file at the base64 size of the largest attachment (25 MiB)', () => {
    const largest = Math.ceil((25 * 1024 * 1024) / 3) * 4;
    const file = (n: number) => ({ name: 'a.bin', mimeType: 'application/octet-stream', base64: 'A'.repeat(n) });
    expect(ok(UploadArgsSchema, { attachments: [file(largest)] })).toBe(true);
    expect(ok(UploadArgsSchema, { attachments: [file(35_000_001)] })).toBe(false);
    expect(ok(UploadArgsSchema, { attachments: Array.from({ length: 21 }, () => file(4)) })).toBe(false);
  });
});

describe('an oversized request is INVALID_ARGUMENT', () => {
  it('fails before the tab is touched', async () => {
    let attached = 0;
    const controller = await Controller.create({
      attacher: {
        attach: async () => {
          attached++;
          throw new Error('should not attach');
        },
      },
      tabs: {
        onRemoved: () => () => undefined,
        onNavigationTarget: () => () => undefined,
        setDiscardable: async () => undefined,
      } as unknown as TabHost,
      epochStore: { read: async () => null, write: async () => undefined },
    });
    const session = controller.createSession();
    session.shareTab(7);
    const type = await session.call('type', { text: 'a'.repeat(20_001), tabId: 7 });
    expect(type.error).toMatchObject({ code: 'INVALID_ARGUMENT', delivered: false });
    const form = await session.call('fill_form', {
      fields: Array.from({ length: 51 }, () => ({ target, value: 'x' })),
      tabId: 7,
    });
    expect(form.error?.code).toBe('INVALID_ARGUMENT');
    const nav = await session.call('navigate', { url: `https://example.com/${'a'.repeat(9_000)}`, tabId: 7 });
    expect(nav.error?.code).toBe('INVALID_ARGUMENT');
    expect(attached).toBe(0);
  });
});

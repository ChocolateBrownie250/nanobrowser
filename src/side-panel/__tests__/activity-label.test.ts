import { describe, expect, it } from 'vitest';
import { activityLine, maskArgs } from '../activity-label';
import type { ToolRow } from '@src/ui/protocol';
import { runRows } from '@src/ui/protocol';

const row = (tool: string, args: unknown, result?: unknown): ToolRow => ({
  toolCallId: 'x',
  tool,
  args,
  status: 'done',
  result,
});

describe('activity rows', () => {
  it('names the target without its ref, with the effect and how a write was allowed', () => {
    const line = activityLine(
      row(
        'click',
        {},
        {
          ok: true,
          receipt: {
            target: '[a2] button «Send»',
            sensitive: 'submit',
            allowedBy: 'site-rule',
            effect: { verdict: 'none', signals: [] },
          },
        },
      ),
    );
    expect(line.label).toBe('Clicked button «Send»');
    expect(line.tags).toEqual(['no effect', "submit · allowed by the site's rule"]);
  });

  it('marks an address the agent wrote', () => {
    expect(activityLine(row('navigate', { url: 'https://a.example/' })).details).toEqual([
      'Address written by the agent',
    ]);
    expect(activityLine(row('navigate', { action: 'back' })).details).toEqual([]);
  });

  it('shows requests seen during an unclassified action as a plain detail, never for a classified one', () => {
    const signals = ['request: POST «/api/search»', 'request: GET «/img.png»'];
    expect(
      activityLine(row('click', {}, { receipt: { target: 'x', effect: { verdict: 'changed', signals } } })).details,
    ).toEqual(['Observed POST /api/search during this action; no approval was requested.']);
    expect(
      activityLine(
        row('click', {}, { receipt: { target: 'x', sensitive: 'submit', effect: { verdict: 'changed', signals } } }),
      ).details,
    ).toEqual([]);
  });

  it('counts fill_form fields and names the error code', () => {
    const line = activityLine(
      row(
        'fill_form',
        { fields: [{}, {}, {}], submit: { ref: 'a1' } },
        { ok: false, error: { code: 'USER_STEP', message: '' } },
      ),
    );
    expect(line.label).toBe('Filled 3 fields and submitted');
    expect(line.tags).toEqual(['USER_STEP']);
  });

  it('masks typed values', () => {
    expect(maskArgs({ target: { ref: 'a1' }, value: 'hunter2' })).toEqual({
      target: { ref: 'a1' },
      value: '(7 characters)',
    });
    expect(maskArgs({ fields: [{ ref: 'a1', value: '4111' }] })).toEqual({
      fields: [{ ref: 'a1', value: '(4 characters)' }],
    });
  });

  it('masks the typed and expected text wherever it sits, as a string or a list', () => {
    expect(
      maskArgs({
        target: { ref: 'a1' },
        value: 'hunter2',
        expect: {
          value: 'hunter2',
          text: 'Welcome back',
          textGone: ['Sign in', 'Password'],
          url: 'https://a.example/',
        },
        fields: [{ ref: 'a1', value: 'abc', expect: { textGone: 'Error' } }],
        promptText: 'secret',
        keys: 'Enter',
      }),
    ).toEqual({
      target: { ref: 'a1' },
      value: '(7 characters)',
      expect: {
        value: '(7 characters)',
        text: '(12 characters)',
        textGone: ['(7 characters)', '(8 characters)'],
        url: 'https://a.example/',
      },
      fields: [{ ref: 'a1', value: '(3 characters)', expect: { textGone: '(5 characters)' } }],
      promptText: '(6 characters)',
      keys: 'Enter',
    });
  });

  it('leaves values that are not text, and the arguments it was given, alone', () => {
    const args = { value: true, fields: [{ ref: 'a1', value: false }], expect: { value: ['a'] } };
    expect(maskArgs(args)).toEqual({
      value: true,
      fields: [{ ref: 'a1', value: false }],
      expect: { value: ['(1 characters)'] },
    });
    expect(args.expect.value).toEqual(['a']);
    expect(maskArgs(undefined)).toBeUndefined();
    expect(maskArgs('text')).toBe('text');
  });

  it('names the page read when the run began', () => {
    expect(activityLine(row('opened', undefined)).label).toBe('Looked at the page');
  });

  it('says what a read took: the page, more of it, or one element', () => {
    expect(activityLine(row('read', {})).label).toBe("Read the page's text");
    expect(activityLine(row('read', { offset: 20_000 })).label).toBe("Read more of the page's text");
    expect(activityLine(row('read', { ref: 'a4' })).label).toBe('Read the text of one element');
  });
});

describe('the rows of a run', () => {
  const done = (status: ToolRow['status']): ToolRow => ({ toolCallId: status, tool: 'done', args: {}, status });

  it('puts the page read at the start first and leaves out a done that went through', () => {
    const rows = runRows([row('click', {}), done('done')], { messageId: 'u1' });
    expect(rows.map(r => r.tool)).toEqual(['opened', 'click']);
    expect(rows[0]).toMatchObject({ toolCallId: 'opened:u1', status: 'done' });
  });

  it('keeps a done that was refused or skipped, and shows nothing for a done alone', () => {
    expect(runRows([done('failed'), done('skipped')]).map(r => r.status)).toEqual(['failed', 'skipped']);
    expect(runRows([done('done')])).toEqual([]);
  });
});

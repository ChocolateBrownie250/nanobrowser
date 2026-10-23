// Tool-level tests over a scripted page with one element (harness.ts `pageProbe`, `pageCdp`, `showElement`): press and
// set go through resolve, actionability, the gate and the dispatch ports as in the extension; only the page is fake.
import { describe, expect, it, vi } from 'vitest';
import type { ConfirmAnswer, ConfirmRequest, PagePort, UserPrompt } from '../ports';
import { LayerError } from '../../protocol/errors';
import type { FormFacts, NavigationTarget, ProbeState } from '../../probe';
import { VIA_LABEL_NOTE } from '../interaction/actionability';
import { click } from '../tools/act';
import { press, set, type as typeText } from '../tools/text';
import { PLAIN_FACTS, PLAIN_STATE, makeHarness, pageCdp, pageProbe, showElement } from './harness';
import type { FakeProbe } from './harness';

const rejection = async (promise: Promise<unknown>): Promise<LayerError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LayerError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
};

function prompt(answer: ConfirmAnswer) {
  return {
    confirm: vi.fn(async (_request: ConfirmRequest): Promise<ConfirmAnswer> => answer),
    ask: vi.fn(async () => ({ outcome: 'continue' as const })),
  } satisfies UserPrompt;
}

/** A page port that records the keys it is given. */
function keyPort(log: string[]): Partial<PagePort> {
  return {
    chord: (keys: string) => {
      const parts = keys.split('+').map(p => p.trim());
      return { modifiers: parts.slice(0, -1), key: parts[parts.length - 1] };
    },
    keyDown: async (key: string) => void log.push(`down ${key}`),
    keyUp: async (key: string) => void log.push(`up ${key}`),
    isKey: () => true,
    insertCharacter: async () => undefined,
  };
}

const state = (over: Partial<ProbeState>): ProbeState => ({ ...PLAIN_STATE, ...over });
const facts = (over: Partial<FormFacts>): FormFacts => ({ ...PLAIN_FACTS, ...over });

const inputEvents = (h: { cdp: Array<[string, unknown]> }) => h.cdp.filter(([m]) => m.startsWith('Input.'));

describe('press: which keys ask the user', () => {
  async function pressOn(probe: FakeProbe, print: { role: string; name: string; tag?: string }, keys: string) {
    const sent: string[] = [];
    const p = prompt('decline');
    const h = await makeHarness({
      prompt: p,
      page: keyPort(sent),
      probe: pageProbe(probe),
      cdpReply: pageCdp(),
    });
    const ref = showElement(h, print);
    const error = await rejection(press(h.ctx, { target: { ref }, keys } as never));
    return { error, p, sent, h };
  }

  it('Delete on a row asks as a delete, and the key is not sent when the user declines', async () => {
    const { error, p, sent, h } = await pressOn(
      { state: () => state({ role: 'row' }) },
      { role: 'row', name: 'INV-1042' },
      'Delete',
    );
    expect(error.code).toBe('USER_DECLINED');
    expect(p.confirm).toHaveBeenCalledTimes(1);
    expect(p.confirm.mock.calls[0][0].category).toBe('delete');
    expect(p.confirm.mock.calls[0][0].reason).toMatch(/Delete, Backspace or #/);
    expect(sent).toEqual([]);
    expect(inputEvents(h)).toEqual([]);
  });

  it('# (Shift+3) on the page asks as a delete too', async () => {
    const { error, p } = await pressOn({ state: () => state({}) }, { role: 'row', name: 'INV-1042' }, 'Shift+3');
    expect(error.code).toBe('USER_DECLINED');
    expect(p.confirm.mock.calls[0][0].category).toBe('delete');
  });

  it('Enter in a chat box (a contenteditable with no form) asks as a send', async () => {
    const { error, p, sent } = await pressOn(
      {
        state: () => state({ contentEditable: true, editable: true }),
        formFacts: () => facts({ textEntry: true }),
      },
      { role: 'textbox', name: 'Message' },
      'Enter',
    );
    expect(error.code).toBe('USER_DECLINED');
    expect(p.confirm).toHaveBeenCalledTimes(1);
    expect(p.confirm.mock.calls[0][0].category).toBe('submit');
    expect(sent).toEqual([]);
  });

  it('Space in a chat box is text: it does not ask', async () => {
    const sent: string[] = [];
    let accepted = 0;
    const p = prompt('decline');
    const h = await makeHarness({
      prompt: p,
      page: {
        ...keyPort(sent),
        keyDown: async (key: string) => {
          sent.push(`down ${key}`);
          accepted++;
        },
      },
      probe: pageProbe({
        state: () => state({ contentEditable: true, editable: true, focused: true }),
        formFacts: () => facts({ textEntry: true }),
        stepGuard: () => ({ verdict: 'passed', hit: '', seen: [], accepted, armed: true, focusOk: true, focus: 'x' }),
      }),
      cdpReply: pageCdp(),
    });
    const ref = showElement(h, { role: 'textbox', name: 'Message' });
    await press(h.ctx, { target: { ref }, keys: 'Space' } as never);
    expect(p.confirm).not.toHaveBeenCalled();
    expect(sent).toContain('down Space');
  });
});

describe('press: a control is judged as itself whatever editing region or role it sits in', () => {
  async function pressPay(keys: string, own: Partial<ProbeState>) {
    const sent: string[] = [];
    const p = prompt('approve');
    const h = await makeHarness({
      config: { handover: true },
      prompt: p,
      page: keyPort(sent),
      probe: pageProbe({
        state: () => state({ tag: 'button', type: 'submit', ...own }),
        formFacts: () => facts({ tag: 'button', type: 'submit' }),
      }),
      cdpReply: pageCdp(),
    });
    const ref = showElement(h, { role: 'button', name: 'Pay now', tag: 'button' });
    const error = await rejection(press(h.ctx, { target: { ref }, keys } as never));
    return { error, sent, p };
  }

  for (const keys of ['Space', 'Enter']) {
    it(`${keys} on a "Pay now" button inside a contenteditable region is the user's step`, async () => {
      const { error, sent } = await pressPay(keys, { contentEditable: true });
      expect(error.code).toBe('USER_STEP');
      expect(sent).toEqual([]);
    });

    it(`${keys} on a "Pay now" button with role=textbox is the user's step`, async () => {
      const { error, sent } = await pressPay(keys, { role: 'textbox' });
      expect(error.code).toBe('USER_STEP');
      expect(sent).toEqual([]);
    });
  }
});

describe('type: a button inside an editing region is not a field', () => {
  it('type with submit on a "Pay now" button in a contenteditable region is refused before any key is sent', async () => {
    const sent: string[] = [];
    const p = prompt('approve');
    const h = await makeHarness({
      config: { handover: true },
      prompt: p,
      page: keyPort(sent),
      probe: pageProbe({
        // What the probe reports for such a button: it inherits isContentEditable, but it is not editable.
        state: () => state({ tag: 'button', type: 'submit', contentEditable: true, editable: false }),
        formFacts: () => facts({ tag: 'button', type: 'submit', textEntry: false }),
      }),
      cdpReply: pageCdp(),
    });
    const ref = showElement(h, { role: 'button', name: 'Pay now', tag: 'button' });
    const error = await rejection(
      typeText(h.ctx, { target: { ref }, text: 'x', submit: true, timeoutMs: 200 } as never),
    );
    expect(error.code).toBe('NOT_EDITABLE');
    expect(sent).toEqual([]);
    expect(p.confirm).not.toHaveBeenCalled();
  });
});

describe('click through a hidden input’s label is named in the receipt', () => {
  async function clickCheckbox(visible: boolean) {
    const h = await makeHarness({
      prompt: prompt('approve'),
      probe: pageProbe({
        state: () => state({ tag: 'input', type: 'checkbox', visible, checked: false }),
        labelPoint: () => ({ fx: 0.5, fy: 0.5 }),
        labelFor: () => 77,
        hitAccepts: () => ({ accepted: true, kind: visible ? 'inside' : 'label' }),
      }),
      cdpReply: pageCdp(77),
    });
    const ref = showElement(h, { role: 'checkbox', name: 'Subscribe', tag: 'input' });
    const outcome = await click(h.ctx, { target: { ref }, observe: 'none' } as never);
    return (outcome as { receipt: { target: string } }).receipt.target;
  }

  it('says the click went to the label when the input is hidden', async () => {
    expect(await clickCheckbox(false)).toContain(`(${VIA_LABEL_NOTE})`);
  });

  it('says nothing of a label when the input itself is clicked', async () => {
    expect(await clickCheckbox(true)).not.toContain('label');
  });
});

describe('a click the guard cancelled does not promise that no page script saw it', () => {
  async function clickCancelled(accepted: number) {
    const h = await makeHarness({
      prompt: prompt('approve'),
      probe: pageProbe({
        readGuard: () => ({ verdict: 'cancelled', hit: 'button#pay', seen: [], accepted }),
      }),
      cdpReply: pageCdp(),
    });
    const ref = showElement(h, { role: 'button', name: 'Preview', tag: 'div' });
    return rejection(click(h.ctx, { target: { ref }, observe: 'none' } as never));
  }

  it('cancelled as it arrived: delivery unknown, with a hint that says to look', async () => {
    const error = await clickCancelled(0);
    expect(error.code).toBe('INTERCEPTED');
    expect(error.delivered).toBe('unknown');
    expect(error.message).toContain('button#pay');
    expect(error.message).not.toMatch(/No page handler ran/);
    expect(error.hint).toMatch(/capture phase/);
    expect(error.hint).not.toMatch(/retrying is safe/);
  });

  it('cancelled after an earlier press arrived: delivered true', async () => {
    const error = await clickCancelled(1);
    expect(error.delivered).toBe(true);
    expect(error.message).not.toMatch(/no page handler ran/);
  });
});

describe('set with submit refuses before the field is clicked', () => {
  async function setWithLateChange(onSecondLook: (stop: () => void) => NavigationTarget | null) {
    const stop = new AbortController();
    let looks = 0;
    const h = await makeHarness({
      config: { urlPolicy: { allow: [], deny: ['evil.test'] } },
      prompt: prompt('approve'),
      signal: stop.signal,
      probe: pageProbe({
        state: () => state({ tag: 'input', type: 'text', editable: true, focused: false }),
        // No form and not a chat box: Enter does nothing the gate judges, so no card and no second look at the destination.
        formFacts: () => facts({ tag: 'input', type: 'text', field: true }),
        // The first look is the gate's; the page changes before the second (the one before the click).
        navigationTarget: () => (++looks === 1 ? null : onSecondLook(() => stop.abort())),
      }),
      cdpReply: pageCdp(),
    });
    const ref = showElement(h, { role: 'textbox', name: 'Search', tag: 'input' });
    const error = await rejection(set(h.ctx, { target: { ref }, value: 'hello', submit: true } as never));
    return { error, h, looks: () => looks };
  }

  it('a destination the policy denies is refused with nothing sent (no focus click, no input)', async () => {
    const { error, h, looks } = await setWithLateChange(() => ({
      kind: 'form',
      url: 'https://evil.test/collect',
      method: 'POST',
      newTab: false,
    }));
    expect(error.code).toBe('URL_NOT_ALLOWED');
    expect(error.delivered).toBe(false);
    expect(inputEvents(h)).toEqual([]);
    expect(looks()).toBe(2);
  });

  it('a Stop at that moment ends the call before the focus click, delivered false', async () => {
    const { error, h, looks } = await setWithLateChange(stop => {
      stop();
      return null;
    });
    expect(error.code).toBe('CANCELLED');
    expect(error.delivered).toBe(false);
    expect(inputEvents(h)).toEqual([]);
    expect(looks()).toBe(2);
  });
});

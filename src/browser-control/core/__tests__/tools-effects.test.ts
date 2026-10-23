// Tool-level tests (harness.ts) for what a result says about delivery and about what an upload leaves behind: the guard's
// INTERCEPTED, the capped signals of a receipt, the upload's chunk keys, and the preflight that fails closed.
import { describe, expect, it, vi } from 'vitest';
import type { PageFacts } from '../../probe';
import { LayerError } from '../../protocol/errors';
import { cappedSignals } from '../interaction/evidence';
import { KeyGuard } from '../interaction/key-guard';
import { preflightNavigation } from '../interaction/preflight';
import type { ConfirmAnswer, ConfirmRequest, UserPrompt } from '../ports';
import { upload } from '../tools/upload';
import { MAIN_FRAME, makeHarness } from './harness';

const rejection = async (promise: Promise<unknown>): Promise<LayerError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LayerError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
};

const approving = () =>
  ({
    confirm: vi.fn(async (_request: ConfirmRequest): Promise<ConfirmAnswer> => 'approve'),
    ask: vi.fn(async () => ({ outcome: 'continue' as const })),
  }) satisfies UserPrompt;

const step = (over: Record<string, unknown>) => ({
  verdict: 'passed',
  hit: '',
  seen: [],
  accepted: 0,
  armed: true,
  focusOk: true,
  focus: 'input',
  ...over,
});

describe('INTERCEPTED says what the guard can and cannot promise', () => {
  async function guardWith(steps: Array<Record<string, unknown>>) {
    let at = 0;
    const h = await makeHarness({
      probe: {
        armGuard: () => undefined,
        armAwayGuard: () => undefined,
        disarm: () => undefined,
        stepGuard: () => steps[Math.min(at++, steps.length - 1)],
      },
    });
    const guard = await KeyGuard.arm(
      h.ctx,
      { frame: MAIN_FRAME, objectId: 'obj', description: 'textbox "Name"' },
      { delivered: false, progress: () => 'Progress.' },
    );
    return guard;
  }

  it('a key sent and then cancelled by the guard: delivery is unknown, and the hint says to look', async () => {
    // First check passes, the key is sent, the next check finds it was cancelled before the target accepted it.
    const guard = await guardWith([step({}), step({ verdict: 'cancelled', hit: 'button#pay', accepted: 0 })]);
    await guard.unit(async () => undefined);
    const error = await rejection(guard.unit(async () => undefined));
    expect(error.code).toBe('INTERCEPTED');
    expect(error.delivered).toBe('unknown');
    expect(error.message).toContain('capture phase');
    expect(error.hint).toMatch(/capture phase/);
    expect(error.hint).not.toMatch(/retrying is safe/);
    await guard.disarm();
  });

  it('refused before any key was sent: nothing dispatched, delivered false', async () => {
    const guard = await guardWith([step({ verdict: 'cancelled', hit: 'button#pay' })]);
    const error = await rejection(guard.unit(async () => undefined));
    expect(error.code).toBe('INTERCEPTED');
    expect(error.delivered).toBe(false);
    expect(error.hint).toMatch(/look at what changed first, then retry/);
    await guard.disarm();
  });

  it('a key the target accepted before: delivered true', async () => {
    const guard = await guardWith([
      step({}),
      step({ accepted: 1 }),
      step({ verdict: 'cancelled', hit: 'button#pay', accepted: 1 }),
    ]);
    await guard.unit(async () => undefined);
    await guard.unit(async () => undefined);
    const error = await rejection(guard.unit(async () => undefined));
    expect(error.delivered).toBe(true);
    await guard.disarm();
  });
});

describe('a receipt lists at most five of each kind of signal', () => {
  it('cappedSignals keeps five and counts the rest', () => {
    const items = Array.from({ length: 500 }, (_, i) => `m${i}`);
    const out = cappedSignals(items, i => `alert ${i}`, 'alerts');
    expect(out).toHaveLength(6);
    expect(out[4]).toBe('alert m4');
    expect(out[5]).toBe('… 495 more alerts');
    expect(cappedSignals(items.slice(0, 5), i => i, 'alerts')).toHaveLength(5);
    expect(cappedSignals([], i => i, 'alerts')).toEqual([]);
  });

  it('an upload whose page added 500 alerts, 40 invalid fields and 30 layers reports five of each', async () => {
    const before: PageFacts = { alerts: [], invalid: [], layers: [] };
    const after: PageFacts = {
      alerts: Array.from({ length: 500 }, (_, i) => `Alert number ${i}`),
      invalid: Array.from({ length: 40 }, (_, i) => `Field ${i} is required`),
      layers: Array.from({ length: 30 }, (_, i) => `dialog layer ${i}`),
    };
    let uploaded = false;
    const h = await makeHarness({
      prompt: approving(),
      probe: {
        approximateName: () => 'Photo',
        fileChunk: () => 1,
        setFiles: () => {
          uploaded = true;
          return [{ name: 'a.txt', size: 3 }];
        },
        fileList: () => [{ name: 'a.txt', size: 3 }],
        pageFacts: () => (uploaded ? after : before),
        formFacts: () => ({}),
      },
    });
    h.tab.fileChooser = { frameId: MAIN_FRAME.frameId, backendNodeId: 5, mode: 'selectSingle' };
    h.tab.pending.push({ kind: 'file-chooser', detail: 'a file chooser is open' } as never);
    const outcome = await upload(h.ctx, {
      attachments: [{ name: 'a.txt', mimeType: 'text/plain', base64: 'QUJD' }],
      observe: 'none',
    } as never);
    const signals = (outcome as { receipt?: { effect: { signals: string[] } } }).receipt!.effect.signals;
    expect(signals.filter(s => s.startsWith('alert ')).length).toBe(5);
    expect(signals).toContain('… 495 more alerts');
    expect(signals.filter(s => s.startsWith('validation ')).length).toBe(5);
    expect(signals).toContain('… 35 more validation messages');
    const layers = signals.find(s => s.startsWith('+30 top-level layer'))!;
    expect(layers).toContain('… 25 more');
    expect(layers.match(/dialog layer/g)!.length).toBe(5);
  });
});

describe('an upload cleans up after a failure and never reuses a chunk key', () => {
  it('a failed setFiles drops the chunks it sent, and the retry uses other keys', async () => {
    const chunkKeys: string[] = [];
    const dropped: string[][] = [];
    let failFirst = true;
    const h = await makeHarness({
      prompt: approving(),
      probe: {
        approximateName: () => 'Photo',
        fileChunk: (...args: unknown[]) => {
          chunkKeys.push(args[0] as string);
          return 1;
        },
        setFiles: () => {
          if (failFirst) {
            failFirst = false;
            throw new LayerError('INTERNAL', 'the page refused');
          }
          return [{ name: 'a.txt', size: 3 }];
        },
        dropFiles: (...args: unknown[]) => {
          dropped.push(args[0] as string[]);
          return 1;
        },
        fileList: () => [{ name: 'a.txt', size: 3 }],
        pageFacts: () => ({ alerts: [], invalid: [], layers: [] }),
        formFacts: () => ({}),
      },
    });
    const open = () => {
      h.tab.fileChooser = { frameId: MAIN_FRAME.frameId, backendNodeId: 5, mode: 'selectSingle' };
      h.tab.pending.push({ kind: 'file-chooser', detail: 'a file chooser is open' } as never);
    };
    const args = { attachments: [{ name: 'a.txt', mimeType: 'text/plain', base64: 'QUJD' }], observe: 'none' } as never;
    open();
    const error = await rejection(upload(h.ctx, args));
    expect(error.message).toContain('the page refused');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toEqual(chunkKeys);
    // The retry is a new call: its key is not the failed call's.
    open();
    await upload(h.ctx, args);
    expect(chunkKeys).toHaveLength(2);
    expect(chunkKeys[1]).not.toBe(chunkKeys[0]);
    expect(dropped).toHaveLength(1);
  });
});

describe('preflight fails closed when the navigation target cannot be read', () => {
  it('a probe error becomes URL_NOT_ALLOWED with nothing dispatched', async () => {
    const h = await makeHarness({
      probe: {
        navigationTarget: () => {
          throw new Error('Cannot read properties of undefined');
        },
      },
    });
    const error = await rejection(preflightNavigation(h.ctx, MAIN_FRAME, 'obj', 'activate', 'button "Go"'));
    expect(error.code).toBe('URL_NOT_ALLOWED');
    expect(error.delivered).toBe(false);
    expect(error.message).toContain('could not be read');
    // An unreadable destination is not an address-policy refusal, and the hint does not say it is.
    expect(error.hint).toContain('could not be read');
    expect(error.hint).not.toMatch(/not allowed|policy/);
  });

  it('a LayerError from the policy passes through unchanged', async () => {
    const h = await makeHarness({
      probe: {
        navigationTarget: () => {
          throw new LayerError('FRAME_DETACHED', 'gone');
        },
      },
    });
    const error = await rejection(preflightNavigation(h.ctx, MAIN_FRAME, 'obj', 'activate', 'button "Go"'));
    expect(error.code).toBe('FRAME_DETACHED');
  });

  it('no target to navigate to: nothing to refuse', async () => {
    const h = await makeHarness({ probe: { navigationTarget: () => null } });
    await expect(preflightNavigation(h.ctx, MAIN_FRAME, 'obj', 'activate', 'button "Go"')).resolves.not.toThrow();
  });
});

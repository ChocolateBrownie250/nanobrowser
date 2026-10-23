// Settings → Data → Delete everything tells the truth about what the worker answered.
import '@src/ui/__tests__/dom-env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { act } from 'react';
import { DATA_REQUEST } from '@src/ui/protocol';
import { DeleteEverythingCard } from '../DataSection';

describe('Delete everything', () => {
  let host: HTMLElement;
  let root: Root;
  const send = vi.fn();
  const done = vi.fn();
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement | undefined;
  const click = async (label: string) => {
    const target = button(label);
    expect(target, `a button named ${label}`).toBeDefined();
    await act(async () => {
      target!.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    });
  };
  /** Opens the confirmation and confirms. */
  const confirm = async () => {
    await click('Delete everything');
    await click('Delete everything now');
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    send.mockReset();
    done.mockReset();
    (globalThis as Record<string, unknown>).chrome = { runtime: { sendMessage: send } };
    act(() => root.render(<DeleteEverythingCard onDone={done} />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it('says it was deleted only when the worker answered ok', async () => {
    send.mockResolvedValue({ ok: true });
    await confirm();
    expect(send).toHaveBeenCalledWith({ type: DATA_REQUEST, op: 'delete-all' });
    expect(host.textContent).toContain('Everything was deleted.');
    expect(host.textContent).not.toContain('Not everything could be deleted');
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('shows the worker’s error, not success, when it answered ok:false, and the button stays for a retry', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'Error: keys store is locked' });
    await confirm();
    expect(host.textContent).not.toContain('Everything was deleted.');
    expect(host.textContent).toContain('Not everything could be deleted: Error: keys store is locked.');
    expect(done).not.toHaveBeenCalled();
    // The confirmation is still there, so the user can try again.
    expect(button('Delete everything now')?.disabled).toBe(false);
    send.mockResolvedValueOnce({ ok: true });
    await click('Delete everything now');
    expect(send).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Everything was deleted.');
    expect(host.textContent).not.toContain('Not everything could be deleted');
  });

  it('shows an error when the message is rejected (the worker stopped)', async () => {
    send.mockRejectedValueOnce(new Error('The message port closed before a response was received.'));
    await confirm();
    expect(host.textContent).not.toContain('Everything was deleted.');
    expect(host.textContent).toContain('The message port closed before a response was received.');
    expect(button('Delete everything now')).toBeDefined();
  });

  it('shows an error when nobody answered (an undefined reply)', async () => {
    send.mockResolvedValueOnce(undefined);
    await confirm();
    expect(host.textContent).not.toContain('Everything was deleted.');
    expect(host.textContent).toContain('Not everything could be deleted, and the extension gave no reason.');
    expect(done).not.toHaveBeenCalled();
  });
});

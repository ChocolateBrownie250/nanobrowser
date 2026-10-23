// The interface-language picker stores the language that was chosen, not the one the controlled select shows again
// once the change event is over: the storage runs an updater after the event, so the handler must read the choice first.
import '@src/ui/__tests__/dom-env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { act } from 'react';

describe('Language picker', () => {
  let host: HTMLElement;
  let root: Root;
  let stored: Record<string, unknown>;

  beforeEach(() => {
    stored = {};
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const area = {
      get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in stored).map(k => [k, stored[k]])),
      set: async (items: Record<string, unknown>) => void Object.assign(stored, items),
      onChanged: { addListener: () => undefined },
    };
    (globalThis as Record<string, unknown>).chrome = { storage: { local: area, session: area } };
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it('writes the chosen language to the settings', async () => {
    // Loaded after the fake chrome exists, because the settings storage reads chrome when it is created.
    const { UiLanguageRow } = await import('../GeneralSection');
    await act(async () => root.render(<UiLanguageRow />));
    const select = host.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    // linkedom's select has no usable `value`; give it the one a browser has: the value of the selected option.
    Object.defineProperty(select, 'value', {
      configurable: true,
      get: () => [...select.querySelectorAll('option')].find(o => o.selected)?.value ?? '',
    });
    await act(async () => {
      (select.querySelector('option[value="zh_CN"]') as HTMLOptionElement).selected = true;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => new Promise<void>(resolve => setTimeout(resolve, 20)));
    expect((stored['nb.settings'] as { uiLanguage?: string } | undefined)?.uiLanguage).toBe('zh_CN');
  });
});

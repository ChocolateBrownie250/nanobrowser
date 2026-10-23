import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Permissions } from '../permissions';
import { siteRulesStorage } from '@src/store/settings';

// The write policy the layer actually calls: the mode of the conversation and the site's rule decide, and anything
// unexpected asks.
function fakeLocal() {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) =>
          Object.fromEntries(keys.filter(k => k in data).map(k => [k, structuredClone(data[k])])),
        set: async (items: Record<string, unknown>) => void Object.assign(data, structuredClone(items)),
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return data;
}

const question = (site: string) => ({ category: 'submit' as const, site, tabId: 1 });

describe('Permissions.decide', () => {
  beforeEach(() => {
    fakeLocal();
  });

  async function permissions(rules: Record<string, 'allow' | 'ask' | 'block'> = {}) {
    await siteRulesStorage.set(
      Object.fromEntries(
        Object.entries(rules).map(([site, rule]) => [site, { rule, setAt: '2026-01-01T00:00:00.000Z' }]),
      ),
    );
    const p = new Permissions();
    await p.ready();
    return p;
  }

  it('a page with no site asks in both modes and cannot remember', async () => {
    const p = await permissions();
    expect(p.decide('auto', question(''))).toEqual({ decision: 'ask', canRemember: false });
    expect(p.decide('ask', question(''))).toEqual({ decision: 'ask', canRemember: false });
  });

  it('without a rule, Ask asks and Auto runs', async () => {
    const p = await permissions();
    expect(p.decide('ask', question('shop.example'))).toEqual({ decision: 'ask', by: 'auto', canRemember: true });
    expect(p.decide('auto', question('shop.example'))).toEqual({ decision: 'run', by: 'auto', canRemember: true });
  });

  it('a site set to Ask asks in Auto mode too, and offers no Always allow', async () => {
    const p = await permissions({ 'shop.example': 'ask' });
    expect(p.decide('auto', question('shop.example'))).toEqual({
      decision: 'ask',
      by: 'site-rule',
      canRemember: false,
    });
  });

  it('a site set to Allow runs in Ask mode', async () => {
    const p = await permissions({ 'shop.example': 'allow' });
    expect(p.decide('ask', question('shop.example'))).toEqual({ decision: 'run', by: 'site-rule', canRemember: true });
    // Another site is not affected.
    expect(p.decide('ask', question('other.example')).decision).toBe('ask');
  });

  it('a Block rule is no write rule: the write follows the mode', async () => {
    const p = await permissions({ 'bank.example': 'block' });
    expect(p.decide('ask', question('bank.example')).decision).toBe('ask');
  });

  it('a mode that is not one of the two fails to ask', async () => {
    const p = await permissions();
    expect(p.decide('yolo' as never, question('shop.example')).decision).toBe('ask');
    expect(p.decide(undefined as never, question('shop.example')).decision).toBe('ask');
  });

  it('a prototype key is not a site', async () => {
    const p = await permissions({ 'shop.example': 'allow' });
    expect(p.decide('ask', question('__proto__')).decision).toBe('ask');
    expect(p.decide('ask', question('constructor')).decision).toBe('ask');
  });

  it('"Allow on this site" is remembered, and two together both stay', async () => {
    const p = await permissions();
    await Promise.all([p.allow('a.example'), p.allow('b.example')]);
    await p.ready();
    expect(p.decide('ask', question('a.example')).decision).toBe('run');
    expect(p.decide('ask', question('b.example')).decision).toBe('run');
  });
});

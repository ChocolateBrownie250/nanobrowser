import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TabScope } from '../bindings';

// panel.ts sets up the action button when it is imported.
vi.mock('../panel', () => ({ PANEL_PATH: 'sidepanel.html' }));

// A tab on a blocked site, or on a subdomain of one, is not shared with a conversation: the same rule the layer
// applies, so the user never sees a tab join a group that the agent then cannot use.

const group = vi.fn(async () => 1);
const tabs = new Map<number, { id: number; url: string; windowId: number }>();

beforeEach(() => {
  group.mockClear();
  tabs.clear();
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('chrome', {
    tabs: {
      onRemoved: event(),
      onActivated: event(),
      onUpdated: event(),
      get: async (id: number) => tabs.get(id),
      group,
    },
    storage: { session: { get: async () => ({}), set: async () => undefined } },
    sidePanel: { setOptions: async () => undefined },
  });
});

function scope(blocked: string[]) {
  return new TabScope({ blocked: () => blocked, changed: vi.fn() });
}

describe('TabScope.add and blocked sites', () => {
  it('refuses a tab on the blocked site and on its subdomains', async () => {
    const s = scope(['example.com']);
    tabs.set(1, { id: 1, url: 'https://example.com/a', windowId: 1 });
    tabs.set(2, { id: 2, url: 'https://mail.example.com/inbox', windowId: 1 });
    expect(await s.add('c1', 1, 'user')).toEqual({ ok: false, reason: 'blocked' });
    expect(await s.add('c1', 2, 'user')).toEqual({ ok: false, reason: 'blocked' });
    expect(group).not.toHaveBeenCalled();
  });

  it('shares a tab on a site that only looks like the blocked one', async () => {
    const s = scope(['example.com']);
    tabs.set(3, { id: 3, url: 'https://notexample.com/', windowId: 1 });
    expect(await s.add('c1', 3, 'user')).toEqual({ ok: true });
  });
});

// Layer 3 of the navigation policy must be on whenever a list is set, and a failure to switch it on must be visible:
// the tab is disconnected and the call fails, never a tab that looks guarded and is not. Also the scheme checks of
// layer 1 on the way into the browser (chrome:kill and its spellings send nothing).
import { describe, expect, it, vi } from 'vitest';
import { Controller } from '../controller';
import { NavigationGuard } from '../navigation-guard';
import type { CdpPort, DetachInfo, FrameEvent, TabAttachment, TabHost, TopologyPort } from '../ports';

interface FakeTab extends TabAttachment {
  sent: Array<{ method: string; params?: object }>;
  /** Make the next Fetch.enable fail this many times. */
  failFetchEnable: number;
  fireFrame(event: FrameEvent): void;
  emit(method: string, params: unknown): void;
  lose(info: DetachInfo): void;
}

/** An attachment that behaves like a real one: `close` detaches it and tells the detach handlers. */
function fakeTab(tabId: number): FakeTab {
  const sent: FakeTab['sent'] = [];
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  const frameHandlers = new Set<(event: FrameEvent) => void>();
  const detachHandlers = new Set<(info: DetachInfo) => void>();
  let detached: DetachInfo | null = null;
  const tab: FakeTab = {
    tabId,
    sent,
    failFetchEnable: 0,
    cdp: {
      tabId,
      async send<T>(_session: string | undefined, method: string, params?: object) {
        sent.push({ method, params });
        if (method === 'Fetch.enable' && tab.failFetchEnable > 0) {
          tab.failFetchEnable--;
          throw new Error('Fetch.enable: no answer within 5000 ms');
        }
        return {} as T;
      },
      on(method, handler) {
        const set = handlers.get(method) ?? new Set();
        handlers.set(method, set);
        const wrapped = (params: unknown) => handler(params, undefined);
        set.add(wrapped);
        return () => set.delete(wrapped);
      },
    } as CdpPort,
    topology: {
      mainFrameId: () => 'MAIN',
      frames: async () => [],
      onFrameEvent(handler) {
        frameHandlers.add(handler);
        return () => frameHandlers.delete(handler);
      },
    } as TopologyPort,
    page: {} as TabAttachment['page'],
    get detached() {
      return detached;
    },
    onDetach(handler) {
      detachHandlers.add(handler);
      return () => detachHandlers.delete(handler);
    },
    close: vi.fn(async () => tab.lose({ reason: 'closed_by_layer' })),
    fireFrame: event => frameHandlers.forEach(h => h(event)),
    emit: (method, params) => handlers.get(method)?.forEach(h => h(params)),
    lose(info) {
      if (detached) return;
      detached = info;
      detachHandlers.forEach(h => h(info));
    },
  };
  return tab;
}

const tabs = {
  onRemoved: () => () => undefined,
  onNavigationTarget: () => () => undefined,
  setDiscardable: async () => undefined,
  get: async (tabId: number) => ({ tabId, url: 'about:blank', title: '' }),
} as unknown as TabHost;

const epochStore = { read: async () => null, write: async () => undefined };
const methods = (tab: FakeTab) => tab.sent.map(s => s.method);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function setup(tab: FakeTab, attach?: () => Promise<TabAttachment>) {
  const attacher = { attach: vi.fn(attach ?? (async () => tab)) };
  const controller = await Controller.create({ attacher, tabs, epochStore });
  return { controller, attacher };
}

describe('layer 3 is switched on before a tab is handed out', () => {
  it('fails the attach when Fetch.enable fails, and tries again on the next one', async () => {
    const tab = fakeTab(7);
    tab.failFetchEnable = 1;
    const { controller } = await setup(tab);
    const session = controller.createSession({ urlPolicy: { allow: [], deny: ['denied.test'] } });
    session.shareTab(7);
    await expect(controller.attach(7)).rejects.toMatchObject({ code: 'DEBUGGER_DETACHED' });
    // Nothing was published for the half-guarded tab, and its connection was closed.
    expect(controller.tabState(7).attachment).toBeNull();
    expect(controller.tabState(7).guard).toBeNull();
    expect(tab.close).toHaveBeenCalledTimes(1);
  });

  it('does not report success on the second attach while layer 3 is still off', async () => {
    const tab = fakeTab(7);
    tab.failFetchEnable = 1;
    // The attacher hands out a fresh connection each time, as the real one does after a close.
    const second = fakeTab(7);
    const queue = [tab, second];
    const { controller, attacher } = await setup(tab, async () => queue.shift()!);
    const session = controller.createSession({ urlPolicy: { allow: [], deny: ['denied.test'] } });
    session.shareTab(7);
    await expect(controller.attach(7)).rejects.toThrow();
    const attachment = await controller.attach(7);
    expect(attachment).toBe(second);
    expect(attacher.attach).toHaveBeenCalledTimes(2);
    expect(controller.tabState(7).guard?.intercepting).toBe(true);
    expect(methods(second)).toContain('Fetch.enable');
  });

  it('retries on the fast path when the guard does not match the policy', async () => {
    const tab = fakeTab(7);
    const { controller } = await setup(tab);
    const session = controller.createSession();
    session.shareTab(7);
    await controller.attach(7);
    expect(controller.tabState(7).guard?.intercepting).toBe(false);
    // A policy set while the connection is up, with a guard that was not switched on (as after a lost command).
    tab.failFetchEnable = 1;
    await expect(session.setUrlPolicy({ allow: [], deny: ['denied.test'] })).rejects.toMatchObject({
      code: 'DEBUGGER_DETACHED',
    });
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(controller.tabState(7).attachment).toBeNull();
  });

  it('re-syncs on the fast path of an attach when layer 3 is off but a list is set', async () => {
    const tab = fakeTab(7);
    const { controller } = await setup(tab);
    const session = controller.createSession();
    session.shareTab(7);
    await controller.attach(7);
    // The tab stays connected (a close that does not take effect), so only the fast path can notice.
    tab.close = vi.fn(async () => undefined);
    tab.failFetchEnable = 1;
    await expect(session.setUrlPolicy({ allow: [], deny: ['denied.test'] })).rejects.toThrow();
    expect(controller.tabState(7).guard?.intercepting).toBe(false);
    await expect(controller.attach(7)).resolves.toBe(tab);
    expect(controller.tabState(7).guard?.intercepting).toBe(true);
    expect(methods(tab).filter(m => m === 'Fetch.enable')).toHaveLength(2);
  });

  it('turns layer 3 on for a tab already attached when a list is set', async () => {
    const tab = fakeTab(7);
    const { controller } = await setup(tab);
    const session = controller.createSession();
    session.shareTab(7);
    await controller.attach(7);
    await session.setUrlPolicy({ allow: [], deny: [], blocked: ['blocked.test'] });
    expect(controller.tabState(7).guard?.intercepting).toBe(true);
    await session.setUrlPolicy({ allow: [], deny: [], blocked: [] });
    expect(controller.tabState(7).guard?.intercepting).toBe(false);
    expect(methods(tab).filter(m => m.startsWith('Fetch.'))).toEqual(['Fetch.enable', 'Fetch.disable']);
  });

  it('applies a detach that arrives while layer 3 is being switched on', async () => {
    const tab = fakeTab(7);
    const original = tab.cdp.send.bind(tab.cdp);
    tab.cdp.send = (async (session: string | undefined, method: string, params?: object) => {
      if (method === 'Fetch.enable') tab.lose({ reason: 'canceled_by_user' });
      return original(session, method, params);
    }) as CdpPort['send'];
    const { controller } = await setup(tab);
    const session = controller.createSession({ urlPolicy: { allow: [], deny: ['denied.test'] } });
    session.shareTab(7);
    await expect(controller.attach(7)).rejects.toMatchObject({ code: 'DEBUGGER_DETACHED' });
    expect(controller.tabState(7).attachment).toBeNull();
    // The user's Cancel on the debugging bar still holds the tab until it is shared again.
    expect(controller.tabState(7).detachedByUser).toBe(true);
  });

  it('refuses a connection that was closed after another attach shared it', async () => {
    const closed = fakeTab(7);
    closed.lose({ reason: 'closed_by_layer' });
    const fresh = fakeTab(7);
    const queue = [closed, fresh];
    const { controller } = await setup(fresh, async () => queue.shift()!);
    controller.createSession().shareTab(7);
    await expect(controller.attach(7)).rejects.toMatchObject({ code: 'DEBUGGER_DETACHED' });
    await expect(controller.attach(7)).resolves.toBe(fresh);
  });
});

describe('NavigationGuard.sync', () => {
  function guardOn(tab: FakeTab, lists: { value: boolean }) {
    return new NavigationGuard(
      tab,
      () => true,
      () => lists.value,
    );
  }

  it('runs one call after the other', async () => {
    const tab = fakeTab(1);
    const lists = { value: true };
    const gate: { release: () => void } = { release: () => undefined };
    const original = tab.cdp.send.bind(tab.cdp);
    const started: string[] = [];
    tab.cdp.send = (async (session: string | undefined, method: string, params?: object) => {
      started.push(method);
      if (method === 'Fetch.enable') await new Promise<void>(resolve => (gate.release = resolve));
      return original(session, method, params);
    }) as CdpPort['send'];
    const guard = guardOn(tab, lists);
    const first = guard.sync();
    await flush();
    lists.value = false;
    const second = guard.sync();
    await flush();
    // The second call waits for the first: no Fetch.disable can overtake the Fetch.enable it undoes.
    expect(started).toEqual(['Fetch.enable']);
    gate.release();
    await Promise.all([first, second]);
    expect(methods(tab)).toEqual(['Fetch.enable', 'Fetch.disable']);
    expect(guard.intercepting).toBe(false);
  });

  it('keeps going after a failed call, and rejects only the one that failed', async () => {
    const tab = fakeTab(1);
    tab.failFetchEnable = 1;
    const lists = { value: true };
    const guard = guardOn(tab, lists);
    await expect(guard.sync()).rejects.toThrow('no answer');
    expect(guard.intercepting).toBe(false);
    await guard.sync();
    expect(guard.intercepting).toBe(true);
  });

  it('fails a paused request when the main frame cannot be named', async () => {
    const tab = fakeTab(1);
    tab.topology.mainFrameId = () => {
      throw new Error('the frame accessors changed');
    };
    const guard = guardOn(tab, { value: true });
    await guard.sync();
    tab.emit('Fetch.requestPaused', {
      requestId: 'r1',
      request: { url: 'https://example.com/', method: 'GET' },
      frameId: 'MAIN',
      resourceType: 'Document',
    });
    await flush();
    expect(tab.sent.at(-1)).toMatchObject({ method: 'Fetch.failRequest', params: { requestId: 'r1' } });
  });

  it('leaves the blank page and the error page of a failed load alone, and replaces a browser page', async () => {
    const tab = fakeTab(1);
    const guard = new NavigationGuard(
      tab,
      url => url !== 'chrome://settings/',
      () => false,
    );
    for (const url of ['about:blank#blocked', 'chrome-error://chromewebcontrols/']) {
      tab.fireFrame({ type: 'navigated', frameId: 'MAIN', url });
    }
    await flush();
    expect(guard.drain()).toEqual([]);
    expect(methods(tab)).toEqual([]);
    tab.fireFrame({ type: 'navigated', frameId: 'MAIN', url: 'chrome://settings/' });
    await flush();
    expect(guard.drain()).toHaveLength(1);
    expect(tab.sent).toEqual([{ method: 'Page.navigate', params: { url: 'about:blank' } }]);
  });
});

describe('layer 1 refuses browser pages written the way Chrome reads them', () => {
  const spellings = [
    'chrome:kill',
    'chrome:/version',
    'Chrome:settings',
    'edge://settings',
    'view-source:https://x.test/',
  ];

  it.each(spellings)('navigate to %s sends nothing', async url => {
    const tab = fakeTab(7);
    const goto = vi.fn();
    (tab as { page: TabAttachment['page'] }).page = { goto } as unknown as TabAttachment['page'];
    const { controller } = await setup(tab);
    const session = controller.createSession({ observeDefault: 'none' });
    session.shareTab(7);
    const result = await session.call('navigate', { url, tabId: 7 });
    expect(result.error).toMatchObject({ code: 'URL_NOT_ALLOWED', delivered: false });
    expect(goto).not.toHaveBeenCalled();
    expect(tab.sent.filter(s => s.method === 'Page.navigate')).toEqual([]);
  });

  it.each(spellings)('tabs open %s opens no tab', async url => {
    const tab = fakeTab(7);
    const open = vi.fn(async () => ({ tabId: 8, url: 'about:blank', title: '' }));
    const { controller } = await setup(tab);
    controller.host.tabs.open = open as unknown as TabHost['open'];
    const session = controller.createSession({ observeDefault: 'none' });
    session.shareTab(7);
    const result = await session.call('tabs', { action: 'open', url });
    expect(result.error).toMatchObject({ code: 'URL_NOT_ALLOWED' });
    expect(open).not.toHaveBeenCalled();
  });
});

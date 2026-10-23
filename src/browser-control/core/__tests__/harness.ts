// A small harness for tool-level tests: a real Controller and Session over a fake host, a hand-made tab with a fake
// probe, and a ToolContext built by hand. The tools run unchanged; only the page is scripted.
import { vi } from 'vitest';
import { Controller } from '../controller';
import type { SessionConfig, TabState, ToolContext } from '../controller';
import type { ProbeClient } from '../probe-client';
import type { RefPrint } from '../refs';
import type { FormFacts, ProbeState } from '../../probe';
import type { CdpPort, FrameRecord, PagePort, TabAttachment, TabHost, UserPrompt } from '../ports';

export const TAB_ID = 7;

export const MAIN_FRAME: FrameRecord = {
  frameId: 'main',
  parentFrameId: undefined,
  sessionId: undefined,
  loaderId: 'L1',
  url: 'https://shop.test/account',
  depth: 0,
  adFrame: false,
};

/** Probe methods by name; a method that is not scripted throws, so a test never passes by accident. */
export type FakeProbe = Record<string, (...args: unknown[]) => unknown>;

export interface Harness {
  controller: Controller;
  ctx: ToolContext;
  tab: TabState;
  /** The calls the fake probe received: [method, ...args]. */
  calls: unknown[][];
  /** Commands sent to CDP: [method, params]. */
  cdp: Array<[string, unknown]>;
  attachment: TabAttachment;
}

export interface HarnessOptions {
  config?: SessionConfig;
  prompt?: UserPrompt;
  probe?: FakeProbe;
  /** The page's key port (default: none, so a test that presses keys gives one). */
  page?: Partial<PagePort>;
  signal?: AbortSignal;
  url?: string;
  frames?: FrameRecord[];
  /** How the fake CDP answers a command (default: an empty result). */
  cdpReply?: (method: string, params: unknown) => unknown;
}

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const cdpLog: Array<[string, unknown]> = [];
  const calls: unknown[][] = [];
  const frames = options.frames ?? [MAIN_FRAME];
  const cdp: CdpPort = {
    tabId: TAB_ID,
    send: vi.fn(async (_session: unknown, method: string, params?: unknown) => {
      cdpLog.push([method, params]);
      return options.cdpReply ? options.cdpReply(method, params) : {};
    }) as unknown as CdpPort['send'],
    on: vi.fn(() => () => undefined),
  };
  const attachment: TabAttachment = {
    tabId: TAB_ID,
    cdp,
    topology: { mainFrameId: () => frames[0].frameId, frames: async () => frames, onFrameEvent: () => () => undefined },
    page: (options.page ?? {}) as TabAttachment['page'],
    detached: null,
    onDetach: () => () => undefined,
    close: async () => undefined,
  };
  const tabs = {
    onRemoved: () => () => undefined,
    onCreated: () => () => undefined,
    onNavigationTarget: () => () => undefined,
    get: async () => ({ tabId: TAB_ID, url: options.url ?? MAIN_FRAME.url, title: 'Test' }),
  } as unknown as TabHost;
  const controller = await Controller.create({
    attacher: { attach: async () => attachment },
    tabs,
    epochStore: { read: async () => null, write: async () => undefined },
    prompt: options.prompt,
  });
  const session = controller.createSession(options.config);
  session.shareTab(TAB_ID);
  const tab = controller.tabState(TAB_ID);
  tab.attachment = attachment;
  const probe = options.probe ?? {};
  tab.probe = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === 'call' || name === 'callForNode' || name === 'callGlobal') {
          return async (...args: unknown[]) => {
            // call(frame, objectId, method, ...args), callForNode(frame, objectId, method), callGlobal(frame, method, ...args)
            const [method, ...rest] = name === 'callGlobal' ? args.slice(1) : args.slice(2);
            calls.push([method as string, ...rest]);
            const fn = probe[method as string];
            if (!fn) throw new Error(`fake probe: ${String(method)} is not scripted`);
            return fn(...rest);
          };
        }
        // Never thenable: the proxy may be awaited or returned from an async function.
        if (name === 'then') return undefined;
        if (name === 'release') return async () => undefined;
        if (name === 'resolve') return async () => 'obj';
        return async () => {
          throw new Error(`fake probe: ${name} is not scripted`);
        };
      },
    },
  ) as unknown as ProbeClient;
  const ctx: ToolContext = {
    controller,
    session,
    tabId: TAB_ID,
    tab: () => tab,
    attach: async () => attachment,
    signal: options.signal,
  };
  return { controller, ctx, tab, calls, cdp: cdpLog, attachment };
}

// ---------------------------------------------------------------------------------------------------------------
// A scripted page for the tools that act on an element: defaults for every probe and CDP call the action pipeline
// makes (state, quads, hit test, guards, evidence), so a test overrides only what it is about.

export const PLAIN_FACTS: FormFacts = {
  tag: 'div',
  type: '',
  classes: '',
  isLink: false,
  submitter: false,
  field: false,
  form: null,
  money: '',
  textEntry: false,
  searchField: false,
};

export const PLAIN_STATE: ProbeState = {
  connected: true,
  tag: 'div',
  type: '',
  role: '',
  visible: true,
  enabled: true,
  editable: false,
  contentEditable: false,
  checked: null,
  value: null,
  inShadow: false,
  autocomplete: '',
  name: '',
  id: '',
  placeholder: '',
  multiple: false,
  focused: false,
};

/** Probe defaults for an element on a quiet page; `over` replaces any of them. */
export function pageProbe(over: FakeProbe = {}): FakeProbe {
  return {
    state: () => PLAIN_STATE,
    textDigest: () => '',
    formFacts: () => PLAIN_FACTS,
    navigationTarget: () => null,
    hitAccepts: () => ({ accepted: true, kind: 'inside' }),
    viewport: () => ({ width: 1000, height: 800 }),
    armGuard: () => undefined,
    armAncestorGuard: () => undefined,
    armAwayGuard: () => undefined,
    armDocumentGuard: () => undefined,
    armBlockGuard: () => undefined,
    renewGuard: () => true,
    disarm: () => undefined,
    stepGuard: () => ({ verdict: 'passed', hit: '', seen: [], accepted: 0, armed: true, focusOk: true, focus: 'x' }),
    readGuard: () => ({ verdict: 'passed', hit: '', seen: [], accepted: 1 }),
    watchBlock: () => '',
    blockMutations: () => 0,
    mutations: () => 0,
    pageFacts: () => ({ alerts: [], invalid: [], layers: [] }),
    ...over,
  };
}

/** How the fake CDP answers: one box on the page, a hit test that lands on `hit`, a quiet viewport. */
export function pageCdp(hit = 50): (method: string, params: unknown) => unknown {
  return method => {
    switch (method) {
      case 'DOM.getContentQuads':
        return { quads: [[10, 10, 110, 10, 110, 40, 10, 40]] };
      case 'Page.getLayoutMetrics':
        return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 800 } };
      case 'DOM.getNodeForLocation':
        return { backendNodeId: hit, frameId: MAIN_FRAME.frameId };
      default:
        return {};
    }
  };
}

/**
 * Registers an element the session was shown (a layout-sourced ref, so revalidation reads only the probe) and returns
 * its ref. `tag` and `text` must equal what the probe's `state` and `textDigest` answer.
 */
export function showElement(
  h: Harness,
  print: Pick<RefPrint, 'role' | 'name'> & Partial<RefPrint>,
  backendNodeId = 50,
): string {
  const full: RefPrint = { tag: 'div', text: '', nth: null, context: null, ...print };
  const record = h.controller.registry.assign(
    {
      tabId: TAB_ID,
      sessionId: MAIN_FRAME.sessionId,
      frameId: MAIN_FRAME.frameId,
      loaderId: MAIN_FRAME.loaderId,
      backendNodeId,
    },
    'layout',
    full,
  );
  h.ctx.session.known.add(TAB_ID, [[record.ref, { source: 'layout', print: full }]]);
  return record.ref;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// The RunManager with its edges faked: a fake chrome, fake-indexeddb for the stores (real), a scripted loop standing in
// for the model, and a fake layer session. What runs for real is the run manager itself, the prompt broker, the tab
// scope, the journal and the stores, so the tests go through the order of writes a live run makes.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { EMPTY_GUARDS, ZERO_USAGE } from '@src/store/types';
import type { RunRecord } from '@src/store/types';
import type { PanelEvent } from '@src/ui/protocol';
import type * as Loop from '@src/agent/loop';
import type * as Records from '@src/agent/records';
import type * as Conversations from '@src/store/conversations';
import type { PanelConnection, RunManager } from '../run-manager';

const h = vi.hoisted(() => ({
  /** What the fake loop does in a run; it gets the loop's options. */
  script: (async () => undefined) as unknown as (options: any, loop: any) => Promise<unknown>,
  /** Resolves a model; a test makes it slow. */
  resolveModel: (async () => undefined) as unknown as (pair: unknown) => Promise<unknown>,
  loops: [] as any[],
  sessions: [] as any[],
  ended: [] as any[],
}));

vi.mock('../layer', () => ({
  controllerReady: Promise.resolve({ closeSession: async () => undefined }),
  addPromptRoute: () => undefined,
}));
vi.mock('../border', () => ({
  PageBorder: class {
    async start() {}
    async tabsChanged() {}
    async status() {}
  },
  injectBorder: () => undefined,
  listenForBorder: () => undefined,
}));
vi.mock('../agent-session', () => ({
  createAgentSession: (_controller: unknown, options: any) => {
    const tabs = new Set<number>();
    const session = {
      options,
      hasTab: (id: number) => tabs.has(id),
      tabIds: () => [...tabs],
      share: async (id: number) => void tabs.add(id),
      shareTab: (id: number) => void tabs.add(id),
      unshareTab: async (id: number) => void tabs.delete(id),
      setUrlPolicy: async () => undefined,
      controller: { setFileChooserInterception: async () => undefined, tabState: () => ({ pending: [] }) },
      call: async () => ({ ok: true, text: 'snapshot' }),
    };
    h.sessions.push(session);
    return session;
  },
  layerPort: () => ({}),
}));
vi.mock('../analytics', () => ({
  count: async () => undefined,
  deleteKeepingChoices: async (remove: () => Promise<void>) => remove(),
  noteActivity: () => undefined,
  observe: () => undefined,
  runEnded: (record: unknown) => void h.ended.push(record),
  runModel: async () => ({ provider: 'openai', modelRow: 'test' }),
  runStarted: () => undefined,
}));
vi.mock('../notify', () => ({ notifyFinished: async () => undefined, notifyNeeds: async () => undefined }));
vi.mock('../panel', () => ({ PANEL_PATH: 'sidepanel.html', openPanel: () => undefined }));
vi.mock('../thumbnail', () => ({ thumbnail: async () => undefined }));
vi.mock('../models', () => {
  const live = new Map<string, unknown>();
  return {
    livePair: async () => ({ model: { providerId: 'p', model: 'm' }, reasoning: 'medium' }),
    resolveModel: (pair: unknown) => h.resolveModel(pair),
    ModelUnavailable: class extends Error {},
    loadLive: async (id: string) => live.get(id),
    saveLive: async (id: string, pair: unknown) => void live.set(id, pair),
    dropLive: async (id: string) => void live.delete(id),
  };
});
vi.mock('@src/agent/loop', async importActual => {
  const actual = await importActual<typeof Loop>();
  class FakeLoop {
    debt: unknown[] = [];
    guards = { state: { errorsInRow: 0 } };
    hasSteering = () => false;
    compactionPending = false;
    constructor(readonly options: any) {
      h.loops.push(this);
    }
    requestCompaction() {}
    run() {
      return h.script(this.options, this);
    }
  }
  return { ...actual, AgentLoop: FakeLoop };
});

const MODEL = { profile: { vision: false }, ref: { providerId: 'p', model: 'm' }, reasoning: 'medium' };
const DONE = { status: 'done', outcome: 'success', usage: ZERO_USAGE, turns: 1 };

/** A chrome with the parts the run manager touches. */
function installChrome(options: { sessionFails?: () => boolean } = {}) {
  const area = (data: Record<string, unknown>, fails?: () => boolean) => ({
    get: async (keys: string | string[] | null) => {
      if (keys === null) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : keys;
      return structuredClone(Object.fromEntries(list.filter(k => k in data).map(k => [k, data[k]])));
    },
    set: async (items: Record<string, unknown>) => {
      if (fails?.()) throw new Error('QUOTA_BYTES quota exceeded');
      Object.assign(data, structuredClone(items));
    },
    remove: async (key: string) => void delete data[key],
    onChanged: { addListener: () => undefined },
  });
  const event = () => {
    const listeners: Array<(...args: any[]) => void> = [];
    return { addListener: (l: (...args: any[]) => void) => listeners.push(l), listeners };
  };
  const tabs = new Map<number, object>([
    [1, { id: 1, windowId: 1, url: 'https://example.com/', title: 'Example', active: true }],
  ]);
  const fake = {
    runtime: { id: 'me', getURL: (p: string) => p },
    storage: { local: area({}), session: area({}, options.sessionFails) },
    tabs: {
      onRemoved: event(),
      onActivated: event(),
      onUpdated: event(),
      get: async (id: number) => tabs.get(id) ?? Promise.reject(new Error('No tab')),
      query: async () => [],
      group: async () => 5,
      ungroup: async () => undefined,
      move: async () => undefined,
      update: async () => undefined,
      remove: async () => undefined,
    },
    debugger: { onDetach: event() },
    sidePanel: { setOptions: async () => undefined },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
    alarms: { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) },
    permissions: { contains: async () => false },
  };
  vi.stubGlobal('chrome', fake);
  return fake;
}

// Modules are loaded afresh for each test (the tab scope keeps a cache of its own), so the stores come from here.
let s: typeof Conversations;
let records: typeof Records;
const activeBranchLength = async (id: string) => (await s.activeBranch(id)).length;

let fake: ReturnType<typeof installChrome>;
const managers: RunManager[] = [];
let events: PanelEvent[];
let connection: PanelConnection;

async function newManager() {
  const { RunManager } = await import('../run-manager');
  const manager = new RunManager();
  events = [];
  connection = { tabId: null, conversationId: null, sink: e => events.push(e) };
  manager.connections.add(connection);
  managers.push(manager);
  return manager;
}

beforeEach(async () => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  s = await import('@src/store/conversations');
  records = await import('@src/agent/records');
  h.loops.length = 0;
  h.sessions.length = 0;
  h.ended.length = 0;
  h.resolveModel = async () => MODEL;
  h.script = async () => DONE;
  fake = installChrome();
});
afterEach(async () => {
  // Let the runs of the test end before the fake chrome goes away.
  for (const manager of managers.splice(0))
    for (const c of await s.listConversations())
      await until(
        () => manager.isRunning(c.id),
        r => !r,
        'run settles',
      );
  await new Promise(r => setTimeout(r, 20));
  vi.unstubAllGlobals();
});

async function until<T>(
  read: () => Promise<T> | T,
  ok: (value: T) => boolean = Boolean,
  what = 'condition',
): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`timed out: ${what}: ${JSON.stringify(await read())}`);
}

const send = (conversationId: string | null, text = 'go', mode: 'ask' | 'auto' = 'ask') => ({
  type: 'send' as const,
  tabId: 1,
  conversationId,
  text,
  attachments: [],
  context: [],
  mode,
  model: null,
  reasoning: 'medium' as never,
});

/** A gate a script waits at until the test lets it go. */
function gate() {
  let open: () => void = () => undefined;
  const wait = new Promise<void>(resolve => (open = resolve));
  return { wait, open };
}

describe('the run record under a live run', () => {
  it('keeps what the loop wrote, the queue and the card when the status changes (hand-over)', async () => {
    const manager = await newManager();
    const gateOpen = gate();
    let calls = 0;
    h.script = async (options: any) => {
      if (++calls > 1) return DONE;
      const writer = new records.RunWriter(options.conversationId, options.runId);
      // The loop's order: progress, the hand-over's own record, then the card.
      await writer.run({ turns: 4, debt: [{ toolCallId: 'x' } as never] });
      const details = { reason: 'pay', target: 'button', site: 'example.com' };
      await writer.run({
        pendingPrompt: {
          kind: 'handover',
          request: { details, tabId: 1 },
          openedAt: new Date().toISOString(),
          answers: { toolCallId: 'f', partialResult: { ok: false } },
        },
      });
      const answer = await options.host.handover({ toolCallId: 'f', tabId: 1, details, partial: {} }, options.signal);
      await writer.run({ pendingPrompt: undefined });
      await gateOpen.wait;
      return { ...DONE, turns: answer === 'given-back' ? 5 : 0 };
    };
    await manager.handle(connection, send(null));
    const conversationId = (await until(() => connection.conversationId))!;
    await until(
      () => s.getRun(conversationId),
      r => r?.status === 'awaiting_user',
      'awaiting_user',
    );
    await manager.handle(connection, {
      type: 'queue',
      conversationId,
      id: 'q1',
      text: 'later',
      attachments: [],
      context: [],
    });
    await until(
      () => s.getRun(conversationId),
      r => r?.steering.length === 1,
      'queue stored',
    );
    const stored = (await s.getRun(conversationId))!;
    expect(stored.status).toBe('awaiting_user');
    expect(stored.pendingPrompt?.kind).toBe('handover');
    expect(stored.pendingPrompt?.answers?.toolCallId).toBe('f');
    expect(stored.turns).toBe(4);
    expect(stored.debt).toHaveLength(1);
    expect(stored.steering.map(q => q.text)).toEqual(['later']);

    // The card is answered: the status goes back to running, and still nothing is lost.
    await manager.handle(connection, { type: 'unqueue', conversationId, id: 'q1' });
    const card = manager.broker.promptsOf(conversationId)[0];
    await manager.broker.answer(card.id, 'given-back');
    await until(
      () => s.getRun(conversationId),
      r => r?.status === 'running' && r.pendingPrompt === undefined,
      'running',
    );
    const back = (await s.getRun(conversationId))!;
    expect(back.turns).toBe(4);
    expect(back.debt).toHaveLength(1);
    expect(back.steering).toEqual([]);

    gateOpen.open();
    await until(
      () => manager.isRunning(conversationId),
      running => !running,
      'run ends',
    );
    const end = (await s.getRun(conversationId))!;
    expect(end).toMatchObject({ status: 'done', outcome: 'success', turns: 5 });
    expect(end.model).toEqual({ provider: 'openai', modelRow: 'test' });
  });

  it('keeps a write card in the record while the run waits on it', async () => {
    const manager = await newManager();
    const gateOpen = gate();
    let answer: unknown;
    h.script = async (options: any) => {
      const writer = new records.RunWriter(options.conversationId, options.runId);
      await writer.run({ turns: 2 });
      answer = await manager.broker.userPrompt().confirm(
        {
          id: 'w',
          tabId: 1,
          category: 'submit',
          action: 'click',
          target: 'button «Send»',
          origin: '',
          site: 'example.com',
          reason: 'it submits',
          canRemember: true,
        } as never,
        options.signal,
      );
      await gateOpen.wait;
      return DONE;
    };
    await manager.handle(connection, send(null));
    const conversationId = (await until(() => connection.conversationId))!;
    const waiting = await until(
      () => s.getRun(conversationId),
      r => r?.status === 'awaiting_user' && !!r.pendingPrompt,
      'card stored',
    );
    expect(waiting!.pendingPrompt?.kind).toBe('write-card');
    expect(waiting!.turns).toBe(2);
    const card = manager.broker.promptsOf(conversationId)[0];
    await manager.broker.answer(card.id, 'approve');
    const running = await until(
      () => s.getRun(conversationId),
      r => r?.status === 'running' && !r.pendingPrompt,
      'card cleared',
    );
    expect(running!.turns).toBe(2);
    gateOpen.open();
    await until(
      () => manager.isRunning(conversationId),
      r => !r,
      'run ends',
    );
    expect(answer).toBe('approve');
  });
});

describe('one run per conversation', () => {
  it('two sends started together make one run', async () => {
    const manager = await newManager();
    const conversation = await s.createConversation({ mode: 'ask', tabs: [1] });
    await manager.scope.add(conversation.id, 1, 'start');
    const gateOpen = gate();
    h.script = async () => {
      await gateOpen.wait;
      // The run read both messages and answered them, as the loop does at its next turn.
      await new records.RunWriter(conversation.id, 'x').message({
        role: 'assistant',
        parts: [{ type: 'text', text: 'Both done.' }],
      });
      return DONE;
    };
    const second: PanelConnection = { tabId: null, conversationId: null, sink: () => undefined };
    await Promise.all([
      manager.handle(connection, send(conversation.id, 'first')),
      manager.handle(second, send(conversation.id, 'second')),
    ]);
    await until(
      () => h.loops.length,
      n => n >= 1,
      'a loop',
    );
    await new Promise(r => setTimeout(r, 30));
    expect(h.loops).toHaveLength(1);
    gateOpen.open();
    await until(
      () => manager.isRunning(conversation.id),
      r => !r,
      'run ends',
    );
    expect(h.loops).toHaveLength(1);
    expect((await s.getRun(conversation.id))?.status).toBe('done');
  });
});

describe('files sent with a message', () => {
  it('says so when a file is no longer in the store, and still sends the text', async () => {
    const manager = await newManager();
    const conversation = await s.createConversation({ mode: 'ask', tabs: [1] });
    await manager.scope.add(conversation.id, 1, 'start');
    await manager.handle(connection, {
      ...send(conversation.id, 'read the notes'),
      attachments: [{ id: 'gone', name: 'notes.txt', mimeType: 'text/plain', size: 5 }],
    });
    await until(
      () => manager.isRunning(conversation.id),
      r => !r,
      'run ends',
    );
    const notices = (await s.activeBranch(conversation.id)).flatMap(e =>
      e.type === 'ui' && e.kind === 'notice' ? [(e.data as { text: string }).text] : [],
    );
    expect(notices.some(t => t.includes('notes.txt') && t.includes('no longer available'))).toBe(true);
  });

  it('says so, and sends nothing, when the only file is gone', async () => {
    const manager = await newManager();
    const conversation = await s.createConversation({ mode: 'ask', tabs: [1] });
    await manager.scope.add(conversation.id, 1, 'start');
    await manager.handle(connection, {
      ...send(conversation.id, ''),
      attachments: [{ id: 'gone', name: 'notes.txt', mimeType: 'text/plain', size: 5 }],
    });
    const notices = (await s.activeBranch(conversation.id)).flatMap(e =>
      e.type === 'ui' && e.kind === 'notice' ? [(e.data as { text: string }).text] : [],
    );
    expect(notices.some(t => t.includes('notes.txt'))).toBe(true);
    expect(h.loops).toHaveLength(0);
  });
});

describe('a message that lost the race to start a run', () => {
  it('is answered by a run of its own when the winning run ended without reading it', async () => {
    const manager = await newManager();
    const conversation = await s.createConversation({ mode: 'ask', tabs: [1] });
    await manager.scope.add(conversation.id, 1, 'start');
    const gateOpen = gate();
    let runs = 0;
    h.script = async () => {
      runs += 1;
      if (runs === 1) await gateOpen.wait;
      // The first run ends on its last turn without a reply to the second message; the second run answers it.
      if (runs === 2) {
        await new records.RunWriter(conversation.id, 'x').message({
          role: 'assistant',
          parts: [{ type: 'text', text: 'Answered.' }],
        });
      }
      return DONE;
    };
    const second: PanelConnection = { tabId: null, conversationId: null, sink: () => undefined };
    await Promise.all([
      manager.handle(connection, send(conversation.id, 'first')),
      manager.handle(second, send(conversation.id, 'second')),
    ]);
    await until(
      () => h.loops.length,
      n => n >= 1,
      'a loop',
    );
    gateOpen.open();
    await until(
      () => h.loops.length,
      n => n === 2,
      'a second loop for the unanswered message',
    );
    await until(
      () => manager.isRunning(conversation.id),
      r => !r,
      'runs end',
    );
    expect(h.loops).toHaveLength(2);
  });
});

describe('the mode of a run that is starting', () => {
  it('follows a change made while the model resolves, and is forgotten when the run ends', async () => {
    const manager = await newManager();
    const conversation = await s.createConversation({ mode: 'auto', tabs: [1] });
    await manager.scope.add(conversation.id, 1, 'start');
    const slow = gate();
    h.resolveModel = async () => {
      await slow.wait;
      return MODEL;
    };
    await manager.handle(connection, send(conversation.id, 'go', 'auto'));
    await until(
      () => s.getRun(conversation.id),
      r => r?.status === 'running',
      'run started',
    );
    // The user flips the mode to Ask while the model resolves.
    await manager.handle(connection, { type: 'set-mode', conversationId: conversation.id, mode: 'ask' });
    slow.open();
    await until(
      () => h.sessions.length,
      n => n === 1,
      'session',
    );
    const question = { category: 'submit' as const, site: 'example.com', tabId: 1 };
    expect(h.sessions[0].options.decideWrite(question)).toMatchObject({ decision: 'ask' });
    await until(
      () => manager.isRunning(conversation.id),
      r => !r,
      'run ends',
    );
    // Auto again, then the run ended: nothing stays behind that could run a write for a later session.
    await manager.handle(connection, { type: 'set-mode', conversationId: conversation.id, mode: 'auto' });
    expect(h.sessions[0].options.decideWrite(question)).toMatchObject({ decision: 'ask' });
  });

  it('applies the mode the run starts with (auto runs writes)', async () => {
    const manager = await newManager();
    const conversation = await s.createConversation({ mode: 'auto', tabs: [1] });
    await manager.scope.add(conversation.id, 1, 'start');
    const gateOpen = gate();
    h.script = async () => {
      await gateOpen.wait;
      return DONE;
    };
    await manager.handle(connection, send(conversation.id, 'go', 'auto'));
    await until(
      () => h.sessions.length,
      n => n === 1,
      'session',
    );
    expect(h.sessions[0].options.decideWrite({ category: 'submit', site: 'example.com', tabId: 1 })).toMatchObject({
      decision: 'run',
    });
    gateOpen.open();
    await until(
      () => manager.isRunning(conversation.id),
      r => !r,
      'run ends',
    );
  });
});

/** A stored run cut off by a worker stop, with the conversation it belongs to. */
async function seedRun(patch: Partial<RunRecord>, options: { ask?: boolean; tabId?: number } = {}) {
  const tabId = options.tabId ?? 1;
  const conversation = await s.createConversation({ mode: 'ask', title: 'Pay', tabs: [tabId] });
  await s.appendEntry(conversation.id, {
    type: 'message',
    message: { role: 'user', parts: [{ type: 'text', text: 'Do it' }] },
  });
  const call = options.ask
    ? { type: 'tool-call' as const, toolCallId: 'f', toolName: 'ask_user', input: { message: 'solve' } }
    : { type: 'tool-call' as const, toolCallId: 'f', toolName: 'fill_form', input: { fields: [] } };
  await s.appendEntry(conversation.id, { type: 'message', message: { role: 'assistant', parts: [call] } });
  await s.appendEntry(conversation.id, { type: 'intent', toolCallId: 'f', tool: call.toolName, args: {} });
  const at = '2026-01-01T00:00:00.000Z';
  const record: RunRecord = {
    conversationId: conversation.id,
    runId: 'before-restart',
    leafEntryId: null,
    status: 'running',
    steering: [],
    turns: 3,
    usage: ZERO_USAGE,
    debt: [],
    guards: EMPTY_GUARDS,
    tabs: [tabId],
    startedAt: at,
    updatedAt: at,
    ...patch,
  };
  await s.putRun(record);
  return { conversation, record };
}

const handoverPrompt = (tabId = 1) => ({
  kind: 'handover' as const,
  request: { details: { reason: 'pay', target: 'button', site: 'example.com' }, tabId },
  openedAt: '2026-01-01T00:00:00.000Z',
  answers: { toolCallId: 'f', partialResult: { ok: false, data: { receipts: [{}, {}] } } },
});

describe('restore', () => {
  it('Stop on a restored hand-over card ends the run as stopped', async () => {
    const manager = await newManager();
    const { conversation } = await seedRun({ status: 'awaiting_user', pendingPrompt: handoverPrompt() });
    await manager.handle(connection, { type: 'subscribe', tabId: 1, conversationId: conversation.id });
    await manager.restore();
    await until(
      () => manager.broker.promptsOf(conversation.id).length,
      n => n === 1,
      'card reopened',
    );
    expect((await s.getRun(conversation.id))?.status).toBe('awaiting_user');
    await manager.handle(connection, { type: 'stop', conversationId: conversation.id });
    const run = await until(
      () => s.getRun(conversation.id),
      r => r?.status === 'stopped',
      'stopped',
    );
    expect(run!.pendingPrompt).toBeUndefined();
    expect((await s.getConversation(conversation.id))?.status).toBe('stopped');
    expect(events.filter(e => e.type === 'run_status').at(-1)).toMatchObject({ status: 'stopped' });
    expect(manager.broker.promptsOf(conversation.id)).toEqual([]);
    // The call has its result, and the alarm is not kept for a run that ended.
    const results = (await s.activeBranch(conversation.id)).flatMap(e =>
      e.type === 'message' && e.message.role === 'tool' ? e.message.parts : [],
    );
    expect(results).toHaveLength(1);
    expect(fake.alarms.clear).toHaveBeenCalled();
  });

  it('Stop on a restored ask_user card ends the run as stopped', async () => {
    const manager = await newManager();
    const { conversation } = await seedRun(
      {
        status: 'awaiting_user',
        pendingPrompt: {
          kind: 'ask-user',
          request: { kind: 'takeover', message: 'solve it', site: 'example.com', tabId: 1 },
          openedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      { ask: true },
    );
    await manager.restore();
    await until(
      () => manager.broker.promptsOf(conversation.id).length,
      n => n === 1,
      'card reopened',
    );
    await manager.handle(connection, { type: 'stop', conversationId: conversation.id });
    await until(
      () => s.getRun(conversation.id),
      r => r?.status === 'stopped',
      'stopped',
    );
  });

  it('deleting a conversation whose restored card is open leaves no unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const manager = await newManager();
      const { conversation } = await seedRun({ status: 'awaiting_user', pendingPrompt: handoverPrompt() });
      await manager.handle(connection, { type: 'subscribe', tabId: 1, conversationId: conversation.id });
      await manager.restore();
      await until(
        () => manager.broker.promptsOf(conversation.id).length,
        n => n === 1,
        'card reopened',
      );
      await manager.handle(connection, { type: 'delete', conversationId: conversation.id });
      await new Promise(r => setTimeout(r, 50));
      expect(await s.getConversation(conversation.id)).toBeUndefined();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('a restored hand-over whose tab is gone ends interrupted, not stopped', async () => {
    const manager = await newManager();
    const { conversation } = await seedRun(
      { status: 'awaiting_user', pendingPrompt: handoverPrompt(99), tabs: [99] },
      { tabId: 99 },
    );
    await manager.restore();
    await until(
      () => manager.broker.promptsOf(conversation.id).length,
      n => n === 1,
      'card reopened',
    );
    await manager.handle(connection, { type: 'stop', conversationId: conversation.id });
    const run = await until(
      () => s.getRun(conversation.id),
      r => r?.status === 'interrupted' && r.reason?.includes('gone') === true,
      'interrupted',
    );
    expect(run!.pendingPrompt).toBeUndefined();
  });

  it('an interrupted run is left alone: no writes, no newer updatedAt, no alarm', async () => {
    const manager = await newManager();
    const { conversation } = await seedRun({
      status: 'interrupted',
      reason: 'The extension restarted during this run.',
      steering: [{ id: 'q', text: 'queued', attachments: [], at: '' }],
    });
    const before = (await s.getConversation(conversation.id))!;
    const stored = (await s.getRun(conversation.id))!;
    const entriesBefore = await activeBranchLength(conversation.id);
    await manager.restore();
    await manager.restore();
    const after = (await s.getConversation(conversation.id))!;
    expect(after.updatedAt).toBe(before.updatedAt);
    expect((await s.getRun(conversation.id))?.updatedAt).toBe(stored.updatedAt);
    expect(await activeBranchLength(conversation.id)).toBe(entriesBefore);
    expect(fake.alarms.create).not.toHaveBeenCalled();
    // Its queued message still goes back to the first panel that subscribes.
    await manager.handle(connection, { type: 'subscribe', tabId: 1, conversationId: conversation.id });
    const queue = events.find(e => e.type === 'queue') as Extract<PanelEvent, { type: 'queue' }> | undefined;
    expect(queue?.returned?.map(q => q.text)).toEqual(['queued']);
  });

  it('a running run becomes interrupted once, keeping the conversation’s place in Recent tasks', async () => {
    const manager = await newManager();
    const { conversation } = await seedRun({ status: 'running' });
    await manager.restore();
    expect((await s.getRun(conversation.id))?.status).toBe('interrupted');
    const mid = (await s.getConversation(conversation.id))!;
    expect(mid.status).toBe('interrupted');
    const stamp = (await s.getRun(conversation.id))!.updatedAt;
    const entries = await activeBranchLength(conversation.id);
    await manager.restore();
    // The second wake-up writes nothing: not the run, not the conversation, not another note.
    expect((await s.getRun(conversation.id))!.updatedAt).toBe(stamp);
    expect((await s.getConversation(conversation.id))!.updatedAt).toBe(mid.updatedAt);
    expect(await activeBranchLength(conversation.id)).toBe(entries);
    expect(fake.alarms.create).not.toHaveBeenCalled();
    expect(h.ended).toHaveLength(1);
  });

  it('keeps the watchdog alarm while a run waits for the user', async () => {
    const manager = await newManager();
    await seedRun({ status: 'awaiting_user', pendingPrompt: handoverPrompt() });
    await manager.restore();
    expect(fake.alarms.create).toHaveBeenCalledWith('nb-watchdog', { periodInMinutes: 0.5 });
  });

  it('a panel that reconnects after the restore gets the interrupted status it missed', async () => {
    // The stored window of the panel's conversation ends at seq 105, as it was when the worker stopped.
    const manager = await newManager();
    const { conversation } = await seedRun({ status: 'running' });
    await fake.storage.session.set({
      [`nb.journal.${conversation.id}`]: {
        seq: 105,
        events: Array.from({ length: 3 }, (_, i) => ({
          type: 'turn_start',
          turn: i,
          seq: 103 + i,
          conversationId: conversation.id,
        })),
      },
    });
    await manager.restore();
    await manager.handle(connection, { type: 'subscribe', tabId: 1, conversationId: conversation.id, sinceSeq: 105 });
    const status = events.filter(e => e.type === 'run_status');
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ status: 'interrupted', seq: 106 });
    // A panel that already saw the status event is told nothing twice from the window, but is told the stored status.
    const later: PanelEvent[] = [];
    const other: PanelConnection = { tabId: null, conversationId: null, sink: e => later.push(e) };
    manager.connections.add(other);
    await manager.handle(other, { type: 'subscribe', tabId: 1, conversationId: conversation.id, sinceSeq: 106 });
    expect(later.filter(e => e.type === 'run_status')).toMatchObject([{ status: 'interrupted' }]);
  });
});

describe('cards and tabs', () => {
  it('a write card is withdrawn when its tab closes, and the call is declined', async () => {
    const manager = await newManager();
    const gateOpen = gate();
    let answer: unknown;
    h.script = async (options: any) => {
      answer = await manager.broker.userPrompt().confirm(
        {
          id: 'w',
          tabId: 1,
          category: 'submit',
          action: 'click',
          target: 'button',
          origin: '',
          site: 'example.com',
          reason: 'r',
          canRemember: true,
        } as never,
        options.signal,
      );
      await gateOpen.wait;
      return DONE;
    };
    await manager.handle(connection, send(null));
    const conversationId = (await until(() => connection.conversationId))!;
    await until(
      () => manager.broker.promptsOf(conversationId).length,
      n => n === 1,
      'card open',
    );
    // Chrome reports the tab closed.
    for (const listener of fake.tabs.onRemoved.listeners) listener(1, { windowId: 1, isWindowClosing: false });
    await until(
      () => answer,
      a => a !== undefined,
      'declined',
    );
    expect(answer).toBe('decline');
    expect(manager.broker.promptsOf(conversationId)).toEqual([]);
    gateOpen.open();
    await until(
      () => manager.isRunning(conversationId),
      r => !r,
      'run ends',
    );
  });

  it('a card is withdrawn when the debugger leaves its tab for any reason but the user’s cancel', async () => {
    const manager = await newManager();
    const conversationId = (await s.createConversation({ mode: 'ask', tabs: [1] })).id;
    const open = manager.broker.open<string>(conversationId, 'handover', {}, new AbortController().signal, {
      tabId: 1,
    });
    for (const listener of fake.debugger.onDetach.listeners) listener({ tabId: 1 }, 'target_closed');
    expect(await open).toBe('withdrawn');
  });

  it('the move-tab card ends when its panel’s connection closes', async () => {
    const manager = await newManager();
    const owner = await s.createConversation({ mode: 'ask', tabs: [1] });
    await manager.scope.add(owner.id, 1, 'start');
    const other = await s.createConversation({ mode: 'ask' });
    const closed = new AbortController();
    const panel: PanelConnection = { tabId: null, conversationId: null, sink: () => undefined, closed: closed.signal };
    const moving = manager.handle(panel, { type: 'share-tab', conversationId: other.id, tabId: 1 });
    await until(
      () => manager.broker.promptsOf(other.id).length,
      n => n === 1,
      'move-tab card',
    );
    closed.abort();
    await moving;
    expect(manager.broker.promptsOf(other.id)).toEqual([]);
    expect(await manager.scope.conversationOf(1)).toBe(owner.id);
  });

  it('a full storage.session does not stop a run from starting', async () => {
    fake = installChrome({ sessionFails: () => true });
    const manager = await newManager();
    h.script = async () => DONE;
    await manager.handle(connection, send(null));
    const conversationId = (await until(() => connection.conversationId))!;
    await until(
      () => s.getRun(conversationId),
      r => r?.status === 'done',
      'run done',
    );
    expect(await manager.scope.conversationOf(1)).toBe(conversationId);
  });
});

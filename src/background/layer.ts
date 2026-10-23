// The browser control layer in the test extension: one controller, one session for the test panel.
import { argsJsonSchema, releaseLeftoverDebuggerSessions } from '@src/browser-control';
import { controllerReady, setFallbackPrompt } from '@src/extension/layer';
import type { AuditEntry, Capability, ConfirmPolicy, Controller, Session, UrlPolicy } from '@src/browser-control';
import { emit, register } from './rpc';
import { panelPrompt } from './prompts';

export interface LayerState {
  epoch: { prefix: string; persisted: boolean };
  sessionId: string;
  tabs: number[];
  activeTabId: number | null;
  urlPolicy: UrlPolicy;
  confirmPolicy: ConfirmPolicy;
  capabilities: Capability[];
  promptAvailable: boolean;
}

let controller: Controller;
let session: Session;
const audit: AuditEntry[] = [];
/** The audit ring holds at most this many entries and this many characters of them, whichever is reached first. */
const AUDIT_MAX_ENTRIES = 500;
const AUDIT_MAX_CHARS = 1_000_000;
let auditChars = 0;
const auditSizes: number[] = [];

function keepAudit(entry: AuditEntry): void {
  let size = 0;
  try {
    size = JSON.stringify(entry).length;
  } catch {
    // An entry that cannot be measured counts as small; its arguments are redacted already.
  }
  audit.push(entry);
  auditSizes.push(size);
  auditChars += size;
  while (audit.length > AUDIT_MAX_ENTRIES || (auditChars > AUDIT_MAX_CHARS && audit.length > 1)) {
    audit.shift();
    auditChars -= auditSizes.shift() ?? 0;
  }
}

// Debugger sessions an earlier worker left on tabs are released now, and every attach waits for it. The listeners of
// chrome.debugger are registered here, synchronously at worker start.
void releaseLeftoverDebuggerSessions();

setFallbackPrompt(panelPrompt);

export const ready: Promise<void> = controllerReady.then(c => {
  controller = c;
  session = c.createSession();
  void chrome.storage.local.get('testPanel.urlPolicy').then(stored => {
    const policy = stored['testPanel.urlPolicy'] as UrlPolicy | undefined;
    if (policy) void session.setUrlPolicy(policy);
  });
  void chrome.storage.local.get(['testPanel.confirmPolicy', 'testPanel.capabilities']).then(stored => {
    const confirm = stored['testPanel.confirmPolicy'] as ConfirmPolicy | undefined;
    if (confirm) session.setConfirmPolicy(confirm);
    const capabilities = stored['testPanel.capabilities'] as Capability[] | undefined;
    if (capabilities) session.setCapabilities(capabilities);
  });
  c.onAudit(entry => {
    keepAudit(entry);
    emit('audit', entry);
  });
});

export async function layer(): Promise<{ controller: Controller; session: Session }> {
  await ready;
  return { controller, session };
}

export function state(): LayerState {
  return {
    epoch: controller.epoch,
    sessionId: session.id,
    tabs: session.tabIds(),
    activeTabId: session.activeTabId,
    urlPolicy: session.urlPolicy,
    confirmPolicy: session.confirmPolicy,
    capabilities: [...session.capabilities],
    promptAvailable: !!controller.host.prompt,
  };
}

register('layer.call', async params => {
  const { session } = await layer();
  const { tool, args } = params as { tool: string; args?: unknown };
  return session.call(tool, args ?? {});
});

register('layer.tools', async () => {
  const { session } = await layer();
  return session.listTools().map(spec => ({
    name: spec.name,
    description: spec.description,
    capability: spec.capability,
    readOnly: typeof spec.readOnly === 'boolean' ? spec.readOnly : 'depends',
    schema: argsJsonSchema(spec),
  }));
});

register('layer.state', async () => {
  await ready;
  return state();
});

// The user's allow and deny lists (Session tab). Not a protocol tool: the agent cannot change the policy.
register('layer.setPolicy', async params => {
  const { session } = await layer();
  await session.setUrlPolicy(params as UrlPolicy);
  await chrome.storage.local.set({ 'testPanel.urlPolicy': session.urlPolicy });
  return state();
});

// The user's confirmation policy and capabilities (Session tab); the agent cannot change them.
register('layer.setConfirmPolicy', async params => {
  const { session } = await layer();
  session.setConfirmPolicy((params as { policy: ConfirmPolicy }).policy);
  await chrome.storage.local.set({ 'testPanel.confirmPolicy': session.confirmPolicy });
  return state();
});

register('layer.setCapabilities', async params => {
  const { session } = await layer();
  session.setCapabilities((params as { capabilities: Capability[] }).capabilities);
  await chrome.storage.local.set({ 'testPanel.capabilities': [...session.capabilities] });
  return state();
});

register('layer.audit', async () => {
  await ready;
  return audit;
});

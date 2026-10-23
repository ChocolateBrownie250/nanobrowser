// Resolves a conversation's live model and effort to a callable model and its profile, from the stored providers and
// keys. The key leaves storage only to build the provider client.
import { createModel, detectContext, makePair, resolveProfile } from '@src/llm';
import {
  capabilityOf,
  findModel,
  getLive,
  keysStorage,
  learnFacts,
  learnt,
  LOCAL_KINDS,
  providersStorage,
  removeLive,
  setLive,
  settingsStorage,
  usableModel,
} from '@src/store/settings';
import type { LivePair } from '@src/store/types';
import type { ResolvedModel } from '@src/agent/run';

export class ModelUnavailable extends Error {}

/**
 * Pairs that storage.session refused (a full area), kept in memory so a run can still start with the model the user
 * picked. A pair that is stored again later replaces its entry.
 */
const unstored = new Map<string, LivePair>();

/** A conversation's live pair: the one kept in memory when storage refused it, else the stored one. */
export async function loadLive(conversationId: string): Promise<LivePair | undefined> {
  return unstored.get(conversationId) ?? (await getLive(conversationId));
}

/** Stores a live pair; a full storage area keeps it in memory instead of failing the caller. */
export async function saveLive(conversationId: string, pair: LivePair): Promise<void> {
  try {
    await setLive(conversationId, pair);
    unstored.delete(conversationId);
  } catch (error) {
    console.warn('[live] could not store the live pair; keeping it in memory', error);
    unstored.set(conversationId, pair);
  }
}

export async function dropLive(conversationId: string): Promise<void> {
  unstored.delete(conversationId);
  await removeLive(conversationId);
}

/**
 * The model and effort a run uses: the conversation's live pair, or one made from the settings when there is none. A
 * model no longer configured falls back as the panel's picker does, keeping the pair's effort. Null when no model is
 * configured. The key is read first, so a pair written after the call does not reach it.
 */
export async function livePair(conversationId: string | null): Promise<LivePair | null> {
  const [stored, settings, providers] = await Promise.all([
    conversationId ? loadLive(conversationId) : undefined,
    settingsStorage.get(),
    providersStorage.get(),
  ]);
  const model = usableModel(providers, stored?.model, settings.defaultModel);
  if (!model) return null;
  if (stored) return { model, reasoning: stored.reasoning };
  return makePair(model, settings.reasoning, capabilityOf(providers, model));
}

export async function resolveModel(pair: LivePair | null): Promise<ResolvedModel> {
  if (!pair) throw new ModelUnavailable('No model is chosen. Add one in Settings → Providers.');
  const ref = pair.model;
  const providers = await providersStorage.get();
  const found = findModel(providers, ref);
  if (!found) throw new ModelUnavailable(`The model ${ref.model} is no longer configured. Choose another one.`);
  if (found.model.noToolCalling) {
    throw new ModelUnavailable(`${ref.model} did not pass the tool-calling test and cannot run the agent.`);
  }
  const keys = await keysStorage.get();
  // Ollama and LM Studio are asked again at the start of each run: the window a server loads can change. A slow or
  // silent server keeps the value found before.
  let detectedContext = found.model.detectedContext;
  if (found.provider.kind === 'ollama' || found.provider.kind === 'lmstudio') {
    const spec = { kind: found.provider.kind, modelName: found.model.name, baseUrl: found.provider.baseUrl };
    const fresh = await Promise.race([
      detectContext(spec),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2_000)),
    ]);
    if (fresh && fresh !== detectedContext) {
      detectedContext = fresh;
      // Stored only while the provider still has the address that was asked: a change of address clears what was learnt
      // about the old server.
      await providersStorage.set(list =>
        list.map(p =>
          p.id === found.provider.id && (p.baseUrl ?? '') === (found.provider.baseUrl ?? '')
            ? { ...p, models: p.models.map(m => (m.name === found.model.name ? { ...m, detectedContext: fresh } : m)) }
            : p,
        ),
      );
    }
  }
  const profile = resolveProfile({
    kind: found.provider.kind,
    modelName: found.model.name,
    baseUrl: found.provider.baseUrl,
    overrides: found.model.overrides,
    detectedContext,
    ...learnt(found.model),
  });
  const chat = createModel({
    kind: found.provider.kind,
    modelName: found.model.name,
    apiKey: keys[found.provider.id],
    baseUrl: found.provider.baseUrl,
    maxOutputTokens: profile.maxOutput,
    // Ollama and LM Studio take one request at a time by default; more wait in the extension, not on the server.
    ...(LOCAL_KINDS.has(found.provider.kind) ? { maxConcurrent: 1 } : {}),
  });
  const learn = (facts: Parameters<NonNullable<ResolvedModel['learn']>>[0]) =>
    void learnFacts(found.provider.id, found.provider.baseUrl, found.model.name, facts);
  return { ref, chat, profile, reasoning: pair.reasoning, learn };
}

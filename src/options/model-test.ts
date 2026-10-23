// Testing one model, shared by Settings → Providers and the welcome page: the model's API first, then, for the whole
// test, the probes of Test models. What was learnt is stored on the model's entry, unless the provider's address
// changed meanwhile, since it describes the old server.
import { detectContext, isCloudEndpoint, probeAsk, readModelInfo, testConnection } from '@src/llm';
import type { ConnectionResult, LearntFacts } from '@src/llm';
import { providersStorage } from '@src/store/settings';
import type { ModelEntry, ProviderConfig } from '@src/store/settings';
import { t } from '@src/ui/i18n';

export interface ModelTest {
  /** Absent when only the API was read. */
  result?: ConnectionResult;
  /** `fromApi` is absent when the model's API gave no facts this time (it failed, or has none): the stored ones stay. */
  patch: Pick<ModelEntry, 'fromApi' | 'detectedContext' | 'noToolCalling'> & { tested?: Omit<LearntFacts, 'at'> };
}

/**
 * What to show when listing a provider's models failed: the server-setup fix when a local server refused the extension,
 * a plain line when the provider refused the key (401), else the provider's own reason.
 */
export function listProblem(error: unknown, local: boolean): { message: string; originRefused: boolean } {
  const e = error as Error & { status?: number; originRefused?: boolean };
  return { originRefused: !!e.originRefused && local, message: e.status === 401 ? t('models.keyRefused') : e.message };
}

/** Adding a model runs the whole test on a cloud endpoint, and reads only the API on a local one. */
export const wholeTestOnAdd = (provider: ProviderConfig) => isCloudEndpoint(provider.kind, provider.baseUrl);

/**
 * A refused key (401) in the words of the Providers page, whatever the provider's own body said: Z.ai's
 * `{ code, msg }`, for one, is not text to show.
 */
function withKeyText(result: ConnectionResult): ConnectionResult {
  return !result.ok && result.status === 401 ? { ...result, error: t('models.keyRefused') } : result;
}

export async function testModel(
  provider: ProviderConfig,
  modelName: string,
  apiKey: string,
  whole: boolean,
  signal?: AbortSignal,
): Promise<ModelTest> {
  const spec = { kind: provider.kind, modelName, apiKey, baseUrl: provider.baseUrl };
  const at = new Date().toISOString();
  const api = await readModelInfo(spec, undefined, signal);
  // Only a read that gave facts is stored: a failed one must not wipe what an earlier read learnt.
  const patch: ModelTest['patch'] = api ? { fromApi: { ...api, at } } : {};
  // The same rule for the loaded context window: a server that did not say leaves the stored value alone.
  if (provider.kind === 'ollama' || provider.kind === 'lmstudio') {
    const detected = await detectContext(spec);
    if (detected !== undefined) patch.detectedContext = detected;
  }
  if (!whole) return { patch };
  // The probes ask only what no source said: the stored overrides and answers, and what the API said just now (or,
  // when it said nothing, last time).
  const stored = provider.models.find(m => m.name === modelName);
  const ask = probeAsk({
    ...spec,
    overrides: stored?.overrides,
    tested: stored?.tested,
    fromApi: patch.fromApi ?? stored?.fromApi,
  });
  const result = withKeyText(await testConnection(spec, {}, ask, signal));
  if (result.ok) {
    patch.noToolCalling = !result.toolCalling;
    if (result.tested) patch.tested = result.tested;
  }
  return { result, patch };
}

/**
 * Stores a test's patch on the model's entry, reading the list fresh. `tested` keeps its other answers: a field changes
 * only with a new answer to the same question, and the API's facts (`fromApi`) are replaced only by a read that gave
 * some. The old `reasoningSupport` field goes.
 */
export async function saveTest(providerId: string, baseUrl: string | undefined, modelName: string, test: ModelTest) {
  const { tested, fromApi, detectedContext, ...rest } = test.patch;
  await providersStorage.set(list =>
    list.map(p =>
      p.id !== providerId || (p.baseUrl ?? '') !== (baseUrl ?? '')
        ? p
        : {
            ...p,
            models: p.models.map(m => {
              if (m.name !== modelName) return m;
              // A whole test supersedes the old `reasoningSupport` probe value; reading the API alone does not.
              const { reasoningSupport, ...model } = m;
              const kept = test.result || !reasoningSupport ? model : { ...model, reasoningSupport };
              const merged =
                tested && Object.keys(tested).length
                  ? { ...m.tested, ...tested, at: new Date().toISOString() }
                  : m.tested;
              return {
                ...kept,
                ...rest,
                ...(fromApi ? { fromApi } : {}),
                ...(detectedContext !== undefined ? { detectedContext } : {}),
                ...(merged ? { tested: merged } : {}),
              };
            }),
          },
    ),
  );
}

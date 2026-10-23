// Testing a model from Settings → Providers: what a refused key says, what a failed read of the model's API leaves
// stored, and which providers count as presets.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listProblem, saveTest, testModel } from '../model-test';
import { isPresetAddress, LEGACY_PRESET_URLS, needsKey } from '../ProvidersSection';
import { providersStorage } from '@src/store/settings';
import type { ProviderConfig } from '@src/store/settings';
import { listModels, ZAI_ANTHROPIC_BASE_URL } from '@src/llm';

const KEY_REFUSED = 'The provider did not accept this key. Check it and save it again.';

const zai = (models: ProviderConfig['models'] = []): ProviderConfig => ({
  id: 'p1',
  kind: 'anthropic',
  name: 'Z.ai GLM (Coding Plan)',
  baseUrl: ZAI_ANTHROPIC_BASE_URL,
  models,
});

/** chrome.storage.local over a plain object, as storage.test.ts does. */
function stubStorage(providers: ProviderConfig[]) {
  const data: Record<string, unknown> = { 'nb.providers': providers };
  const area = {
    get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]]))),
    set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
    onChanged: { addListener: () => undefined },
  };
  vi.stubGlobal('chrome', { storage: { local: area } });
  return data;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a refused key on Test models', () => {
  const refusing = () =>
    vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/messages')
        ? new Response('{"code":401,"msg":"token expired or incorrect","success":false}', { status: 401 })
        : new Response('', { status: 404 }),
    ) as unknown as typeof globalThis.fetch;

  it('is told in the page’s own words, not as Z.ai’s raw body', async () => {
    vi.stubGlobal('fetch', refusing());
    const test = await testModel(zai(), 'glm-5.3', 'wrong', true);
    expect(test.result).toMatchObject({ ok: false, status: 401, error: KEY_REFUSED });
    expect(test.patch.noToolCalling).toBeUndefined();
  });

  it('another failure keeps the provider’s own text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).endsWith('/messages')
          ? new Response('{"error":{"message":"model overloaded"}}', { status: 400 })
          : new Response('', { status: 404 }),
      ),
    );
    const test = await testModel(zai(), 'glm-5.3', 'k', true);
    expect(test.result?.error).toContain('model overloaded');
  });

  it('a Z.ai model list that failed with the key’s code is told as a refused key', async () => {
    const error = await listModels({ kind: 'anthropic', apiKey: 'wrong', baseUrl: ZAI_ANTHROPIC_BASE_URL }, (async () =>
      Response.json({
        code: 401,
        msg: 'token expired or incorrect',
        success: false,
      })) as typeof globalThis.fetch).catch(e => e as Error);
    expect(listProblem(error, false)).toEqual({ message: KEY_REFUSED, originRefused: false });
  });
});

describe('a failed read of the model’s API', () => {
  const stored = {
    name: 'glm-5.3',
    fromApi: { contextWindow: 200_000, vision: false, at: '2026-10-01T00:00:00.000Z' },
  };

  it('leaves no facts in the patch, and the stored ones stay', async () => {
    const data = stubStorage([zai([stored])]);
    // The model’s record is not there (404) and the tool probe answers with text only.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).endsWith('/messages') ? new Response('', { status: 500 }) : new Response('', { status: 404 }),
      ),
    );
    const test = await testModel(zai([stored]), 'glm-5.3', 'k', false);
    expect(test.patch).not.toHaveProperty('fromApi');
    await providersStorage.get();
    await saveTest('p1', ZAI_ANTHROPIC_BASE_URL, 'glm-5.3', test);
    const [provider] = data['nb.providers'] as ProviderConfig[];
    expect(provider.models[0].fromApi).toEqual(stored.fromApi);
  });

  it('even a patch that names fromApi as undefined does not wipe it', async () => {
    const data = stubStorage([zai([stored])]);
    await providersStorage.get();
    await saveTest('p1', ZAI_ANTHROPIC_BASE_URL, 'glm-5.3', {
      patch: { fromApi: undefined, noToolCalling: false },
    });
    const [provider] = data['nb.providers'] as ProviderConfig[];
    expect(provider.models[0]).toMatchObject({ fromApi: stored.fromApi, noToolCalling: false });
  });

  it('a read that gave facts replaces the old ones', async () => {
    const data = stubStorage([zai([stored])]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: 'glm-5.3', max_input_tokens: 1_000_000 })),
    );
    const test = await testModel(zai([stored]), 'glm-5.3', 'k', false);
    expect(test.patch.fromApi).toMatchObject({ contextWindow: 1_000_000 });
    await providersStorage.get();
    await saveTest('p1', ZAI_ANTHROPIC_BASE_URL, 'glm-5.3', test);
    const [provider] = data['nb.providers'] as ProviderConfig[];
    expect(provider.models[0].fromApi).toMatchObject({ contextWindow: 1_000_000 });
  });

  it('the probes still use the facts stored when this read failed', async () => {
    stubStorage([]);
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (!String(url).endsWith('/messages')) return new Response('', { status: 404 });
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('', { status: 500 });
      }),
    );
    // Stored facts say the model does not reason: no Low is asked of it.
    await testModel(zai([{ name: 'glm-5.3', fromApi: { reasons: false, at: '' } }]), 'glm-5.3', 'k', true);
    expect(bodies[0]).not.toHaveProperty('output_config');
  });
});

describe('which providers are presets', () => {
  it('a preset’s current address needs a key', () => {
    expect(needsKey({ kind: 'anthropic', baseUrl: ZAI_ANTHROPIC_BASE_URL })).toBe(true);
    expect(needsKey({ kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' })).toBe(true);
    expect(needsKey({ kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1/' })).toBe(true);
  });

  it('a provider saved by the earlier Z.ai preset still does, though its address is no longer offered', () => {
    expect(LEGACY_PRESET_URLS).toContain('https://api.z.ai/api/coding/paas/v4');
    expect(needsKey({ kind: 'openai-compatible', baseUrl: 'https://api.z.ai/api/coding/paas/v4' })).toBe(true);
    expect(isPresetAddress('https://api.z.ai/api/coding/paas/v4/')).toBe(true);
  });

  it('a custom or local endpoint still does not', () => {
    expect(needsKey({ kind: 'openai-compatible', baseUrl: 'http://localhost:8000/v1' })).toBe(false);
    expect(needsKey({ kind: 'openai-compatible', baseUrl: 'https://llm.example.com/v1' })).toBe(false);
    expect(needsKey({ kind: 'openai-compatible', baseUrl: undefined })).toBe(false);
    expect(needsKey({ kind: 'ollama', baseUrl: 'http://localhost:11434' })).toBe(false);
    expect(needsKey({ kind: 'openai-compatible', baseUrl: 'https://api.z.ai/api/coding/paas/v5' })).toBe(false);
  });

  it('a kind that always needs one does', () => {
    for (const kind of ['anthropic', 'openai', 'gemini', 'openrouter'] as const) {
      expect(needsKey({ kind, baseUrl: undefined })).toBe(true);
    }
  });
});

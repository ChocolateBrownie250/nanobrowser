// Provider factories, ported from the current Nanobrowser's src/background/llm/providers.ts and reduced to the
// providers of the first release. The loop runs tools itself, so a model handle is only a model, its call settings and
// its provider options.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { isCloudEndpoint } from './catalogue';
import type { WireEffort } from './catalogue';
import { ModelTimeoutError } from './errors';

export type ProviderKind =
  'anthropic' | 'openai' | 'gemini' | 'openai-compatible' | 'ollama' | 'lmstudio' | 'openrouter';

/** Everything needed to call one model. The key is passed in; src/llm never reads storage. */
export interface ModelSpec {
  kind: ProviderKind;
  modelName: string;
  apiKey?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  /** For a local server: at most this many requests at once to it. */
  maxConcurrent?: number;
}

export type ProviderOptions = Record<string, Record<string, unknown>>;

export interface ChatModel {
  spec: ModelSpec;
  model: LanguageModel;
  providerOptions?: ProviderOptions;
  /**
   * For a server that takes the effort as a provider option rather than through the SDK's `reasoning`: the provider
   * options carrying it, sent in place of `providerOptions` with `reasoning` left out. Undefined keeps the SDK's way.
   */
  reasoningOptions?: (reasoning: WireEffort) => ProviderOptions | undefined;
  /** The cost of the latest response, when the provider reports one the SDK does not pass on (OpenRouter). */
  takeCost?: () => Promise<number | undefined>;
}

export interface CreateModelOptions {
  /** Custom fetch, used by tests to inspect requests. */
  fetch?: typeof fetch;
}

/** Z.ai's Anthropic-compatible endpoint for the GLM Coding Plan, the address its Claude Code guide gives plus `/v1`. */
export const ZAI_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic/v1';

/** The GLM models of the Coding Plan, offered when Z.ai's model list comes back without them. */
export const ZAI_MODELS: readonly string[] = ['glm-5.3', 'glm-5.3-flash'];

/** Whether an Anthropic-kind base URL is Z.ai's. */
export function isZai(baseUrl?: string): boolean {
  try {
    return !!baseUrl && new URL(baseUrl).hostname === 'api.z.ai';
  } catch {
    return false;
  }
}

/**
 * The key headers of an Anthropic-kind request. Z.ai's guide passes the key as a bearer token (Claude Code's
 * `ANTHROPIC_AUTH_TOKEN`), so for Z.ai it goes in both `Authorization` and `x-api-key`.
 */
export function anthropicKeyHeaders(apiKey: string | undefined, baseUrl?: string): Record<string, string> {
  return {
    'x-api-key': apiKey ?? '',
    ...(isZai(baseUrl) && apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

/**
 * Z.ai's GLM effort, sent as `output_config.effort`. Its endpoint varies GLM's thinking only by that field and ignores
 * `thinking.budget_tokens`, which the SDK would otherwise send for a model it does not know. Z.ai documents three
 * levels, low, high and max (the catalogue maps the picker to them for GLM-5.3), so any other value is clamped to the
 * nearest: minimal to low, medium to high, xhigh to max. None keeps the SDK's disabled thinking.
 */
const ZAI_EFFORTS = { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' } as const;

function zaiReasoningOptions(reasoning: WireEffort): ProviderOptions | undefined {
  if (reasoning === 'none') return undefined;
  return { anthropic: { cacheControl: { type: 'ephemeral' }, effort: ZAI_EFFORTS[reasoning] } };
}

export const DEFAULT_BASE_URLS: Partial<Record<ProviderKind, string>> = {
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * The kinds that speak chat completions at a base URL. Their servers may refuse `reasoning_effort`, which the run's
 * fallback handles, and Test models probes them for reasoning.
 */
export const CHAT_COMPLETIONS_KINDS: readonly ProviderKind[] = [
  'openai-compatible',
  'ollama',
  'lmstudio',
  'openrouter',
];

/**
 * The OpenAI-compatible endpoint of an Ollama or LM Studio server: `/v1` is added unless the address ends with it,
 * so the user can type the server's address (ported).
 */
export function openAICompatibleBaseUrl(kind: ProviderKind, baseUrl?: string): string | undefined {
  const fallback = DEFAULT_BASE_URLS[kind];
  // OpenRouter's address is fixed: the card has no field for it.
  if (kind === 'openrouter') return fallback;
  const url = (baseUrl?.trim() || fallback)?.replace(/\/+$/, '');
  if (!url) return undefined;
  if (kind === 'ollama' || kind === 'lmstudio') return url.endsWith('/v1') ? url : `${url}/v1`;
  return url;
}

/**
 * How long a model call may stay silent: until the server answers at all (`headersMs`), until it sends its first output
 * (`firstChunkMs`), and between outputs once it has started (`chunkMs`). Generous, since a reasoning model that streams
 * none of its thinking (OpenAI, Gemini, a high effort) is silent until its answer starts, which can take minutes, and
 * a local server loading a model can take longer still. A server that never answers is told apart from one that is
 * thinking: the first is retried, the second is not (see `streamTurn`).
 */
export function modelTimeouts(spec: Pick<ModelSpec, 'kind' | 'baseUrl'>): {
  headersMs: number;
  firstChunkMs: number;
  chunkMs: number;
} {
  return isCloudEndpoint(spec.kind, spec.baseUrl)
    ? { headersMs: 180_000, firstChunkMs: 600_000, chunkMs: 120_000 }
    : { headersMs: 600_000, firstChunkMs: 600_000, chunkMs: 300_000 };
}

/**
 * A fetch that gives up when the server has not sent its response headers within `ms`. The AI SDK's own first-output
 * timeout starts only once the response has arrived, so a connection that is accepted and never answered needs this.
 * The caller's abort signal still ends the request, and keeps ending it while the body streams.
 */
export function withHeaderTimeout(base: typeof fetch | undefined, ms: number): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ModelTimeoutError(Math.round(ms / 1000), false)), ms);
    const outer = init?.signal;
    if (outer?.aborted) controller.abort(outer.reason);
    else outer?.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
    const send = base ?? ((i, n) => globalThis.fetch(i, n));
    return send(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };
}

export function createModel(spec: ModelSpec, options: CreateModelOptions = {}): ChatModel {
  const { kind, modelName, apiKey } = spec;
  const fetch = withHeaderTimeout(options.fetch, modelTimeouts(spec).headersMs);
  switch (kind) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        // Z.ai takes the key as a bearer token; the SDK then leaves out x-api-key, which is added back with it.
        ...(isZai(spec.baseUrl) ? { authToken: apiKey } : { apiKey }),
        ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
        // The service worker sends an Origin header, so Anthropic requires this opt-in for browser access.
        headers: {
          'anthropic-dangerous-direct-browser-access': 'true',
          ...(isZai(spec.baseUrl) ? anthropicKeyHeaders(apiKey, spec.baseUrl) : {}),
        },
        fetch,
      });
      // The prompt cache, switched on for the whole request: the API places the breakpoint itself.
      return {
        spec,
        model: anthropic(modelName),
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        ...(isZai(spec.baseUrl) ? { reasoningOptions: zaiReasoningOptions } : {}),
      };
    }
    case 'gemini': {
      const google = createGoogle({ apiKey, ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}), fetch });
      return { spec, model: google(modelName) };
    }
    case 'openai': {
      // The Responses API: GPT-6 models refuse function tools with reasoning on chat completions. Nothing is stored
      // at OpenAI; each turn sends the whole history, and tool calls go back without item ids. The SDK detects the
      // reasoning models itself.
      const openai = createOpenAI({ apiKey, ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}), fetch });
      return {
        spec,
        model: openai.responses(modelName),
        providerOptions: { openai: { strictJsonSchema: false, store: false } },
      };
    }
    default: {
      // Ollama, LM Studio, OpenRouter and any other OpenAI-compatible server: chat completions at the base URL.
      const accounting = kind === 'openrouter' ? usageAccounting(fetch ?? globalThis.fetch) : null;
      const openai = createOpenAI({
        apiKey: apiKey || kind,
        baseURL: openAICompatibleBaseUrl(kind, spec.baseUrl),
        ...(kind === 'openrouter'
          ? { headers: { 'HTTP-Referer': 'https://nanobrowser.ai', 'X-Title': 'Nanobrowser' } }
          : {}),
        // OpenRouter reports a request's cost in its usage when asked.
        fetch: accounting?.fetch ?? fetch,
      });
      return {
        spec,
        model: openai.chat(modelName),
        providerOptions: { openai: { strictJsonSchema: false } },
        ...(accounting ? { takeCost: accounting.takeCost } : {}),
      };
    }
  }
}

/**
 * OpenRouter's usage accounting: each request asks for it, and the cost in the final usage chunk is read from a copy of
 * the stream, because the SDK's schema does not keep it.
 */
export function usageAccounting(base: typeof fetch): {
  fetch: typeof fetch;
  takeCost: () => Promise<number | undefined>;
} {
  let latest: Promise<number | undefined> = Promise.resolve(undefined);
  const wrapped: typeof fetch = async (input, init) => {
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        init = { ...init, body: JSON.stringify({ ...body, usage: { include: true } }) };
      } catch {
        // Not JSON: sent as it is.
      }
    }
    const response = await base(input, init);
    if (!response.body) return response;
    const [forSdk, forCost] = response.body.tee();
    latest = (async () => {
      const reader = forCost.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let cost: number | undefined;
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        text += decoder.decode(value, { stream: true });
        const lines = text.split('\n');
        text = lines.pop() ?? '';
        for (const line of lines) {
          const found = /"usage"\s*:\s*\{[^}]*"cost"\s*:\s*([0-9.eE+-]+)/.exec(line)?.[1];
          if (found !== undefined && Number.isFinite(Number(found))) cost = Number(found);
        }
      }
      return cost;
    })();
    return new Response(forSdk, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return {
    fetch: wrapped,
    takeCost: async () => {
      const cost = await latest;
      latest = Promise.resolve(undefined);
      return cost;
    },
  };
}

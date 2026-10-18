// Provider factories, ported from the current Nanobrowser's src/background/llm/providers.ts and reduced to the
// providers of the first release. The loop runs tools itself, so a model handle is only a model, its call settings and
// its provider options.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { WireEffort } from './catalogue';

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
 * `thinking.budget_tokens`, which the SDK would otherwise send for a model it does not know. GLM's levels are low, high
 * and max (the catalogue maps the picker to them). The SDK's effort has no `minimal`; None keeps the SDK's disabled
 * thinking.
 */
function zaiReasoningOptions(reasoning: WireEffort): ProviderOptions | undefined {
  if (reasoning === 'none') return undefined;
  const effort = reasoning === 'minimal' ? 'low' : reasoning;
  return { anthropic: { cacheControl: { type: 'ephemeral' }, effort } };
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

export function createModel(spec: ModelSpec, options: CreateModelOptions = {}): ChatModel {
  const { kind, modelName, apiKey } = spec;
  const fetch = options.fetch;
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

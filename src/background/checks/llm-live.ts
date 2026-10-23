// One streamed tool call per provider, in the MV3 worker. Run with NB_LIVE=1 pnpm autorun llm-live. The keys come from
// the fixture server's environment and are never stored, returned or logged.
import { streamTurn, createModel, ZAI_ANTHROPIC_BASE_URL } from '@src/llm';
import type { ProviderKind } from '@src/llm';
import { defineCheck } from './registry';

interface LiveModel {
  kind: ProviderKind;
  model: string;
  /** The key's name in the fixture server's reply, when it is not the provider kind's. */
  keyName?: string;
  baseUrl?: string;
  /** The reasoning effort to send. */
  reasoning?: 'low';
  /** Skipped, not failed, when the server has no key for it. */
  optional?: boolean;
}

const MODELS: LiveModel[] = [
  { kind: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  { kind: 'openai', model: 'gpt-4.1-mini' },
  { kind: 'gemini', model: 'gemini-2.5-flash' },
  // Z.ai's Anthropic-compatible endpoint: the bearer key and output_config.effort are only seen on the real server.
  {
    kind: 'anthropic',
    model: 'glm-5.3',
    keyName: 'zai',
    baseUrl: ZAI_ANTHROPIC_BASE_URL,
    reasoning: 'low',
    optional: true,
  },
];

defineCheck({
  name: 'llm-live',
  title: 'Live tool call per provider (worker)',
  description:
    'Streams one tool call from Anthropic, OpenAI, Gemini and Z.ai GLM in the service worker. Needs NB_LIVE=1; Z.ai is skipped without ZAI_API_KEY.',
  async run(args) {
    const response = await fetch('http://localhost:8787/__live/keys');
    if (!response.ok) throw new Error('Run with NB_LIVE=1 so the fixture server can hand over the keys');
    const keys = (await response.json()) as Record<string, string | undefined>;
    const models = (args.models as LiveModel[] | undefined) ?? MODELS;
    const results = [];
    for (const { kind, model, keyName, baseUrl, reasoning, optional } of models) {
      const apiKey = keys[keyName ?? kind];
      if (optional && !apiKey) {
        results.push({ kind, model, ok: true, skipped: `no ${keyName ?? kind} key in the server's environment` });
        continue;
      }
      const result = await streamTurn({
        chat: createModel({ kind, modelName: model, apiKey, baseUrl, maxOutputTokens: 512 }),
        ...(reasoning ? { reasoning } : {}),
        system: 'You operate a web page through tools. Always act with a tool call.',
        messages: [{ role: 'user', content: 'Click the element with ref e7.' }],
        tools: {
          click: {
            description: 'Click an element by its ref.',
            parameters: {
              type: 'object',
              properties: { ref: { type: 'string' } },
              required: ['ref'],
              additionalProperties: false,
            },
          },
        },
      });
      const call = result.toolCalls[0];
      results.push({
        kind,
        model,
        ok: !result.error && call?.toolName === 'click' && (call.input as { ref?: string })?.ref === 'e7',
        finish: result.finish,
        call: call ? { name: call.toolName, input: call.input } : null,
        usage: result.usage,
        ms: result.durationMs,
        error: result.error?.message?.slice(0, 300),
      });
    }
    if (results.some(r => !r.ok)) throw new Error(JSON.stringify(results));
    return { results };
  },
});

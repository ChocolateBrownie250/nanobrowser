// A model call that never answers, stalls, is filtered or says it is out of balance, through the real provider factory
// and a fake fetch: Z.ai's Anthropic-compatible endpoint, plus a local server for the longer limits.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModel, modelTimeouts } from '../providers';
import type { ModelSpec } from '../providers';
import { MAX_RETRY_AFTER_MS, streamTurn } from '../stream';
import type { TurnRequest } from '../stream';

const ZAI: ModelSpec = {
  kind: 'anthropic',
  modelName: 'glm-5.3',
  apiKey: 'z',
  baseUrl: 'https://api.z.ai/api/anthropic/v1',
};

const tools = { done: { description: 'Finish', parameters: { type: 'object', properties: {} } } };

const noSleep = async () => undefined;

afterEach(() => vi.useRealTimers());

/** The events of an Anthropic messages stream, as server-sent events. */
function anthropicSse(events: unknown[]): string {
  return events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const start = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'glm-5.3',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  },
};
const stop = (reason: string) => [
  { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];
const textBlock = (text: string) => [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
];
const sseResponse = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

const turn = (fetch: typeof globalThis.fetch, extra: Partial<TurnRequest> = {}, spec: ModelSpec = ZAI) =>
  streamTurn({
    chat: createModel(spec, { fetch }),
    system: 'sys',
    messages: [{ role: 'user', content: 'go' }],
    tools,
    sleep: noSleep,
    ...extra,
  });

/** A fetch that never answers, and rejects when the request is aborted, as the real one does. */
function silentFetch() {
  const calls: number[] = [];
  const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(Date.now());
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
      );
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A fetch whose reply sends the given text, then goes quiet without ending, until the request is aborted. */
function stallingFetch(head: string) {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(head));
        init?.signal?.addEventListener('abort', () =>
          controller.error(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
        );
      },
    });
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  }) as unknown as typeof globalThis.fetch;
}

describe('a model call that stops answering', () => {
  it('gives the limits: generous on the cloud, longer on a local server', () => {
    // The first output waits 10 minutes: a reasoning model that streams none of its thinking is silent that long.
    expect(modelTimeouts(ZAI)).toEqual({ headersMs: 180_000, firstChunkMs: 600_000, chunkMs: 120_000 });
    expect(modelTimeouts({ kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' })).toEqual({
      headersMs: 180_000,
      firstChunkMs: 600_000,
      chunkMs: 120_000,
    });
    for (const spec of [
      { kind: 'ollama' as const },
      { kind: 'lmstudio' as const },
      { kind: 'openai-compatible' as const, baseUrl: 'http://localhost:8000/v1' },
    ]) {
      expect(modelTimeouts(spec)).toEqual({ headersMs: 600_000, firstChunkMs: 600_000, chunkMs: 300_000 });
    }
  });

  it('a connection that never answers ends each attempt after 180 s, is retried, and then fails as a network error', async () => {
    vi.useFakeTimers();
    const { fetch } = silentFetch();
    let done = false;
    const result = turn(fetch).then(r => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(179_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(181_000 * 2);
    const r = await result;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(r.finish).toBe('error');
    expect(r.attempts).toBe(3);
    expect(r.error?.network).toBe(true);
    expect(r.error?.message).toMatch(/did not answer within 180 seconds/);
  });

  it('a silent attempt that is retried can still succeed', async () => {
    vi.useFakeTimers();
    const silent = silentFetch().fetch;
    const answer = anthropicSse([start, ...textBlock('Hello'), ...stop('end_turn')]);
    let n = 0;
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      ++n === 1 ? silent(input, init) : Promise.resolve(sseResponse(answer))) as typeof globalThis.fetch;
    const result = turn(fetch);
    await vi.advanceTimersByTimeAsync(181_000);
    const r = await result;
    expect(r).toMatchObject({ text: 'Hello', finish: 'stop', attempts: 2 });
  });

  it('a stream that goes quiet after its first output ends the turn after 120 s, without a retry', async () => {
    vi.useFakeTimers();
    const head = anthropicSse([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ]);
    const fetch = stallingFetch(
      head + anthropicSse([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Par' } }]),
    );
    const result = turn(fetch);
    await vi.advanceTimersByTimeAsync(121_000);
    const r = await result;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ finish: 'error', text: 'Par', attempts: 1 });
    expect(r.error?.message).toMatch(/nothing arrived for 120 seconds/);
    expect(r.error?.network).toBe(true);
  });

  it('a server that answered and is thinking silently is waited for up to 10 minutes, then not asked again', async () => {
    vi.useFakeTimers();
    const fetch = stallingFetch(anthropicSse([start]));
    let done = false;
    const result = turn(fetch, { reasoning: 'high' }).then(r => {
      done = true;
      return r;
    });
    // 5 minutes of silence after the response began is still fine.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(301_000);
    const r = await result;
    // One request: the same call would think as long again, and be billed again.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ finish: 'error', attempts: 1 });
    expect(r.error?.message).toMatch(/did not answer within 600 seconds/);
    expect(r.error?.timeout).toBe(true);
  });

  it('a reply that starts after minutes of silent thinking completes', async () => {
    vi.useFakeTimers();
    const answer = anthropicSse([start, ...textBlock('Done thinking'), ...stop('end_turn')]);
    const fetch = vi.fn(
      () => new Promise<Response>(resolve => setTimeout(() => resolve(sseResponse(answer)), 170_000)),
    ) as unknown as typeof globalThis.fetch;
    const result = turn(fetch, { reasoning: 'high' });
    await vi.advanceTimersByTimeAsync(171_000);
    expect(await result).toMatchObject({ text: 'Done thinking', finish: 'stop', attempts: 1 });
  });

  it('a thinking block that carries only a signature does not count as output, and the error names the right limit', async () => {
    vi.useFakeTimers();
    const head = anthropicSse([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    ]);
    const fetch = stallingFetch(head);
    const result = turn(fetch, { reasoning: 'high' });
    await vi.advanceTimersByTimeAsync(601_000);
    const r = await result;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r.error?.message).toMatch(/did not answer within 600 seconds/);
  });

  it('a local server gets longer: 5 minutes of silence is not an error, 10 minutes is', async () => {
    vi.useFakeTimers();
    const { fetch } = silentFetch();
    let done = false;
    const result = turn(fetch, {}, { kind: 'ollama', modelName: 'qwen3:8b' }).then(r => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(301_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_300_000);
    expect((await result).error?.message).toMatch(/did not answer within 600 seconds/);
  });

  it('the Stop button still ends the call as aborted, not as a timeout', async () => {
    vi.useFakeTimers();
    const { fetch } = silentFetch();
    const controller = new AbortController();
    const result = turn(fetch, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort();
    const r = await result;
    expect(r.finish).toBe('aborted');
    expect(r.error).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('Stop during a stalled stream ends as aborted too', async () => {
    vi.useFakeTimers();
    const fetch = stallingFetch(anthropicSse([start]));
    const controller = new AbortController();
    const result = turn(fetch, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(50_000);
    controller.abort();
    expect((await result).finish).toBe('aborted');
  });
});

describe('a reply that ends without an answer', () => {
  it('Z.ai "sensitive" with no text and no calls is an error naming the provider reason, not a success', async () => {
    const fetch = (async () => sseResponse(anthropicSse([start, ...stop('sensitive')]))) as typeof globalThis.fetch;
    const r = await turn(fetch);
    expect(r.finish).toBe('error');
    expect(r.error?.message).toContain('sensitive');
    expect(r.error?.overflow).toBe(false);
    expect(r.toolCalls).toEqual([]);
  });

  it('a content-filter refusal with no output is an error as well', async () => {
    const fetch = (async () => sseResponse(anthropicSse([start, ...stop('refusal')]))) as typeof globalThis.fetch;
    const r = await turn(fetch);
    expect(r.finish).toBe('error');
    expect(r.error?.message).toContain('refusal');
  });

  it('a reply with text keeps its finish, whatever it is', async () => {
    const fetch = (async () =>
      sseResponse(anthropicSse([start, ...textBlock('Partly'), ...stop('sensitive')]))) as typeof globalThis.fetch;
    const r = await turn(fetch);
    expect(r).toMatchObject({ text: 'Partly', finish: 'other' });
    expect(r.error).toBeUndefined();
  });

  it('an OpenAI-compatible server that names no finish reason after an answer finished it; a vendor reason did not', async () => {
    const local: ModelSpec = {
      kind: 'openai-compatible',
      modelName: 'm',
      apiKey: 'k',
      baseUrl: 'http://localhost:1234/v1',
    };
    const chunk = (delta: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const body = (finish: string | null) =>
      chunk({ role: 'assistant', content: 'All done.' }, null) + (finish ? chunk({}, finish) : '') + 'data: [DONE]\n\n';
    const silent = (async () => sseResponse(body(null))) as typeof globalThis.fetch;
    expect(await turn(silent, {}, local)).toMatchObject({ text: 'All done.', finish: 'stop' });
    const vendor = (async () => sseResponse(body('vendor_specific'))) as typeof globalThis.fetch;
    expect(await turn(vendor, {}, local)).toMatchObject({ text: 'All done.', finish: 'other' });
  });

  it('a reply with a tool call keeps it', async () => {
    const call = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'done', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
    ];
    const fetch = (async () =>
      sseResponse(anthropicSse([start, ...call, ...stop('tool_use')]))) as typeof globalThis.fetch;
    const r = await turn(fetch);
    expect(r.finish).toBe('tool-calls');
    expect(r.toolCalls).toHaveLength(1);
  });

  it('a normal empty end_turn is left as it was', async () => {
    const fetch = (async () => sseResponse(anthropicSse([start, ...stop('end_turn')]))) as typeof globalThis.fetch;
    const r = await turn(fetch);
    expect(r).toMatchObject({ finish: 'stop', text: '' });
    expect(r.error).toBeUndefined();
  });

  it('the server saying the context window is full is an overflow, so the run compacts', async () => {
    const fetch = (async () =>
      sseResponse(
        anthropicSse([start, ...textBlock('cut'), ...stop('model_context_window_exceeded')]),
      )) as typeof globalThis.fetch;
    const r = await turn(fetch);
    expect(r.finish).toBe('error');
    expect(r.error?.overflow).toBe(true);
    expect(r.error?.message).toContain('model_context_window_exceeded');
    expect(r.toolCalls).toEqual([]);
  });
});

describe('a 429', () => {
  const failing = (status: number, body: string, headers: Record<string, string> = {}) => {
    const fetch = vi.fn(
      async () => new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } }),
    ) as unknown as typeof globalThis.fetch;
    return fetch;
  };

  it.each([
    [
      '1113, insufficient balance',
      '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}',
    ],
    [
      '1308, usage limit',
      '{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-10-23 12:00:00"}}',
    ],
    ['the {code,msg} envelope', '{"code":1113,"msg":"Insufficient balance","success":false}'],
  ])('with %s is not retried', async (_name, body) => {
    const fetch = failing(429, body);
    const r = await turn(fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ finish: 'error', attempts: 1 });
    expect(r.error?.status).toBe(429);
    expect(r.error?.message.toLowerCase()).toMatch(/balance|usage limit/);
  });

  it('that is a plain rate limit is still retried up to 3 attempts', async () => {
    const fetch = failing(429, '{"error":{"code":"1302","message":"Rate limit reached for requests"}}');
    const r = await turn(fetch);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(r.attempts).toBe(3);
  });

  it('is retried when its Retry-After is short', async () => {
    const fetch = failing(429, '{"error":{"message":"slow down"}}', { 'retry-after': '2' });
    await turn(fetch);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('with a Retry-After a per-minute limit asks for is waited out, as asked', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const answer = anthropicSse([start, ...textBlock('Back'), ...stop('end_turn')]);
    const fetch = vi.fn(async () =>
      ++n < 3
        ? new Response('{"error":{"message":"Rate limit reached"}}', {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '45' },
          })
        : sseResponse(answer),
    ) as unknown as typeof globalThis.fetch;
    const r = await turn(fetch, { sleep: async ms => void sleeps.push(ms) });
    expect(sleeps).toEqual([45_000, 45_000]);
    expect(r).toMatchObject({ text: 'Back', finish: 'stop', attempts: 3 });
  });

  it('with a Retry-After above 2 minutes is not waited for, and the error names the wait', async () => {
    const sleeps: number[] = [];
    const fetch = failing(429, '{"error":{"message":"Rate limit reached"}}', { 'retry-after': '900' });
    const r = await turn(fetch, { sleep: async ms => void sleeps.push(ms) });
    expect(MAX_RETRY_AFTER_MS).toBe(120_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(r.error?.message).toContain('Rate limit reached');
    expect(r.error?.message).toContain('15 minutes');
  });

  it('a 503 with a long Retry-After is not waited for either', async () => {
    const fetch = failing(503, 'busy', { 'retry-after': '600' });
    const r = await turn(fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r.error?.message).toContain('10 minutes');
  });
});

describe('a missing key', () => {
  it.each([undefined, ''])('a Z.ai provider with key %j says so plainly, with no request', async apiKey => {
    const fetch = vi.fn(async () => sseResponse('')) as unknown as typeof globalThis.fetch;
    const r = await turn(fetch, {}, { ...ZAI, apiKey });
    expect(fetch).not.toHaveBeenCalled();
    expect(r.finish).toBe('error');
    expect(r.error?.message).toBe('No API key is set for this provider.');
  });

  it('a plain Anthropic provider without a key says the same, not the SDK text', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const r = await turn(fetch, {}, { kind: 'anthropic', modelName: 'claude-sonnet-5-5' });
    expect(r.error?.message).toBe('No API key is set for this provider.');
    expect(r.error?.message).not.toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe('what a refused request says', () => {
  const refuse = (status: number, body: string) =>
    vi.fn(
      async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof globalThis.fetch;

  it("reads Z.ai's {code,msg,success} envelope, with no leading space", async () => {
    const r = await turn(refuse(401, '{"code":401,"msg":"token expired or incorrect","success":false}'));
    expect(r.error?.status).toBe(401);
    expect(r.error?.message.startsWith('token expired or incorrect')).toBe(true);
    expect(r.error?.message).not.toMatch(/^\s/);
  });

  it('a Z.ai overflow body (code 1261) is an overflow, so the run compacts instead of failing', async () => {
    const r = await turn(refuse(400, '{"error":{"code":"1261","message":"Prompt exceeds max length"}}'));
    expect(r.attempts).toBe(1);
    expect(r.error?.overflow).toBe(true);
  });

  it('an image that is too big is not "this model takes no images": it is not stripped, and learns nothing', async () => {
    const fetch = refuse(
      400,
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 6291456 bytes > 5242880 bytes"}}',
    );
    const r = await turn(fetch, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'file', data: 'AAAA', mediaType: 'image/png' },
          ],
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r.imagesDropped).toBeUndefined();
    expect(r.error?.status).toBe(400);
  });

  it('a model that takes no images still has them stripped and the request sent again', async () => {
    let n = 0;
    const fetch = vi.fn(async () =>
      ++n === 1
        ? new Response('{"error":{"message":"This model does not support image input"}}', { status: 400 })
        : sseResponse(anthropicSse([start, ...textBlock('ok'), ...stop('end_turn')])),
    ) as unknown as typeof globalThis.fetch;
    const r = await turn(fetch, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'file', data: 'AAAA', mediaType: 'image/png' },
          ],
        },
      ],
    });
    expect(r).toMatchObject({ text: 'ok', imagesDropped: true });
  });
});

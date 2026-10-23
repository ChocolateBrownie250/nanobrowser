// Z.ai through its Anthropic-compatible endpoint: the test's first request, the answers of its model list, and the time
// each request of Test models and the model list is given.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listModels, testConnection } from '../connection';
import { readModelInfo } from '../model-info';
import { probeAsk } from '../profiles';

const ZAI = {
  kind: 'anthropic' as const,
  modelName: 'glm-5.3',
  apiKey: 'z',
  baseUrl: 'https://api.z.ai/api/anthropic/v1',
};

const toolUseReply = () =>
  new Response(
    [
      {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'glm-5.3',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't', name: 'report_status', input: {} },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"status":"ok"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]
      .map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

/** A fetch that never answers and rejects when the request is aborted. */
const silent = () =>
  vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      ),
  ) as unknown as typeof globalThis.fetch;

afterEach(() => vi.useRealTimers());

describe('Test models on Z.ai', () => {
  it('asks the first probe at Low and with room for the answer, as a run would send Low', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return toolUseReply();
    }) as unknown as typeof globalThis.fetch;
    const ask = probeAsk({ kind: ZAI.kind, modelName: ZAI.modelName, baseUrl: ZAI.baseUrl });
    expect(ask.effort).toBe('low');
    const r = await testConnection(ZAI, { fetch }, ask);
    expect(r).toMatchObject({ ok: true, toolCalling: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].output_config).toEqual({ effort: 'low' });
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[0].max_tokens).toBe(2048);
  });

  it('sends no effort on the first probe when nothing asked for one', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return toolUseReply();
    }) as unknown as typeof globalThis.fetch;
    await testConnection(ZAI, { fetch }, {});
    expect(bodies[0]).not.toHaveProperty('output_config');
  });

  it('asks Low only of a model that cannot stop reasoning', () => {
    expect(probeAsk({ kind: 'anthropic', modelName: 'claude-sonnet-5-5' }).effort).toBeUndefined();
    expect(probeAsk({ kind: 'anthropic', modelName: 'claude-opus-5-5' }).effort).toBe('low');
    expect(probeAsk({ kind: 'openai', modelName: 'gpt-5.2-pro' }).effort).toBe('medium');
    expect(probeAsk({ kind: 'openai-compatible', modelName: 'deepseek-chat', baseUrl: 'https://x.io/v1' }).effort).toBe(
      undefined,
    );
  });

  it('reports the status of a refused key, so the options page can say so', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('{"code":401,"msg":"token expired or incorrect","success":false}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof globalThis.fetch;
    const r = await testConnection(ZAI, { fetch });
    expect(r).toMatchObject({ ok: false, status: 401, originRefused: false });
    expect(r.error).toBe('token expired or incorrect {"code":401,"msg":"token expired or incorrect","success":false}');
  });

  it('a test whose model never answers ends after 90 s with an error, and learns nothing', async () => {
    vi.useFakeTimers();
    const result = testConnection(ZAI, { fetch: silent() }, { image: true, effort: 'low' });
    await vi.advanceTimersByTimeAsync(91_000);
    const r = await result;
    expect(r).toMatchObject({ ok: false, toolCalling: false, originRefused: false });
    expect(r.error).toBe('The model did not answer within 90 seconds.');
    expect(r.tested).toBeUndefined();
  });

  it('a local server is given longer, and a timeout is not told as a refused origin', async () => {
    vi.useFakeTimers();
    const result = testConnection({ kind: 'ollama', modelName: 'qwen3:8b' }, { fetch: silent() });
    await vi.advanceTimersByTimeAsync(200_000);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(101_000);
    const r = await result;
    expect(r.error).toBe('The model did not answer within 300 seconds.');
    expect(r.originRefused).toBe(false);
  });

  it('the caller can stop a test', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const result = testConnection(ZAI, { fetch: silent() }, {}, stop.signal);
    await vi.advanceTimersByTimeAsync(5_000);
    stop.abort();
    expect(await result).toMatchObject({ ok: false, error: 'The test was stopped.' });
  });

  it('a later probe that times out learns nothing, and is not read as an answer', async () => {
    vi.useFakeTimers();
    let n = 0;
    const never = silent();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      ++n === 1
        ? Promise.resolve(toolUseReply())
        : (never as (u: string, i?: RequestInit) => Promise<Response>)(url, init),
    ) as unknown as typeof globalThis.fetch;
    const result = testConnection(ZAI, { fetch }, { image: true });
    await vi.advanceTimersByTimeAsync(91_000);
    const r = await result;
    expect(r).toMatchObject({ ok: true, toolCalling: true });
    expect(r.tested).toBeUndefined();
  });
});

describe('the model list on Z.ai', () => {
  const list = (body: unknown, status = 200) =>
    listModels(
      ZAI,
      vi.fn(async () =>
        typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status }),
      ) as unknown as typeof globalThis.fetch,
    );

  it('falls back to the Coding Plan models only for a success status body', async () => {
    const plan = { models: ['glm-5.3', 'glm-5.3-flash'], hidden: [] };
    expect(await list({ code: 200, success: true })).toEqual(plan);
    expect(await list({ code: 200 })).toEqual(plan);
    expect(await list({ success: true })).toEqual(plan);
    expect(await list({ data: [] })).toEqual(plan);
    expect(await list({ code: '200', msg: 'ok', success: true })).toEqual(plan);
  });

  it('an error status body is an error with its code as the status, so a refused key is told as one', async () => {
    await expect(list({ code: 401, msg: 'token expired or incorrect', success: false })).rejects.toMatchObject({
      status: 401,
      message: '401 token expired or incorrect',
    });
    await expect(list({ code: 1001, msg: 'Authorization Token missing', success: false })).rejects.toMatchObject({
      status: 1001,
      message: '1001 Authorization Token missing',
    });
    await expect(list({ success: false, msg: 'busy' })).rejects.toMatchObject({ message: 'busy' });
    await expect(list({ code: 500, msg: 'oops' })).rejects.toMatchObject({ status: 500 });
  });

  it("reads Z.ai's {code,msg} reason from a refused list", async () => {
    await expect(list({ code: 401, msg: 'token expired or incorrect', success: false }, 401)).rejects.toMatchObject({
      status: 401,
      message: '401 token expired or incorrect',
    });
  });

  it('a 200 that is not JSON, or not an object, is "unexpected answer", with no raw parser text', async () => {
    for (const body of ['<!doctype html><html>Sign in to the network</html>', 'null', '[]', '']) {
      await expect(list(body)).rejects.toMatchObject({
        message: 'Unexpected answer from api.z.ai',
        originRefused: false,
      });
    }
    await expect(
      listModels({ kind: 'openai', apiKey: 'k' }, (async () => new Response('<html>', { status: 200 })) as never),
    ).rejects.toThrow('Unexpected answer from api.openai.com');
  });

  it('a model list that never comes ends after 30 s, and says which host was silent', async () => {
    vi.useFakeTimers();
    const result = listModels(ZAI, silent()).catch(e => e as Error);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(((await result) as Error).message).toBe('api.z.ai did not answer within 30 seconds');
  });

  it('the caller can stop a model list', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const result = listModels(ZAI, silent(), stop.signal).catch(e => e as Error);
    await vi.advanceTimersByTimeAsync(5_000);
    stop.abort();
    expect(((await result) as Error).message).toBe('Stopped');
  });

  it("a model's record that never comes reads as nothing after 30 s; the caller can stop it too", async () => {
    vi.useFakeTimers();
    const result = readModelInfo(ZAI, silent());
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await result).toBeNull();
    const stop = new AbortController();
    const second = readModelInfo(ZAI, silent(), stop.signal);
    stop.abort();
    expect(await second).toBeNull();
  });

  it('reads a model record with both key headers on Z.ai, and only x-api-key off it', async () => {
    const sent: Array<Record<string, string>> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(init?.headers as Record<string, string>);
      return Response.json({ id: 'glm-5.3' });
    }) as unknown as typeof globalThis.fetch;
    await readModelInfo(ZAI, fetch);
    await readModelInfo({ kind: 'anthropic', modelName: 'claude-opus-5-5', apiKey: 'k' }, fetch);
    expect(sent[0]).toMatchObject({ authorization: 'Bearer z', 'x-api-key': 'z' });
    expect(sent[1]['x-api-key']).toBe('k');
    expect(sent[1]).not.toHaveProperty('authorization');
  });
});

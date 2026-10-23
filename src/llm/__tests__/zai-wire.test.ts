// Z.ai on the wire and in its error bodies: which hosts are Z.ai, what the effort becomes, who gets the bearer header,
// and how its answers read (the {code,msg,success} envelope, quota 429s, context overflow).
import { describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { anthropicKeyHeaders, createModel, isZai, withHeaderTimeout } from '../providers';
import type { ModelSpec } from '../providers';
import type { WireEffort } from '../catalogue';
import { bodyReason, errorText, isQuotaExhausted, isRetryable, withDeadline } from '../errors';
import { isContextOverflow } from '../overflow';
import { refusesImages, streamTurn } from '../stream';

const URL_ZAI = 'https://api.z.ai/api/anthropic/v1';
const ZAI: ModelSpec = { kind: 'anthropic', modelName: 'glm-5.3', apiKey: 'z', baseUrl: URL_ZAI };

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fetch that records each request and answers with `answer`. */
function recordingFetch(answer: (n: number) => Response = () => new Response('{}', { status: 400 })) {
  const requests: Captured[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    });
    return answer(requests.length);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

const tools = { done: { description: 'Finish', parameters: { type: 'object', properties: {} } } };

async function send(spec: ModelSpec, reasoning?: WireEffort, answer?: (n: number) => Response) {
  const { fetch, requests } = recordingFetch(answer);
  const result = await streamTurn({
    chat: createModel(spec, { fetch }),
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    tools,
    ...(reasoning ? { reasoning } : {}),
  });
  return { result, requests };
}

describe('isZai', () => {
  it('is Z.ai’s own host only, exactly', () => {
    for (const url of [
      'https://api.z.ai/api/anthropic/v1',
      'http://api.z.ai/x',
      'https://API.Z.AI/x',
      'https://api.z.ai:443/x',
      'https://user:pw@api.z.ai/x',
    ]) {
      expect(isZai(url), url).toBe(true);
    }
    for (const url of [
      undefined,
      '',
      'api.z.ai',
      'https://api.anthropic.com/v1',
      'https://z.ai',
      'https://x.api.z.ai/v1',
      'https://api.z.ai.evil.com/v1',
      'https://evil.com/api.z.ai',
      'https://api.z.ai@evil.com/v1',
      'https://open.bigmodel.cn/api/anthropic',
      'not a url',
    ]) {
      expect(isZai(url), String(url)).toBe(false);
    }
  });

  it('puts the bearer header only on Z.ai, and only with a key', () => {
    expect(anthropicKeyHeaders('k', URL_ZAI)).toEqual({ 'x-api-key': 'k', authorization: 'Bearer k' });
    expect(anthropicKeyHeaders('k', 'https://api.anthropic.com/v1')).toEqual({ 'x-api-key': 'k' });
    expect(anthropicKeyHeaders(undefined, URL_ZAI)).toEqual({ 'x-api-key': '' });
  });

  it('a non-Z.ai Anthropic provider never gets an authorization header, whatever its address', async () => {
    for (const baseUrl of [
      undefined,
      'https://api.anthropic.com/v1',
      'https://api.z.ai.evil.com/api/anthropic/v1',
      'https://proxy.example/v1',
    ]) {
      const { requests } = await send({ kind: 'anthropic', modelName: 'claude-sonnet-5-5', apiKey: 'secret', baseUrl });
      expect(requests).toHaveLength(1);
      expect(requests[0].headers.get('authorization'), String(baseUrl)).toBeNull();
      expect(requests[0].headers.get('x-api-key')).toBe('secret');
    }
  });
});

describe('the effort Z.ai is sent', () => {
  it('clamps to the levels Z.ai documents: minimal to low, medium to high, xhigh to max', async () => {
    for (const [sent, effort] of [
      ['minimal', 'low'],
      ['low', 'low'],
      ['medium', 'high'],
      ['high', 'high'],
      ['xhigh', 'max'],
      ['max', 'max'],
    ] as const) {
      const { requests } = await send(ZAI, sent);
      expect(requests[0].body.output_config, sent).toEqual({ effort });
      expect(requests[0].body).not.toHaveProperty('thinking');
    }
  });

  it('None keeps the SDK’s disabled thinking, with no effort', async () => {
    const { requests } = await send(ZAI, 'none');
    expect(requests[0].body.thinking).toEqual({ type: 'disabled' });
    expect(requests[0].body).not.toHaveProperty('output_config');
    expect(requests[0].body.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('a 400 naming the effort is answered once more without it, and the turn says so', async () => {
    const { result, requests } = await send(ZAI, 'max', n =>
      n === 1
        ? new Response('{"error":{"message":"unsupported output_config.effort"}}', { status: 400 })
        : new Response('{"error":{"message":"stop here"}}', { status: 400 }),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0].body.output_config).toEqual({ effort: 'max' });
    expect(requests[1].body).not.toHaveProperty('output_config');
    expect(requests[1].body.cache_control).toEqual({ type: 'ephemeral' });
    expect(result.reasoningDropped).toBe(true);
  });
});

describe('withHeaderTimeout', () => {
  it('passes a request through and leaves the body’s abort to the caller', async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const base = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response('ok');
    }) as typeof fetch;
    const caller = new AbortController();
    const response = await withHeaderTimeout(base, 1000)('https://x.test/', { signal: caller.signal, method: 'POST' });
    expect(await response.text()).toBe('ok');
    expect(seen[0]?.aborted).toBe(false);
    caller.abort();
    expect(seen[0]?.aborted).toBe(true);
  });
});

describe('withDeadline', () => {
  it('ends with the caller’s signal at once, or with the time, and says which', async () => {
    vi.useFakeTimers();
    try {
      const a = withDeadline(1000);
      await vi.advanceTimersByTimeAsync(1001);
      expect([a.signal.aborted, a.timedOut()]).toEqual([true, true]);
      const caller = new AbortController();
      const b = withDeadline(1000, caller.signal);
      caller.abort();
      expect([b.signal.aborted, b.timedOut()]).toEqual([true, false]);
      b.done();
      const c = withDeadline(1000);
      c.done();
      await vi.advanceTimersByTimeAsync(2000);
      expect(c.signal.aborted).toBe(false);
      expect(withDeadline(1000, AbortSignal.abort()).signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

const apiError = (status: number, body: string, message = '', headers: Record<string, string> = {}) =>
  new APICallError({
    message,
    url: 'https://api.z.ai',
    requestBodyValues: {},
    statusCode: status,
    responseBody: body,
    responseHeaders: headers,
  });

describe('what an error body says', () => {
  it('reads the reason from each shape', () => {
    expect(bodyReason('{"error":{"message":" bad key "}}')).toBe('bad key');
    expect(bodyReason('{"code":401,"msg":"token expired or incorrect","success":false}')).toBe(
      'token expired or incorrect',
    );
    expect(bodyReason('{"message":"nope"}')).toBe('nope');
    expect(bodyReason('{"error":"plain"}')).toBe('plain');
    expect(bodyReason('<html>')).toBeUndefined();
    expect(bodyReason('{"code":1}')).toBeUndefined();
    expect(bodyReason(undefined)).toBeUndefined();
  });

  it('shows the reason ahead of the raw body, trimmed, with no leading space', () => {
    const body = '{"code":401,"msg":"token expired or incorrect","success":false}';
    expect(errorText(apiError(401, body))).toBe(`token expired or incorrect ${body}`);
    expect(errorText(apiError(401, body, '  '))).toBe(`token expired or incorrect ${body}`);
  });

  it('leaves the usual shape as it was: the SDK’s message and the body', () => {
    const body = '{"type":"error","error":{"type":"x","message":"prompt is too long"}}';
    expect(errorText(apiError(400, body, 'prompt is too long'))).toBe(`prompt is too long ${body}`);
    expect(errorText(apiError(500, '', 'Internal'))).toBe('Internal');
    expect(errorText(new Error('plain'))).toBe('plain');
  });
});

describe('a 429 that is not a rate limit', () => {
  it.each([
    ['1113', '{"error":{"code":"1113","message":"Insufficient balance or no resource package."}}'],
    ['1308', '{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 12:00"}}'],
    ['1309', '{"error":{"code":"1309","message":"Your package has expired"}}'],
    ['1310', '{"error":{"code":"1310","message":"Weekly limit exhausted"}}'],
    ['the envelope', '{"code":1113,"msg":"Insufficient balance","success":false}'],
    [
      'OpenAI',
      '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}',
    ],
  ])('%s is a spent quota: not retried', (_name, body) => {
    expect(isQuotaExhausted(apiError(429, body))).toBe(true);
    expect(isRetryable(apiError(429, body))).toBe(false);
  });

  it.each([
    ['Z.ai’s per-second limit', '{"error":{"code":"1302","message":"Rate limit reached for requests"}}'],
    [
      'Anthropic',
      '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit"}}',
    ],
    [
      'Gemini per minute',
      '{"error":{"message":"You exceeded your current quota. Quota exceeded for metric PerMinute. Please retry in 12s"}}',
    ],
    ['an empty body', ''],
  ])('%s is a rate limit: still retried', (_name, body) => {
    expect(isQuotaExhausted(apiError(429, body))).toBe(false);
    expect(isRetryable(apiError(429, body))).toBe(true);
  });

  it('only a 429 counts; other statuses are classified as before', () => {
    const body = '{"code":1113,"msg":"Insufficient balance"}';
    expect(isQuotaExhausted(apiError(400, body))).toBe(false);
    expect(isRetryable(apiError(503, body))).toBe(true);
    expect(isRetryable(apiError(400, body))).toBe(false);
  });
});

describe('a 400 that names an image', () => {
  it.each([
    'This model does not support image input',
    'Invalid content type. image_url is only supported by certain models.',
    'At most 0 image(s) may be provided in one request.',
    'vision is not supported by this model',
    'The model is not multimodal',
  ])('is a model that takes no images: %s', message => {
    expect(refusesImages(400, message)).toBe(true);
  });

  it.each([
    'messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 6291456 bytes > 5242880 bytes',
    'image dimensions exceed max allowed size: 8000 pixels',
    'messages.0.content.1.image.source.base64.data: invalid base64 data',
    'Could not process image',
    'You uploaded an unsupported image. Please make sure your image is valid.',
    'Image does not match the provided media type image/png',
    'The image is too large',
    'The image data is corrupt',
  ])('is one faulty image, not a refusal of images: %s', message => {
    expect(refusesImages(400, message)).toBe(false);
  });

  it('only a 400 counts', () => {
    expect(refusesImages(500, 'This model does not support image input')).toBe(false);
    expect(refusesImages(undefined, 'image')).toBe(false);
  });
});

describe('Z.ai context overflow', () => {
  it.each([
    ['the message', 'Prompt exceeds max length'],
    ['the 1261 body', '{"error":{"code":"1261","message":"Prompt exceeds max length"}}'],
    ['the envelope', '{"code":1261,"msg":"Prompt exceeds max length","success":false}'],
    ['a longer sentence', 'Input exceeds max length of 200000 tokens'],
  ])('recognises %s', (_name, body) => {
    expect(isContextOverflow(apiError(400, body))).toBe(true);
  });

  it('leaves other 400s and the 429 patterns alone', () => {
    expect(isContextOverflow(apiError(400, '{"error":{"message":"Invalid parameter"}}'))).toBe(false);
    expect(isContextOverflow(apiError(400, '{"error":{"code":"12610","message":"x"}}'))).toBe(false);
    expect(isContextOverflow(apiError(429, 'Request too large for gpt-4o on tokens per min (TPM)'))).toBe(true);
  });
});

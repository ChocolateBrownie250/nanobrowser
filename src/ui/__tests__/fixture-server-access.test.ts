// The fixture server holds the developer's provider keys while NB_LIVE=1. These tests pin who it answers: only
// requests addressed to a loopback name, and on its /__ endpoints only the extension or a client with no Origin.
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isExtensionOrigin, isLoopbackHost, judgeRequest } from '../../../fixtures/access.mjs';
import { startServer } from '../../../fixtures/server.mjs';

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

describe('fixture server access rules', () => {
  it('accepts only loopback names with the server port', () => {
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787', 'LOCALHOST:8787']) {
      expect(isLoopbackHost(host, 8787), host).toBe(true);
    }
    for (const host of [
      undefined,
      '',
      'evil.example:8787',
      'localhost.evil.example:8787',
      'evil.example',
      '192.0.2.2:8787',
      '0.0.0.0:8787',
      'localhost:9999',
      'localhost',
      'localhost:8787@evil.example',
      'user@localhost:8787',
    ]) {
      expect(isLoopbackHost(host as string, 8787), String(host)).toBe(false);
    }
  });

  it('knows an extension origin', () => {
    expect(isExtensionOrigin(EXTENSION)).toBe(true);
    for (const origin of [
      'https://evil.example',
      'null',
      'http://localhost:8787',
      'chrome-extension://short',
      undefined,
    ]) {
      expect(isExtensionOrigin(origin as string), String(origin)).toBe(false);
    }
  });

  it('judges a request by host, then by origin on internal endpoints', () => {
    const base = { host: 'localhost:8787', port: 8787 };
    expect(judgeRequest({ ...base, path: '/__live/keys', origin: undefined })).toEqual({
      ok: true,
      allowOrigin: undefined,
    });
    expect(judgeRequest({ ...base, path: '/__live/keys', origin: EXTENSION })).toEqual({
      ok: true,
      allowOrigin: EXTENSION,
    });
    expect(judgeRequest({ ...base, path: '/__live/keys', origin: 'https://evil.example' })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(judgeRequest({ ...base, path: '/__posthog/i/v0/e/', origin: 'http://localhost:8787' })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(judgeRequest({ ...base, path: '/a-page.html', origin: 'https://evil.example' })).toEqual({
      ok: true,
      allowOrigin: '*',
    });
    expect(judgeRequest({ ...base, host: 'evil.example:8787', path: '/a-page.html', origin: undefined })).toMatchObject(
      {
        ok: false,
        status: 421,
      },
    );
  });
});

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

describe('fixture server over a socket', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const saved = { live: process.env.NB_LIVE, key: process.env.ANTHROPIC_API_KEY };

  beforeAll(async () => {
    process.env.NB_LIVE = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-not-a-real-key';
    server = await startServer(0);
  });
  afterAll(async () => {
    await server.close();
    for (const [name, value] of [
      ['NB_LIVE', saved.live],
      ['ANTHROPIC_API_KEY', saved.key],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const get = (path: string, headers: Record<string, string> = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path, headers }, res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });

  it('hands the keys to a plain client and to the extension, with no wildcard CORS', async () => {
    const plain = await get('/__live/keys');
    expect(plain.status).toBe(200);
    expect(JSON.parse(plain.body).anthropic).toBe('sk-ant-not-a-real-key');
    expect(plain.headers['access-control-allow-origin']).toBeUndefined();

    const extension = await get('/__live/keys', { origin: EXTENSION });
    expect(extension.status).toBe(200);
    expect(extension.headers['access-control-allow-origin']).toBe(EXTENSION);
  });

  it('refuses a web page on another origin and a foreign Host header, without keys or CORS headers', async () => {
    const refused: Array<Record<string, string>> = [
      { origin: 'https://evil.example' },
      { host: 'evil.example' },
      { host: 'evil.example:80' },
    ];
    for (const headers of refused) {
      const reply = await get('/__live/keys', headers);
      expect([403, 421], JSON.stringify(headers)).toContain(reply.status);
      expect(reply.body).not.toContain('sk-ant');
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('serves a static page on the loopback address', async () => {
    const reply = await get('/index.html');
    expect(reply.status).toBeLessThan(500);
    expect(reply.headers['access-control-allow-origin']).toBe('*');
  });
});

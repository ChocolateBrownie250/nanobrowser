// The probe in a real Chrome: what a fake DOM cannot show. Runs only where a Chrome for Testing is cached
// (`pnpm install-chrome`, or CHROME_PATH); elsewhere the tests are skipped. Chrome is always started with
// --use-mock-keychain, so it never reaches a real keychain.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launch } from 'puppeteer-core';
import type { Browser, CDPSession, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBE_SOURCE } from '../index';

function findChrome(): string | null {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const root = join(homedir(), '.cache', 'puppeteer', 'chrome');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root).sort().reverse()) {
    for (const rel of [
      'chrome-linux64/chrome',
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-win64/chrome.exe',
    ]) {
      const path = join(root, dir, rel);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

const chrome = findChrome();

/** A page with the probe installed in an isolated world, and a way to call its methods on an element by selector. */
async function withProbe(browser: Browser, html: string) {
  const page: Page = await browser.newPage();
  await page.setContent(html);
  const cdp: CDPSession = await page.createCDPSession();
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const frameId = frameTree.frame.id;
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'nb-test' });
  const installed = await cdp.send('Runtime.evaluate', { expression: PROBE_SOURCE, contextId: executionContextId });
  if (installed.exceptionDetails) throw new Error(`probe install failed: ${installed.exceptionDetails.text}`);
  /** Calls `probe[method](element, ...args)`; a call that does not answer in 5 s is reported as a hang. */
  const call = async (selector: string, method: string, ...args: unknown[]): Promise<unknown> => {
    const el = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      contextId: executionContextId,
    });
    const answer = await Promise.race([
      cdp.send('Runtime.callFunctionOn', {
        objectId: el.result.objectId!,
        functionDeclaration: `function (...args) { return globalThis.__nbProbe[${JSON.stringify(method)}](this, ...args); }`,
        arguments: args.map(value => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      }),
      new Promise<'hang'>(resolve => setTimeout(() => resolve('hang'), 5000)),
    ]);
    if (answer === 'hang') throw new Error(`${method} did not answer`);
    if (answer.exceptionDetails) {
      throw new Error(
        `${method} threw: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`,
      );
    }
    return answer.result.value;
  };
  const evaluate = async (expression: string): Promise<unknown> => {
    const r = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { page, call, evaluate };
}

describe.skipIf(!chrome)('the probe in Chrome', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launch({
      executablePath: chrome!,
      headless: true,
      pipe: true,
      args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'],
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  // A control named like a form member shadows that member on the form (LegacyOverrideBuiltIns): `form.closest` is the
  // input, not the method. A page can do this on purpose to blind the layer's reads.
  describe('form members shadowed by a named control', () => {
    const names = ['closest', 'getRootNode', 'id', 'parentNode', 'tagName', 'getAttribute', 'hasAttribute', 'matches'];
    for (const name of names) {
      it(`still reads the form and the destination when a control is named "${name}"`, async () => {
        const { page, call } = await withProbe(
          browser,
          `<!doctype html><body><form id="f" action="http://example.test/ok" method="post" role="dialog">
             <input name="${name}" value="x"><input id="t" type="text" name="q"><button id="b" type="submit">Pay now</button>
           </form>`,
        );
        try {
          const button = (await call('#b', 'formFacts')) as { submitter: boolean; form: { method: string } | null };
          expect(button.submitter).toBe(true);
          expect(button.form?.method).toBe('post');
          const enter = (await call('#t', 'navigationTarget', 'enter')) as { kind: string; url: string } | null;
          expect(enter?.kind).toBe('form');
          expect(enter?.url).toMatch(/\/ok$/);
          expect(((await call('#b', 'navigationTarget', 'activate')) as { kind: string } | null)?.kind).toBe('form');
          expect(((await call('#f', 'state')) as { id: string }).id).toBe('f');
          await call('#f', 'describe');
          await call('#b', 'watchBlock');
          await call('#t', 'contextOf');
          await call('#f', 'nameSources');
          await call('#b', 'approximateName');
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  });

  describe('select options', () => {
    const html = `<!doctype html><select id="s"><option value="a">Keep</option><option value="b">Delete account</option>
      <option value="c" label="Archive">Move to archive</option></select>`;

    it('matchOptions names the matched option and changes nothing', async () => {
      const { page, call, evaluate } = await withProbe(browser, html);
      try {
        await evaluate(
          `window.__changes = 0; document.getElementById('s').addEventListener('change', () => window.__changes++)`,
        );
        const result = (await call('#s', 'matchOptions', ['Delete account'])) as {
          ok: boolean;
          requested: Array<{ index: number; label: string }>;
        };
        expect(result.ok).toBe(true);
        expect(result.requested.map(o => o.label)).toEqual(['Delete account']);
        expect(await evaluate(`document.getElementById('s').selectedIndex`)).toBe(0);
        expect(await evaluate('window.__changes')).toBe(0);
        // The option the label attribute renames is matched by either name, and both are available to judge.
        const renamed = (await call('#s', 'matchOptions', ['Archive'])) as {
          requested: Array<{ label: string; text?: string }>;
        };
        expect(renamed.requested[0].label).toBe('Archive');
        expect(renamed.requested[0].text).toBe('Move to archive');
      } finally {
        await page.close();
      }
    });

    it('selectOption selects what matchOptions matched, and fires change once', async () => {
      const { page, call, evaluate } = await withProbe(browser, html);
      try {
        await evaluate(
          `window.__changes = 0; document.getElementById('s').addEventListener('change', () => window.__changes++)`,
        );
        const result = (await call('#s', 'selectOption', ['b'])) as { ok: boolean; selected: string[] };
        expect(result.ok).toBe(true);
        expect(result.selected).toEqual(['Delete account']);
        expect(await evaluate(`document.getElementById('s').selectedIndex`)).toBe(1);
        expect(await evaluate('window.__changes')).toBe(1);
        const missing = (await call('#s', 'selectOption', ['nope'])) as { ok: boolean; error?: string };
        expect(missing.ok).toBe(false);
        expect(missing.error).toBe('NO_SUCH_OPTION');
      } finally {
        await page.close();
      }
    });
  });

  describe('uploaded chunks', () => {
    const html = '<!doctype html><input id="f" type="file" multiple>';

    it('setFiles builds the files from their chunks and keeps nothing', async () => {
      const { page, call } = await withProbe(browser, html);
      try {
        await call('#f', 'fileChunk', 'k1', 'QUJD');
        const files = (await call('#f', 'setFiles', [{ key: 'k1', name: 'a.txt', mimeType: 'text/plain' }])) as Array<{
          name: string;
          size: number;
        }>;
        expect(files).toEqual([expect.objectContaining({ name: 'a.txt', size: 3 })]);
        // The chunks are gone: the same key builds an empty file now.
        const again = (await call('#f', 'setFiles', [{ key: 'k1', name: 'b.txt', mimeType: 'text/plain' }])) as Array<{
          size: number;
        }>;
        expect(again[0].size).toBe(0);
      } finally {
        await page.close();
      }
    });

    it('a setFiles that fails leaves none of its chunks behind, the other keys of the call included', async () => {
      const { page, call } = await withProbe(browser, html);
      try {
        await call('#f', 'fileChunk', 'good', 'QUJD');
        await call('#f', 'fileChunk', 'bad', '***not base64***');
        await expect(
          call('#f', 'setFiles', [
            { key: 'bad', name: 'bad.txt', mimeType: 'text/plain' },
            { key: 'good', name: 'good.txt', mimeType: 'text/plain' },
          ]),
        ).rejects.toThrow(/setFiles threw/);
        expect(await call('#f', 'dropFiles', ['good', 'bad'])).toBe(0);
      } finally {
        await page.close();
      }
    });

    it('dropFiles forgets the chunks of a call that failed before setFiles', async () => {
      const { page, call } = await withProbe(browser, html);
      try {
        await call('#f', 'fileChunk', 'k', 'QUJD');
        await call('#f', 'fileChunk', 'k', 'QUJD');
        expect(await call('#f', 'dropFiles', ['k', 'unknown'])).toBe(1);
        expect(await call('#f', 'dropFiles', ['k'])).toBe(0);
      } finally {
        await page.close();
      }
    });
  });
});

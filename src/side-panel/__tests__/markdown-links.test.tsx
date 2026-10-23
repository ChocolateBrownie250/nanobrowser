// An image inside a link, the table's CSV, and the Markdown component's memoisation.
import '@src/ui/__tests__/dom-env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { act } from 'react';
import { setLanguage, t } from '@src/ui/i18n';
import { Markdown, toCsv } from '../Markdown';

const IMAGE_IN_LINK = '[![chart](https://img.example/p.png)](https://evil.example/go)';

describe('an image inside a link', () => {
  it('is drawn beside the link, never inside the anchor', () => {
    const html = renderToStaticMarkup(<Markdown text={IMAGE_IN_LINK} />);
    expect(html).toContain('<button');
    expect(html).toContain('href="https://evil.example/go"');
    // No interactive content inside the anchor.
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>)[\s\S])*<button/);
    // The link keeps something to click: its address.
    expect(html).toMatch(/<a [^>]*>evil\.example<\/a>/);
  });

  it('keeps the link text when there is some, and finds an image inside emphasis', () => {
    const html = renderToStaticMarkup(
      <Markdown text="[see **![x](https://img.example/p.png)** here](https://a.example/p)" />,
    );
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>)[\s\S])*<button/);
    expect(html).toMatch(/<a [^>]*>see <strong><\/strong> here/);
  });

  describe('in a DOM', () => {
    let host: HTMLElement;
    let root: Root;
    const create = vi.fn();
    beforeEach(() => {
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      create.mockReset();
      (globalThis as Record<string, unknown>).chrome = { tabs: { create } };
    });
    afterEach(() => {
      act(() => root.unmount());
      host.remove();
      delete (globalThis as Record<string, unknown>).chrome;
    });

    it('clicking the placeholder shows the image and does not open the link', () => {
      act(() => root.render(<Markdown text={IMAGE_IN_LINK} />));
      const button = host.querySelector('button')!;
      expect(button.closest('a')).toBeNull();
      act(() => {
        button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
      });
      expect(create).not.toHaveBeenCalled();
      const img = host.querySelector('img')!;
      expect(img.getAttribute('src')).toBe('https://img.example/p.png');
      expect(img.closest('a')).toBeNull();
      // The link itself still opens in a tab.
      act(() => {
        host.querySelector('a')!.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
      });
      expect(create).toHaveBeenCalledWith({ url: 'https://evil.example/go', active: true });
    });
  });
});

describe('a settled answer and the language', () => {
  let host: HTMLElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    act(() => root.unmount());
    host.remove();
    await act(async () => setLanguage('en'));
  });

  it('shows the labels of its tables in the new language without being re-rendered by its parent', async () => {
    // One element, rendered once: only a subscription of the component itself can follow the language.
    const answer = <Markdown text={'| a | b |\n| - | - |\n| 1 | 2 |'} />;
    act(() => root.render(answer));
    expect(host.textContent).toContain(t('markdown.saveCsv'));
    const english = t('markdown.saveCsv');
    await act(async () => setLanguage('zh_CN'));
    expect(t('markdown.saveCsv')).not.toBe(english);
    expect(host.textContent).toContain(t('markdown.saveCsv'));
    expect(host.textContent).not.toContain(english);
  });
});

describe('toCsv', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])('neutralises a cell that starts with %j', lead => {
    const cell = `${lead}SUM(A1)`;
    const csv = toCsv([[cell, 'b']]);
    expect(csv.startsWith(`'${lead}`) || csv.startsWith(`"'${lead}`)).toBe(true);
    expect(csv.endsWith(',b')).toBe(true);
  });

  it('keeps a plain signed number, and still neutralises anything with an operator or a name in it', () => {
    expect(toCsv([['-5', '+1.5', '-3.2%', '-1,5']])).toBe('-5,+1.5,-3.2%,"-1,5"');
    expect(toCsv([['-A1', '=1+1', '-1+1', '+3-2', "+cmd|' /C calc'!A0"]])).toBe(
      "'-A1,'=1+1,'-1+1,'+3-2,'+cmd|' /C calc'!A0",
    );
  });

  it('prefixes before quoting, and leaves ordinary cells alone', () => {
    expect(toCsv([['=HYPERLINK("https://e.example","x")', 'plain', 'a,b', 'say "hi"', 'x=1', '']])).toBe(
      `"'=HYPERLINK(""https://e.example"",""x"")",plain,"a,b","say ""hi""",x=1,`,
    );
    expect(
      toCsv([
        ['a', 'b'],
        ['c', 'd'],
      ]),
    ).toBe('a,b\nc,d');
  });
});

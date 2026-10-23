import { describe, expect, it } from 'vitest';
import {
  allows,
  combinePolicies,
  hasLists,
  isBlankPage,
  isBlockedSite,
  isBrowserErrorPage,
  isRestrictedPageUrl,
  isUrlAllowed,
  normalizePolicy,
  siteKey,
} from '../url-policy';

describe('isUrlAllowed (Nanobrowser rules)', () => {
  it('always blocks dangerous schemes and the Web Store, even with empty lists', () => {
    for (const url of [
      'chrome://settings',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'https://chromewebstore.google.com/x',
      'wss://x',
    ]) {
      expect(isUrlAllowed(url, [], [])).toBe(false);
    }
    expect(isUrlAllowed('', [], [])).toBe(false);
    expect(isUrlAllowed('https://example.com', [], [])).toBe(true);
  });

  it('applies the deny list to a domain and its subdomains', () => {
    expect(isUrlAllowed('https://evil.test/x', [], ['evil.test'])).toBe(false);
    expect(isUrlAllowed('https://a.evil.test/x', [], ['evil.test'])).toBe(false);
    expect(isUrlAllowed('https://notevil.test/x', [], ['evil.test'])).toBe(true);
  });

  it('reads a host written with a trailing dot as the same host', () => {
    expect(isUrlAllowed('https://evil.test./x', [], ['evil.test'])).toBe(false);
    expect(isUrlAllowed('https://a.evil.test./x', [], ['evil.test'])).toBe(false);
    expect(isUrlAllowed('https://good.test./a', ['good.test'], [])).toBe(true);
    // The same for an entry the user wrote with the dot.
    const dotted = normalizePolicy({ allow: [], deny: ['https://evil.test./'] });
    expect(dotted.deny).toEqual(['evil.test']);
    expect(isUrlAllowed('https://evil.test./checkout', dotted.allow, dotted.deny)).toBe(false);
    expect(isUrlAllowed('https://evil.test/checkout', dotted.allow, dotted.deny)).toBe(false);
  });

  it('allows only listed domains once an allow list exists', () => {
    expect(isUrlAllowed('https://good.test/a', ['good.test'], [])).toBe(true);
    expect(isUrlAllowed('https://other.test/a', ['good.test'], [])).toBe(false);
    expect(isUrlAllowed('about:blank', ['good.test'], [])).toBe(true);
  });

  it('matches exact URLs before domains', () => {
    expect(isUrlAllowed('https://good.test/blocked', ['good.test'], ['good.test/blocked'])).toBe(false);
    // An exact URL entry is checked before domain entries, so it wins over a domain deny.
    expect(isUrlAllowed('https://bad.test/ok', ['bad.test/ok'], ['bad.test'])).toBe(true);
  });

  it('judges a blob: URL by the origin that created it', () => {
    expect(isUrlAllowed('blob:https://evil.test/1234-uuid', [], ['evil.test'])).toBe(false);
    expect(isUrlAllowed('blob:https://good.test/1234-uuid', ['good.test'], [])).toBe(true);
  });

  it('handles the fixture hosts, ports included', () => {
    expect(isUrlAllowed('http://127.0.0.1:8787/x', [], ['127.0.0.1'])).toBe(false);
    expect(isUrlAllowed('http://localhost:8787/x', [], ['127.0.0.1'])).toBe(true);
  });
});

describe('isUrlAllowed (the scheme is judged on the parsed address)', () => {
  // Chrome's URL parser turns "chrome:x", "chrome:/x" and "Chrome:x" into chrome://x/; the text prefix did not.
  it.each([
    'chrome:kill',
    'chrome:/version',
    'Chrome:settings',
    'CHROME://settings',
    ' chrome://settings ',
    'edge://settings',
    'edge:settings',
    'view-source:https://x.test/',
    'devtools://x',
    'chrome-untrusted://x',
    'chrome-extension://abc/page.html',
    'chrome-search://local-ntp/',
    'chrome-error://chromewebcontrols/',
    'filesystem:https://x.test/x',
    'ftp://x.test/',
    'about:flags',
    'about:blank#x',
    'about:blank?x',
    'javascript:alert(1)',
    'java\tscript:alert(1)',
    'vbscript:x',
    'data:text/html,x',
    'file:///etc/passwd',
    'ws://x.test/',
    'wss://x.test/',
    'blob:null/1234',
    'blob:about:blank',
    'not a url',
    '',
    '   ',
  ])('refuses %j whatever the lists say', url => {
    expect(isUrlAllowed(url, [], [])).toBe(false);
    expect(allows({ allow: [], deny: [], blocked: [] }, url)).toBe(false);
    expect(combinePolicies([{ allow: [], deny: [] }])(url)).toBe(false);
  });

  it.each([
    'http://127.0.0.1:8787/x.html',
    'https://example.com',
    'HTTPS://Example.COM/x',
    'about:blank',
    'about:blank ',
  ])('accepts %j', url => {
    expect(isUrlAllowed(url, [], [])).toBe(true);
  });

  it('judges the Web Store by its host, not by the start of the text', () => {
    expect(isUrlAllowed('https://chromewebstore.google.com/detail/x', [], [])).toBe(false);
    expect(isUrlAllowed('https://chromewebstore.google.com./detail/x', [], [])).toBe(false);
    expect(isUrlAllowed('https://CHROMEWEBSTORE.google.com:443/', [], [])).toBe(false);
    expect(isUrlAllowed('https://chrome.google.com/webstore/detail/x', [], [])).toBe(false);
    expect(isUrlAllowed('https://chromewebstore.google.com.evil.test/', [], [])).toBe(true);
    expect(isUrlAllowed('https://chrome.google.com/other', [], [])).toBe(true);
    expect(isUrlAllowed('https://evil.test/https://chromewebstore.google.com', [], [])).toBe(true);
  });

  it('judges a blob: URL by the address that made it, with or without lists', () => {
    expect(isUrlAllowed('blob:https://good.test/uuid', [], [])).toBe(true);
    expect(isUrlAllowed('blob:chrome://settings/uuid', [], [])).toBe(false);
    expect(isUrlAllowed('blob:https://evil.test/uuid', [], ['evil.test'])).toBe(false);
  });

  it('compares an exact-URL entry with the address as the browser reads it', () => {
    expect(isUrlAllowed('https:bad.test/ok', [], ['bad.test/ok'])).toBe(false);
    expect(isUrlAllowed('HTTPS://BAD.test/ok', [], ['bad.test/ok'])).toBe(false);
    expect(isUrlAllowed('https://bad.test', [], ['bad.test'])).toBe(false);
    expect(isUrlAllowed('https://other.test/ok', [], ['bad.test/ok'])).toBe(true);
  });

  it('keeps layers 1 to 4 aligned with the pages the debugger cannot attach to', () => {
    const restricted = [
      'chrome://settings',
      'chrome:kill',
      'Chrome:x',
      'chrome-extension://abc/x.html',
      'chrome-search://x/',
      'chrome-untrusted://x/',
      'devtools://devtools/bundled/x.html',
      'edge://settings',
      'view-source:https://x.test/',
      'https://chromewebstore.google.com/',
      'https://chrome.google.com/webstore/category/extensions',
    ];
    for (const url of restricted) {
      expect(isRestrictedPageUrl(url), url).toBe(true);
      expect(isUrlAllowed(url, [], []), url).toBe(false);
    }
    for (const url of ['', 'about:blank', 'https://chromewebstore.google.com.evil.test/', 'http://localhost:3000/']) {
      expect(isRestrictedPageUrl(url), url).toBe(false);
    }
  });

  it('knows the blank page and the error page of a failed load', () => {
    expect(isBlankPage('about:blank#blocked')).toBe(true);
    expect(isBlankPage('about:flags')).toBe(false);
    expect(isBlankPage('https://about.blank/')).toBe(false);
    expect(isBrowserErrorPage('chrome-error://chromewebcontrols/')).toBe(true);
    expect(isBrowserErrorPage('chrome://error/')).toBe(false);
  });
});

describe('Unicode entries in the lists', () => {
  it('match the punycode host an address has', () => {
    const deny = normalizePolicy({ allow: [], deny: ['münchen.de', 'https://Bücher.Example/Café/'] });
    expect(deny.deny).toEqual(['xn--mnchen-3ya.de', 'xn--bcher-kva.example/caf%c3%a9']);
    expect(isUrlAllowed('https://münchen.de/', deny.allow, deny.deny)).toBe(false);
    expect(isUrlAllowed('https://shop.münchen.de/x', deny.allow, deny.deny)).toBe(false);
    expect(isUrlAllowed('https://xn--mnchen-3ya.de/', deny.allow, deny.deny)).toBe(false);
    expect(isUrlAllowed('https://bücher.example/café', deny.allow, deny.deny)).toBe(false);
    expect(isUrlAllowed('https://bücher.example/other', deny.allow, deny.deny)).toBe(true);
    const allow = normalizePolicy({ allow: ['münchen.de'], deny: [] });
    expect(isUrlAllowed('https://münchen.de/', allow.allow, allow.deny)).toBe(true);
    expect(isUrlAllowed('https://other.de/', allow.allow, allow.deny)).toBe(false);
  });
});

describe('policy helpers', () => {
  it('normalises entries', () => {
    expect(normalizePolicy({ allow: [' HTTPS://Example.com/ ', ''], deny: ['a.test', 'a.test'] })).toEqual({
      allow: ['example.com'],
      deny: ['a.test'],
      blocked: [],
    });
  });

  it('combines policies most restrictively', () => {
    const allowed = combinePolicies([
      { allow: [], deny: ['a.test'] },
      { allow: ['a.test', 'b.test'], deny: [] },
    ]);
    expect([allowed('https://a.test'), allowed('https://b.test'), allowed('https://c.test')]).toEqual([
      false,
      true,
      false,
    ]);
  });
});

describe('blocked sites', () => {
  it('cover the subdomains of a blocked host, and an IP address only whole', () => {
    expect(isBlockedSite('https://mail.example.com/', ['example.com'])).toBe(true);
    expect(isBlockedSite('https://example.com.evil.test/', ['example.com'])).toBe(false);
    expect(isBlockedSite('http://10.1.2.3/', ['2.3'])).toBe(false);
    expect(isBlockedSite('http://10.1.2.3/', ['10.1.2.3'])).toBe(true);
    expect(isBlockedSite('http://[::1]:3000/', ['[::1]:3000'])).toBe(true);
    expect(isBlockedSite('http://[::1]:3000/', ['[::1]'])).toBe(false);
  });

  const policy = normalizePolicy({
    allow: [],
    deny: [],
    blocked: ['Example.com', 'https://www.shop.example/', 'localhost:3000'],
  });

  it('keys each row with siteOf', () => {
    expect(policy.blocked).toEqual(['example.com', 'shop.example', 'localhost:3000']);
  });

  it.each([
    ['https://example.com/x', false],
    ['http://www.example.com./y', false],
    ['https://mail.example.com/', false],
    ['https://a.b.example.com:8443/', true],
    ['https://notexample.com/', true],
    ['https://example.com.evil.test/', true],
    ['https://mail.shop.example/', false],
    ['http://sub.localhost:3000/', false],
    ['http://sub.localhost:8080/', true],
    ['blob:https://mail.example.com/uuid', false],
    ['https://shop.example/cart?x=1', false],
    ['http://localhost:3000/path', false],
    ['http://localhost:8080/path', true],
    ['blob:https://example.com/uuid', false],
  ])('%s allowed: %s', (url, allowed) => {
    expect(allows(policy, url)).toBe(allowed);
    expect(isBlockedSite(url, policy.blocked)).toBe(!allowed);
  });

  it('counts as a list for layer 3', () => {
    expect(hasLists(policy)).toBe(true);
    expect(siteKey('  WWW.Example.COM ')).toBe('example.com');
  });
});

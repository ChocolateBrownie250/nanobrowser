// The navigation policy: Nanobrowser's isUrlAllowed (src/background/browser/util.ts at ad47282): the schemes the layer
// may drive, then a deny list and an allow list of domains or exact URLs. The scheme test is made on the parsed
// address, as an allow-list. Product sessions add a list of blocked sites, matched with siteOf.
import { siteOf } from './site';

export interface UrlPolicy {
  allow: string[];
  deny: string[];
  /**
   * Blocked sites, matched with `siteOf`: the host and its subdomains (the port must match). A row covers the same
   * addresses as an Allow or Ask row, and the pages below them. The deny and allow lists keep their own rules for the
   * test panel.
   */
  blocked?: string[];
}

export const EMPTY_POLICY: UrlPolicy = { allow: [], deny: [], blocked: [] };

/** A site as a user may type it ("Example.com", "https://www.example.com/x", "localhost:3000"), as `siteOf` keys it. */
export function siteKey(entry: string): string {
  const e = entry.trim();
  if (!e) return '';
  return siteOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(e) ? e : `http://${e}`);
}

/** Splits a site key into its host and its port ("[::1]:80" and "a.test:80" alike); the port is '' when there is none. */
function splitSite(site: string): { host: string; port: string } {
  const match = /^(.*?)(?::(\d+))?$/.exec(site);
  return { host: match?.[1] ?? site, port: match?.[2] ?? '' };
}

/**
 * Whether an address loads a blocked site: the site itself or any subdomain of it ("example.com" blocks
 * "mail.example.com"; the port must match), or for a blob: URL the site that made it. An IP address matches whole only.
 */
export function isBlockedSite(url: string, blocked: readonly string[] | undefined): boolean {
  if (!blocked?.length) return false;
  const trimmed = url.trim();
  const site = siteOf(trimmed.toLowerCase().startsWith('blob:') ? trimmed.slice(5) : trimmed);
  if (!site) return false;
  if (blocked.includes(site)) return true;
  const { host, port } = splitSite(site);
  if (host.startsWith('[') || /^[\d.]+$/.test(host)) return false;
  return blocked.some(entry => {
    const rule = splitSite(entry);
    return rule.port === port && host.endsWith(`.${rule.host}`);
  });
}

/**
 * The parsed address when the layer may drive it, else null: only http(s) and exactly about:blank. Chrome
 * canonicalises "chrome:x", "chrome:/x" and "Chrome:x" to chrome://x/, so the scheme is judged on the parsed address,
 * never on its text, and every other scheme is refused (chrome, edge, devtools, view-source, file, data, javascript,
 * ftp, ws, ...). A blob: URL is judged by the address that made it.
 */
function drivableUrl(url: string): URL | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  switch (parsed.protocol) {
    case 'http:':
    case 'https:':
      return parsed;
    case 'about:':
      return parsed.href === 'about:blank' ? parsed : null;
    case 'blob:': {
      // What follows "blob:" must itself be an http(s) address (an opaque "null" origin has none), and not another blob.
      let inner: URL;
      try {
        inner = new URL(trimmed.slice(5));
      } catch {
        return null;
      }
      return inner.protocol === 'http:' || inner.protocol === 'https:' ? inner : null;
    }
    default:
      return null;
  }
}

/** The Chrome Web Store (both addresses): scripts are not allowed to be injected into it. */
function isWebStore(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'chromewebstore.google.com' ||
    (host === 'chrome.google.com' && parsed.pathname.toLowerCase().startsWith('/webstore'))
  );
}

/** Whether an address is the blank page, with any fragment or query (Chrome shows "about:blank#blocked"). */
export function isBlankPage(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'about:' && parsed.pathname === 'blank';
  } catch {
    return false;
  }
}

/** The page Chrome shows for a navigation that failed. Nothing was loaded, so there is no page to judge. */
export function isBrowserErrorPage(url: string): boolean {
  try {
    return new URL(url.trim()).protocol === 'chrome-error:';
  } catch {
    return false;
  }
}

/** Schemes of the browser's own pages, which the debugger cannot attach to. */
const BROWSER_SCHEMES = new Set([
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'view-source:',
]);

/**
 * Pages the debugger cannot attach to: the browser's own pages and the extension store. Judged on the parsed
 * address, like `isUrlAllowed`, which refuses all of them too (a unit test keeps the two in step). An address that
 * does not parse, such as the empty address of a tab that is still opening, is not restricted.
 */
export function isRestrictedPageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  return BROWSER_SCHEMES.has(parsed.protocol) || isWebStore(parsed);
}

export function isUrlAllowed(url: string, allowList: string[], denyList: string[]): boolean {
  const parsedUrl = drivableUrl(url);
  if (!parsedUrl || isWebStore(parsedUrl)) return false;
  if (allowList.length === 0 && denyList.length === 0) return true;
  if (parsedUrl.protocol === 'about:') return true;
  // A blob: URL belongs to the origin that created it; judge it by that origin (its hostname would be empty).
  const trimmedUrl = url.trim();
  const judged = trimmedUrl.toLowerCase().startsWith('blob:') ? trimmedUrl.slice(5) : trimmedUrl;
  // Exact-URL entries are compared with the address as written and as the browser reads it ("https:a.test/x").
  const href = parsedUrl.href.toLowerCase().replace(/^https?:\/\//, '');
  const exact = new Set([judged.toLowerCase().replace(/^https?:\/\//, ''), href, href.replace(/\/$/, '')]);
  for (const deniedEntry of denyList) if (exact.has(deniedEntry)) return false;
  for (const allowedEntry of allowList) if (exact.has(allowedEntry)) return true;
  // A fully qualified name ("example.com.") is the same host as the name without its last dot.
  let domain = parsedUrl.hostname.toLowerCase().replace(/\.$/, '');
  const portIndex = domain.indexOf(':');
  if (portIndex > -1 && !domain.startsWith('[')) domain = domain.substring(0, portIndex);
  for (const deniedEntry of denyList) {
    if (domain === deniedEntry || domain.endsWith(`.${deniedEntry}`)) return false;
  }
  for (const allowedEntry of allowList) {
    if (domain === allowedEntry || domain.endsWith(`.${allowedEntry}`)) return true;
  }
  return allowList.length === 0;
}

/**
 * One deny or allow entry as the user typed it: lower case, no scheme, no trailing slash, the host as the browser
 * reads it (a Unicode name in punycode, as `isUrlAllowed` sees the host of an address).
 */
function normalizeEntry(entry: string): string {
  let e = entry
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '');
  if (e && !e.includes('://')) {
    try {
      e = new URL(`http://${e}`).href.slice('http://'.length).toLowerCase();
    } catch {
      // Not an address; kept as typed.
    }
  }
  return (
    e
      .replace(/\/$/, '')
      // A bare host written with its last dot ("example.com.") is the host without it, as in isUrlAllowed.
      .replace(/^([^/]+)\.$/, '$1')
  );
}

/** Normalises list entries as the user types them. */
export function normalizePolicy(policy: UrlPolicy): UrlPolicy {
  const clean = (list: string[]) => [...new Set(list.map(normalizeEntry).filter(Boolean))];
  return {
    allow: clean(policy.allow),
    deny: clean(policy.deny),
    blocked: [...new Set((policy.blocked ?? []).map(siteKey).filter(Boolean))],
  };
}

export function allows(policy: UrlPolicy, url: string): boolean {
  return !isBlockedSite(url, policy.blocked) && isUrlAllowed(url, policy.allow, policy.deny);
}

/** Layer 3 runs only when a list is configured; the always-blocked schemes are covered by layers 1, 2 and 4. */
export function hasLists(policy: UrlPolicy): boolean {
  return policy.allow.length > 0 || policy.deny.length > 0 || (policy.blocked?.length ?? 0) > 0;
}

/** The most restrictive combination: a URL passes only if every policy allows it. */
export function combinePolicies(policies: UrlPolicy[]): (url: string) => boolean {
  return url => policies.every(p => allows(p, url)) && isUrlAllowed(url, [], []);
}

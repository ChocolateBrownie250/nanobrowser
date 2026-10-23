// The manifest that wxt.config.ts declares, key by key, and the keys it must not have. A permission, a page that web
// sites can load, or an external caller added to the manifest fails here, not only in a by-hand look at the warnings.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPTIONAL_PERMISSIONS, REQUIRED_PERMISSIONS } from '../manifest-permissions';

// Keys that would open the extension to web sites or other extensions, or change its script policy.
const FORBIDDEN_KEYS = [
  'externally_connectable',
  'web_accessible_resources',
  'content_scripts',
  'content_security_policy',
  'chrome_url_overrides',
  'devtools_page',
  'omnibox',
  'sandbox',
];

/** The product's manifest as wxt.config.ts declares it: loaded with no autorun variables, so the product's lists apply. */
async function productManifest(): Promise<Record<string, unknown>> {
  vi.resetModules();
  const config = (await import('../../../wxt.config')).default as { manifest?: unknown };
  expect(typeof config.manifest, 'wxt.config.ts declares the manifest as an object').toBe('object');
  return config.manifest as Record<string, unknown>;
}

describe('the manifest wxt.config.ts declares', () => {
  beforeEach(() => {
    vi.stubEnv('WXT_AUTORUN_URL', '');
    vi.stubEnv('WXT_PRODUCT_PERMISSIONS', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('has exactly these keys and values', async () => {
    const manifest = await productManifest();
    expect(manifest).toEqual({
      name: '__MSG_extName__',
      description: '__MSG_extDescription__',
      default_locale: 'en',
      minimum_chrome_version: '125',
      host_permissions: ['<all_urls>'],
      permissions: [...REQUIRED_PERMISSIONS],
      optional_permissions: [...OPTIONAL_PERMISSIONS],
      action: { default_icon: 'icon-32.png', default_title: '__MSG_actionTitle__' },
      icons: { 128: 'icon-128.png' },
      commands: {
        'open-panel': { suggested_key: { default: 'Alt+Shift+N' }, description: '__MSG_commandOpenPanel__' },
        'open-test-panel': { description: 'Open the browser control test panel (developers)' },
      },
    });
  });

  it('requires these permissions and no others', async () => {
    const manifest = await productManifest();
    expect([...(manifest.permissions as string[])].sort()).toEqual(
      [
        'alarms',
        'contextMenus',
        'debugger',
        'offscreen',
        'scripting',
        'sidePanel',
        'storage',
        'tabs',
        'unlimitedStorage',
        'webNavigation',
      ].sort(),
    );
    expect([...(manifest.optional_permissions as string[])].sort()).toEqual(
      ['downloads', 'downloads.open', 'notifications', 'tabGroups'].sort(),
    );
  });

  it('has none of the keys that open the extension to web pages, other extensions or a looser script policy', async () => {
    const manifest = await productManifest();
    for (const key of FORBIDDEN_KEYS) expect(manifest, key).not.toHaveProperty(key);
  });
});

// The built manifest, when `pnpm build` has run: the same rules on what Chrome loads, after WXT's own additions.
const built = resolve(import.meta.dirname, '../../../dist/manifest.json');
describe.skipIf(!existsSync(built))('the built dist/manifest.json (skipped until pnpm build has produced it)', () => {
  const manifest = () => JSON.parse(readFileSync(built, 'utf8')) as Record<string, unknown>;

  it('has the product permission lists and no forbidden keys', () => {
    const m = manifest();
    expect([...(m.permissions as string[])].sort()).toEqual([...REQUIRED_PERMISSIONS].sort());
    expect([...(m.optional_permissions as string[])].sort()).toEqual([...OPTIONAL_PERMISSIONS].sort());
    expect(m.host_permissions).toEqual(['<all_urls>']);
    for (const key of FORBIDDEN_KEYS) expect(m, key).not.toHaveProperty(key);
  });
});

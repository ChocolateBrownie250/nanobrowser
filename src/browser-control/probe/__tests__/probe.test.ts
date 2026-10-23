import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROBE_SOURCE } from '../index';

describe('probe string', () => {
  it('is self-contained: it runs with nothing from the module in scope', () => {
    const scope = {} as Record<string, unknown>;
    // Evaluate with a fresh global object, as the isolated world would; no DOM APIs are needed to install.
    new Function('globalThis', PROBE_SOURCE)(scope);
    const probe = scope.__nbProbe as { version: number; mutations(): number };
    expect(probe.version).toBe(1);
    expect(probe.mutations()).toBe(0);
  });

  it('installs once and cannot be replaced by later scripts in the same world', () => {
    const scope = {} as Record<string, unknown>;
    new Function('globalThis', PROBE_SOURCE)(scope);
    const first = scope.__nbProbe;
    new Function('globalThis', PROBE_SOURCE)(scope);
    expect(scope.__nbProbe).toBe(first);
    expect(() => {
      'use strict';
      (scope as { __nbProbe: unknown }).__nbProbe = 1;
    }).toThrow();
  });
});

describe('approximateName, the classifier’s fallback name', () => {
  const scope = {} as Record<string, unknown>;
  new Function('globalThis', PROBE_SOURCE)(scope);
  const probe = scope.__nbProbe as { approximateName(el: unknown): string };
  // The probe reads members through the prototypes of Element and HTMLElement (a form's named controls cannot shadow
  // them), so the fake element is an instance of fake classes that carry the same accessors.
  class FakeElement {
    constructor(
      readonly fake: { tagName: string; attrs: Record<string, string>; innerText: string },
      props: Record<string, unknown>,
    ) {
      Object.assign(this, props);
    }
    get tagName() {
      return this.fake.tagName;
    }
    getAttribute(name: string) {
      return this.fake.attrs[name] ?? null;
    }
  }
  class FakeHTMLElement extends FakeElement {
    get innerText() {
      return this.fake.innerText;
    }
  }
  beforeAll(() => {
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('HTMLElement', FakeHTMLElement);
  });
  afterAll(() => vi.unstubAllGlobals());
  /** An element as approximateName reads it: tag, type, value, rendered text and attributes; no labels. */
  const element = (tagName: string, props: Record<string, unknown>, attrs: Record<string, string> = {}) => {
    const { innerText = '', ...rest } = props as { innerText?: string };
    return new FakeHTMLElement({ tagName, attrs, innerText }, { labels: [], ...rest });
  };

  it('never names a control that holds a value by what it holds', () => {
    expect(probe.approximateName(element('INPUT', { type: 'password', value: 'hunter2' }))).toBe('');
    expect(probe.approximateName(element('INPUT', { type: 'text', value: '4111111111111111' }))).toBe('');
    expect(probe.approximateName(element('SELECT', { innerText: '4111 1111 1111 1111', value: 'c1' }))).toBe('');
    expect(probe.approximateName(element('TEXTAREA', { innerText: '654321', value: '654321' }))).toBe('');
    expect(
      probe.approximateName(element('INPUT', { type: 'password', value: 'hunter2' }, { 'aria-label': 'Password' })),
    ).toBe('Password');
  });

  it('still names buttons by their text or caption', () => {
    expect(probe.approximateName(element('INPUT', { type: 'submit', value: 'Pay now' }))).toBe('Pay now');
    expect(probe.approximateName(element('BUTTON', { innerText: 'Delete', value: '' }))).toBe('Delete');
  });
});

// While an answer streams, only that answer is rendered again: the Markdown of the settled ones is not parsed on
// every update.
import '@src/ui/__tests__/dom-env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { act } from 'react';
import type { DisplayEntry } from '@src/ui/protocol';

// Every pass of the Markdown pipeline passes through here, so this counts how often a text is parsed.
const parsed = vi.hoisted(() => [] as string[]);
vi.mock('react-markdown', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ children }: { children: string }) => {
      parsed.push(children);
      return createElement('p', null, children);
    },
  };
});

import { Transcript } from '../Transcript';
import type { MessageActions } from '../Transcript';

const COUNT = 50;
const entries: DisplayEntry[] = [];
for (let i = 0; i < COUNT; i++) {
  const at = new Date(Date.UTC(2026, 9, 8, 10, 0, i * 2)).toISOString();
  entries.push({ kind: 'user', id: `u${i}`, text: `Question ${i}`, at });
  entries.push({ kind: 'assistant', id: `a${i}`, text: `Answer ${i}`, at, tools: [] });
}
// The last reply is the one being written: its stored text is still empty.
entries.push({ kind: 'user', id: 'uN', text: 'Last question', at: '2026-10-08T11:00:00.000Z' });
entries.push({ kind: 'assistant', id: 'aN', text: '', at: '2026-10-08T11:00:01.000Z', tools: [] });

describe('the transcript while an answer streams', () => {
  let host: HTMLElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    parsed.length = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('parses each settled answer once, and the streaming one on every update', () => {
    // The panel passes a new actions object on every render; it must not make every block render again.
    const actions = (): MessageActions => ({
      idle: false,
      edit: () => undefined,
      restart: () => undefined,
      retry: () => undefined,
    });
    const draw = (text: string) =>
      act(() =>
        root.render(
          <Transcript
            entries={entries}
            streaming={{ id: 'aN', text }}
            live={{ startedAt: '2026-10-08T11:00:00.000Z', waiting: false }}
            actions={actions()}
          />,
        ),
      );

    draw('Streaming');
    const first = parsed.length;
    expect(first).toBe(COUNT + 1);
    for (let i = 1; i <= 10; i++) draw(`Streaming ${'word '.repeat(i)}`);

    const after = parsed.slice(first);
    // Ten updates, ten parses: the streaming reply only.
    expect(after).toHaveLength(10);
    expect(after.every(text => text.startsWith('Streaming'))).toBe(true);
    for (let i = 0; i < COUNT; i++) expect(parsed.filter(text => text === `Answer ${i}`)).toHaveLength(1);
  });

  it('a settled answer is rendered again when the entries change', () => {
    const draw = (list: DisplayEntry[]) => act(() => root.render(<Transcript entries={list} streaming={null} />));
    draw(entries.slice(0, 4));
    expect(parsed).toEqual(['Answer 0', 'Answer 1']);
    // A new entry list with the same replies: the grouping is redone, but the Markdown text is the same, so no parse.
    draw(entries.slice(0, 6));
    expect(parsed.filter(text => text === 'Answer 0')).toHaveLength(1);
    expect(parsed.filter(text => text === 'Answer 2')).toHaveLength(1);
  });
});

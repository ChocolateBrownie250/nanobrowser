// A small DOM for component tests that click and re-render (the Vitest environment here is plain Node). The project has
// no DOM test library of its own; linkedom comes with WXT, so it is loaded from there. Import this file first in a test,
// before React DOM, because React DOM looks for `window` when it loads.
import { createRequire } from 'node:module';

type LinkedomModule = { parseHTML(html: string): Record<string, unknown> & { document: Document; window: Window } };

const fromWxt = createRequire(createRequire(import.meta.url).resolve('wxt'));
const { parseHTML } = fromWxt('linkedom') as LinkedomModule;

const dom = parseHTML('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
const g = globalThis as Record<string, unknown>;
for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event']) {
  g[key] = key === 'window' ? dom.window : (dom as Record<string, unknown>)[key];
}
// React reads these from the global scope.
g.IS_REACT_ACT_ENVIRONMENT = true;
if (!g.requestAnimationFrame) g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

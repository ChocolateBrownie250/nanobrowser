// Answers as sanitised Markdown. The renderer builds React elements and never sets markup: raw HTML is dropped, only
// http, https and mailto links survive and each shows its host, no bare address becomes a link, a remote image loads
// only when clicked, and a link opens in an ordinary tab outside the agent's group.
import { Children, cloneElement, isValidElement, memo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { t, useLanguage } from '@src/ui/i18n';

const SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** The address a link or image may use, or '' when its scheme is not allowed. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return SCHEMES.has(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

/** The host a link shows (a non-ASCII host in its punycode form, as URL gives it). */
export function linkHost(href: string): string {
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'mailto:' ? parsed.pathname : parsed.host;
  } catch {
    return '';
  }
}

function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map(child => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) return textOf(child.props.children);
      return '';
    })
    .join('');
}

/** Whether a link's text is its own address: a bare address, which stays text. */
export function isBareAddress(text: string, href: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/^mailto:/i, '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/$/, '');
  return norm(text).toLowerCase() === norm(href).toLowerCase();
}

/**
 * Whether the link's text already names its real host: the text is that host, or an address on it. Text that merely
 * contains the host ("paypal.com" for pal.com) does not count, so the host is shown.
 */
export function textNamesHost(text: string, host: string): boolean {
  const value = text.trim().toLowerCase();
  if (!value || !host) return false;
  if (value === host.toLowerCase()) return true;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/.test(value) ? value : `https://${value}`).host === host.toLowerCase();
  } catch {
    return false;
  }
}

function openOutside(href: string): void {
  if (globalThis.chrome?.tabs) void chrome.tabs.create({ url: href, active: true });
  else window.open(href, '_blank', 'noopener,noreferrer');
}

function RemoteImage({ src, alt }: { src: string; alt: string }) {
  const [shown, setShown] = useState(false);
  if (shown) return <img src={src} alt={alt} className="max-w-full rounded" referrerPolicy="no-referrer" />;
  return (
    <button
      type="button"
      className="rounded border border-dashed border-nb-border px-2 py-1 font-sans text-xs text-nb-muted hover:bg-nb-surface"
      onClick={e => {
        // The reveal button is not part of a link the image may sit in: it never opens that link.
        e.preventDefault();
        e.stopPropagation();
        setShown(true);
      }}>
      {t('markdown.showImage', { host: linkHost(src) })}
      {alt ? ` · ${alt}` : ''}
    </button>
  );
}

/** `text` may be a function, called when Copy is clicked, so a long text is not built on every render. */
function CopyButton({ text, label }: { text: string | (() => string); label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded px-1.5 py-0.5 font-sans text-xs text-nb-muted hover:bg-nb-surface"
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}>
      {copied ? t('markdown.copied') : label}
    </button>
  );
}

/** Rows of a rendered table, from its cells' text, for Copy and Save as CSV. */
function tableRows(node: HTMLTableElement | null): string[][] {
  if (!node) return [];
  return [...node.rows].map(row => [...row.cells].map(cell => cell.innerText.trim()));
}

/**
 * A cell as CSV. One that starts with = + - @ or a tab or carriage return would be a formula when a spreadsheet opens
 * the file, so it gets a leading apostrophe (the spreadsheet then shows it as text). A plain signed number (-3.2%,
 * +1,5) holds nothing to evaluate and keeps its value.
 */
function csvCell(cell: string): string {
  const text = /^[=+\-@\t\r]/.test(cell) && !/^[+-]\d[\d.,]*%?$/.test(cell) ? `'${cell}` : cell;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: string[][]): string {
  return rows.map(r => r.map(csvCell).join(',')).join('\n');
}

function Table({ children }: { children?: ReactNode }) {
  // Read when Copy or Save is clicked: the cells' text needs a layout, which a render should not force.
  const table = useRef<HTMLTableElement>(null);
  const save = () => {
    const blob = new Blob([toCsv(tableRows(table.current))], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'table.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="my-2">
      <div className="nb-table-frame">
        <table ref={table} className="nb-table">
          {children}
        </table>
      </div>
      <div className="mt-1 flex gap-1 font-sans">
        <CopyButton
          text={() =>
            tableRows(table.current)
              .map(r => r.join('\t'))
              .join('\n')
          }
          label={t('markdown.copy')}
        />
        <button
          type="button"
          className="rounded px-1.5 py-0.5 font-sans text-xs text-nb-muted hover:bg-nb-surface"
          onClick={save}>
          {t('markdown.saveCsv')}
        </button>
      </div>
    </div>
  );
}

/** The renderer for `![alt](src)`: an address that is not allowed leaves the alt text. */
function MdImage({ src, alt }: { src?: string; alt?: string }) {
  const safe = typeof src === 'string' ? safeUrl(src) : '';
  if (!safe) return <span>{alt ?? ''}</span>;
  return <RemoteImage src={safe} alt={alt ?? ''} />;
}

/**
 * Takes the images that can be revealed out of a link's content. A button inside an anchor is invalid HTML and a
 * click on it would reach the link, so the images are drawn beside the link, which keeps its other content.
 */
function pullImages(children: ReactNode): { rest: ReactNode[]; images: ReactNode[] } {
  const rest: ReactNode[] = [];
  const images: ReactNode[] = [];
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ src?: string; children?: ReactNode }>(child)) {
      rest.push(child);
    } else if (child.type === MdImage && typeof child.props.src === 'string' && safeUrl(child.props.src)) {
      images.push(child);
    } else if (typeof child.type === 'string' && child.props.children !== undefined) {
      // Emphasis or code around an image: look inside, and keep the element with what is left.
      const inner = pullImages(child.props.children);
      images.push(...inner.images);
      rest.push(inner.images.length ? cloneElement(child as ReactElement, { children: inner.rest }) : child);
    } else {
      rest.push(child);
    }
  }
  return { rest, images };
}

const components: Components = {
  a({ href, children }) {
    const safe = href ? safeUrl(href) : '';
    const text = textOf(children);
    if (!safe || isBareAddress(text, safe)) return <span>{children}</span>;
    const host = linkHost(safe);
    const { rest, images } = pullImages(children);
    // A link that was only an image still has something to click: its address.
    const imageOnly = images.length > 0 && !textOf(rest);
    const link = (
      <a
        href={safe}
        rel="noopener noreferrer"
        className="text-nb-link underline decoration-nb-link/40 underline-offset-2 hover:decoration-nb-link"
        onClick={e => {
          e.preventDefault();
          openOutside(safe);
        }}>
        {imageOnly ? host : rest}
        {!imageOnly && host && !textNamesHost(text, host) ? <span className="text-nb-muted"> ({host})</span> : null}
      </a>
    );
    if (!images.length) return link;
    return (
      <span>
        {images}
        {link}
      </span>
    );
  },
  img: MdImage,
  pre({ children }) {
    const code = textOf(children);
    return (
      <div className="group relative my-2">
        <pre className="overflow-x-auto rounded-lg border border-nb-border bg-nb-surface/60 p-3 text-xs">
          {children}
        </pre>
        <div className="absolute right-1 top-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <CopyButton text={code} label={t('markdown.copy')} />
        </div>
      </div>
    );
  },
  table: Table,
};

const schema = {
  ...defaultSchema,
  // Ids and names would let answers clobber the panel's own; the default prefixes them, and nothing needs them.
  clobberPrefix: 'md-',
  protocols: { href: ['http', 'https', 'mailto'], src: ['http', 'https'] },
};

// The plugin lists and the address filter are module constants: new ones on every render would make the renderer
// re-parse the whole text every time.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [[rehypeSanitize, schema]];
const urlTransform = (url: string) => safeUrl(url);

/**
 * Memoised on its text: a settled answer is not parsed again while a later one streams. It still follows the language
 * (the labels of its tables and images), which is not a prop.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  useLanguage();
  return (
    <div className="nb-markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={urlTransform}
        components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

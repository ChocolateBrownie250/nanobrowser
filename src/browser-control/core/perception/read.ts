// Content for `read`: the page or one element as Markdown or plain text, from the same capture as the outline, so
// frames and closed shadow roots are included and masked values stay masked.
import type { ONode } from './outline';
import { MASK } from './masking';
import { sliceWhole } from '../text';

const BLOCK_CONTAINERS = new Set([
  'list',
  'table',
  'grid',
  'treegrid',
  'navigation',
  'main',
  'form',
  'region',
  'article',
  'banner',
  'contentinfo',
  'complementary',
  'dialog',
  'alertdialog',
  'group',
  'tablist',
  'tabpanel',
  'menu',
  'menubar',
  'toolbar',
  'tree',
  'listbox',
  'iframe',
  'blockquote',
  'figure',
  'search',
]);
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

export function renderContent(roots: ONode[], format: 'markdown' | 'text'): string {
  const md = format === 'markdown';
  const lines: string[] = [];
  const push = (line: string) => {
    if (line.trim()) lines.push(line);
  };
  const walk = (n: ONode, listDepth: number) => {
    if (n.kind === 'text') return push(n.name);
    const value = n.masked ? MASK : n.value;
    switch (n.role) {
      case 'heading': {
        const level = Number(/level (\d)/.exec(n.states.join(' '))?.[1] ?? 2);
        return push(md ? `${'#'.repeat(Math.min(6, level))} ${n.name}` : n.name);
      }
      case 'link':
        return push(md && n.url ? `[${n.name || n.url}](${n.url})` : n.name);
      case 'listitem': {
        const indent = '  '.repeat(Math.max(0, listDepth - 1));
        const own = n.name && !n.children.length ? n.name : '';
        const before = lines.length;
        if (own) push(`${indent}- ${own}`);
        else {
          n.children.forEach(c => walk(c, listDepth));
          if (lines.length > before) lines[before] = `${indent}- ${lines[before]}`;
        }
        return;
      }
      case 'row':
        if (n.name) push(md ? `| ${n.name} |` : n.name);
        return;
      case 'image':
      case 'img':
        return push(md ? `![${n.name}]` : n.name ? `[image: ${n.name}]` : '');
      default:
        break;
    }
    if (FIELD_ROLES.has(n.role)) return push(`${n.name || n.role}: ${value ?? ''}`);
    if (TOGGLE_ROLES.has(n.role)) return push(`${n.states.includes('checked') ? '[x]' : '[ ]'} ${n.name}`);
    if (
      n.role === 'button' ||
      n.role === 'summary' ||
      n.role === 'tab' ||
      n.role === 'option' ||
      n.role === 'menuitem'
    ) {
      return push(n.children.length ? '' : n.name);
    }
    if (BLOCK_CONTAINERS.has(n.role) && n.children.length) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      n.children.forEach(c => walk(c, n.role === 'list' ? listDepth + 1 : listDepth));
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      return;
    }
    if (!n.children.length) return push(n.name);
    n.children.forEach(c => walk(c, listDepth));
  };
  roots.forEach(r => walk(r, 0));
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Slices content for maxChars and offset, and says what is left. Never cuts a character in half: an offset that lands
 * between the two halves of a surrogate pair (an emoji, a rare CJK character) starts after the pair's first half, and
 * a page that would end between them ends before the pair (or, if the pair is all that fits, holds the pair whole, so
 * paging always moves on). `start` is where the text really begins and `next` where the following page does.
 */
export function sliceContent(
  content: string,
  offset: number,
  maxChars: number,
): { text: string; remaining: number; start: number; next: number } {
  let start = Math.min(Math.max(offset, 0), content.length);
  if (isLowSurrogate(content.charCodeAt(start)) && isHighSurrogate(content.charCodeAt(start - 1))) start += 1;
  // One character of look-ahead tells sliceWhole whether the cut falls between the halves of a pair.
  let end = sliceWhole(content.slice(start, start + maxChars + 1), maxChars).length + start;
  if (end === start && maxChars > 0 && start < content.length) end = Math.min(content.length, start + 2);
  const text = content.slice(start, end);
  return { text, remaining: Math.max(0, content.length - end), start, next: end };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

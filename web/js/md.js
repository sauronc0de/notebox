// Minimal, safe note formatting: builds DOM nodes, never innerHTML.
// Supports: "- [ ] task", "- item", "1. item", "# heading", "> quote", "---", **bold**, `code`, links.
import { el } from './util.js';

const TASK = /^\s*[-*+]\s\[( |x|X)\]\s?(.*)$/;
const BULLET = /^\s*[-*+]\s(.*)$/;
const NUM = /^\s*(\d+)[.)]\s(.*)$/;
const HEAD = /^#{1,3}\s(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const HR = /^\s*(-{3,}|\*{3,})\s*$/;
const INLINE = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'])|\*\*([^*]+)\*\*|`([^`]+)`/g;

function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(el('a', { href: m[1], target: '_blank', rel: 'noopener noreferrer', text: m[1].replace(/^https?:\/\/(www\.)?/, ''), on: { click: e => e.stopPropagation() } }));
    else if (m[2]) out.push(el('strong', { text: m[2] }));
    else out.push(el('code', { text: m[3] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Render note text. onToggle(lineIndex, checked) makes checkboxes interactive.
 * maxBlocks truncates long notes for card previews.
 */
export function render(text, { onToggle, maxBlocks = Infinity } = {}) {
  const root = el('div', { class: 'md' });
  let list = null, listKind = null, blocks = 0, blank = false;
  const push = node => { root.append(node); blocks++; };
  const lines = (text || '').split('\n');
  for (let i = 0; i < lines.length && blocks < maxBlocks; i++) {
    const line = lines[i];
    let m, kind = null, item = null;
    if ((m = line.match(TASK))) {
      kind = 'ul';
      const done = m[1] !== ' ';
      const box = el('input', { type: 'checkbox', class: 'box', checked: done, 'aria-label': m[2] || 'Casella', disabled: !onToggle });
      box.addEventListener('click', e => e.stopPropagation());
      if (onToggle) box.addEventListener('change', () => onToggle(i, box.checked));
      item = el('li', { class: 'task' + (done ? ' done' : '') }, box, el('span', {}, inline(m[2])));
    } else if ((m = line.match(HR))) {
      list = null; push(el('hr')); continue;
    } else if ((m = line.match(BULLET))) {
      kind = 'ul'; item = el('li', { class: 'bullet' }, inline(m[1]));
    } else if ((m = line.match(NUM))) {
      kind = 'ol'; item = el('li', { class: 'num', dataset: { n: m[1] + '.' } }, inline(m[2]));
    }
    if (item) {
      if (!list || listKind !== kind) { list = el('ul'); listKind = kind; push(list); }
      list.append(item);
      blank = false;
      continue;
    }
    list = null;
    if (!line.trim()) { if (!blank && root.childNodes.length) { root.append(el('div', { class: 'gap' })); blank = true; } continue; }
    blank = false;
    if ((m = line.match(HEAD))) push(el('h4', {}, inline(m[1])));
    else if ((m = line.match(QUOTE))) push(el('blockquote', {}, inline(m[1])));
    else push(el('p', {}, inline(line)));
  }
  while (root.lastChild?.classList?.contains('gap')) root.lastChild.remove();
  return root;
}

export function setTask(text, lineIndex, checked) {
  const lines = text.split('\n');
  lines[lineIndex] = lines[lineIndex].replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]');
  return lines.join('\n');
}

export function taskStats(text) {
  let total = 0, done = 0;
  for (const line of (text || '').split('\n')) {
    const m = line.match(TASK);
    if (m) { total++; if (m[1] !== ' ') done++; }
  }
  return { total, done };
}

/** Prefix to continue a list on Enter, or null. Returns {prefix, empty}. */
export function listContinuation(line) {
  let m;
  if ((m = line.match(/^(\s*)([-*+])\s\[( |x|X)\]\s?(.*)$/))) return { prefix: `${m[1]}${m[2]} [ ] `, empty: !m[4].trim() };
  if ((m = line.match(/^(\s*)([-*+])\s(.*)$/))) return { prefix: `${m[1]}${m[2]} `, empty: !m[3].trim() };
  if ((m = line.match(/^(\s*)(\d+)([.)])\s(.*)$/))) return { prefix: `${m[1]}${Number(m[2]) + 1}${m[3]} `, empty: !m[4].trim() };
  return null;
}

// Note rendering: full GitHub-flavoured Markdown (marked), sanitized with DOMPurify,
// plus interactive task checkboxes, links between notes and lazy-loaded Mermaid diagrams.
import { Marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.es.mjs';
import { el } from './util.js';

// Random per page load, so raw HTML written in a note can't forge task checkboxes.
const TASK_ATTR = 'data-t' + Math.random().toString(36).slice(2, 10);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** [[Títol]], [[Títol#Secció]], [[#Secció]], [[Títol|text visible]] */
const wikiLink = {
  name: 'wikilink',
  level: 'inline',
  start: src => src.indexOf('[['),
  tokenizer(src) {
    const m = /^\[\[([^[\]\n|]+?)(?:\|([^[\]\n]+?))?\]\]/.exec(src);
    if (!m) return undefined;
    const hash = m[1].indexOf('#');
    const target = (hash < 0 ? m[1] : m[1].slice(0, hash)).trim();
    const anchor = hash < 0 ? '' : m[1].slice(hash + 1).trim();
    return { type: 'wikilink', raw: m[0], target, anchor, text: (m[2] || m[1]).trim() };
  },
  renderer: t => `<a href="#" data-note="${esc(t.target)}" data-anchor="${esc(t.anchor)}">${esc(t.text)}</a>`,
};

const marked = new Marked({
  gfm: true,
  breaks: true,
  extensions: [wikiLink],
  renderer: {
    checkbox: ({ checked }) => `<span ${TASK_ATTR}="${checked ? 1 : 0}"></span>`,
    code: ({ text, lang }) => (lang || '').trim().toLowerCase() === 'mermaid' ? `<pre class="mermaid-src">${esc(text)}</pre>` : false,
  },
});

const PURIFY = {
  RETURN_DOM_FRAGMENT: true,
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'dialog'],
  FORBID_ATTR: ['style', 'id', 'name'],
};

/* ───────── Parsing, with the source position of every task's "[ ]" ───────── */
const cache = new Map();
function parse(text) {
  const src = (text || '').replace(/\r\n?/g, '\n');
  let hit = cache.get(src);
  if (hit) return hit;
  const tokens = marked.lexer(src);
  // tasks[i] = offset of the "[" of the i-th checkbox, in render order (-1 if it can't be located).
  const tasks = [];
  let offset = 0;
  for (const top of tokens) {
    const end = offset + top.raw.length;
    let cursor = offset;
    marked.walkTokens([top], t => {
      if (t.type !== 'list_item' || !t.task) return;
      const first = t.raw.split('\n')[0];
      const at = src.indexOf(first, cursor);
      const bracket = first.search(/\[[ xX]\]/);
      if (at < 0 || at >= end || bracket < 0) { tasks.push({ pos: -1, checked: t.checked }); return; }
      tasks.push({ pos: at + bracket, checked: t.checked });
      cursor = at + bracket + 3;
    });
    offset = end;
  }
  hit = { tokens, tasks };
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(src, hit);
  return hit;
}

/** GitHub-style heading slug; also normalizes "Secció" and "secció" to the same anchor. */
export const slug = s => String(s).toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');

export function findHeading(root, anchor) {
  if (!root || !anchor) return null;
  const want = slug(anchor);
  return [...root.querySelectorAll('[data-slug]')].find(h => h.dataset.slug === want) || null;
}

/**
 * Render note text.
 * onToggle(pos, checked): makes checkboxes interactive (pos is opaque, pass it to setTask).
 * onLink({ note, anchor, root }): a link to a note title ('' = this note) and/or a heading.
 * maxBlocks truncates long notes for card previews; diagrams:false shows a placeholder instead of Mermaid;
 * localAnchors:false sends "#secció" links to onLink instead of scrolling inside the rendered block.
 */
export function render(text, { onToggle, onLink, maxBlocks = Infinity, diagrams = true, localAnchors = true } = {}) {
  const { tokens, tasks } = parse(text);
  let blocks = tokens;
  if (Number.isFinite(maxBlocks)) {
    blocks = [];
    let n = 0;
    for (const t of tokens) { if (t.type !== 'space' && n++ >= maxBlocks) break; blocks.push(t); }
    blocks.links = tokens.links;
  }
  const root = el('div', { class: 'md' });
  root.append(DOMPurify.sanitize(marked.parser(blocks), PURIFY));

  root.querySelectorAll(`span[${TASK_ATTR}]`).forEach((mark, i) => {
    const task = tasks[i] || { pos: -1 };
    const done = mark.getAttribute(TASK_ATTR) === '1';
    const li = mark.closest('li');
    const box = el('input', { type: 'checkbox', class: 'box', checked: done, disabled: !onToggle || task.pos < 0 });
    if (onToggle && task.pos >= 0) box.addEventListener('change', () => onToggle(task.pos, box.checked));
    // Wrap the item's own text so "done" styling doesn't cascade into nested lists.
    const label = el('span', { class: 'task-text' });
    const isBlock = n => n.nodeType === 1 && /^(UL|OL|P|DIV|PRE|BLOCKQUOTE|TABLE|H[1-6])$/.test(n.tagName);
    for (let n = mark.nextSibling; n && !isBlock(n); n = mark.nextSibling) label.append(n);
    mark.replaceWith(el('span', { class: 'task-row' }, box, label));
    box.setAttribute('aria-label', label.textContent.trim() || 'Casella');
    li?.classList.add('task');
    if (done) li?.classList.add('done');
  });

  root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => { h.dataset.slug = slug(h.textContent); });

  for (const a of root.querySelectorAll('a')) {
    if (a.hasAttribute('data-note')) continue; // wiki link
    const href = a.getAttribute('href') || '';
    if (!href) continue;
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href) || href.startsWith('/')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      continue;
    }
    // Relative link: "#secció", "Títol%20nota", "<Títol nota>", "Títol.md#secció".
    let decoded = href;
    try { decoded = decodeURIComponent(href); } catch { /* keep raw */ }
    const hash = decoded.indexOf('#');
    a.dataset.note = (hash < 0 ? decoded : decoded.slice(0, hash)).replace(/\.md$/i, '').trim();
    a.dataset.anchor = hash < 0 ? '' : decoded.slice(hash + 1).trim();
    a.setAttribute('href', '#');
  }
  root.querySelectorAll('img').forEach(img => { img.loading = 'lazy'; img.decoding = 'async'; });

  root.addEventListener('click', e => {
    const target = e.target.closest('a, input, summary');
    if (!target || !root.contains(target)) return;
    e.stopPropagation(); // don't open the card underneath
    if (target.tagName === 'A' && target.hasAttribute('data-note')) {
      e.preventDefault();
      const link = { note: target.dataset.note, anchor: target.dataset.anchor, root };
      if (!link.note && localAnchors && scrollToHeading(root, link.anchor)) return;
      onLink?.(link);
    }
  });

  const sources = root.querySelectorAll('pre.mermaid-src');
  if (sources.length) {
    if (diagrams) renderDiagrams(sources);
    else sources.forEach(pre => pre.replaceWith(el('div', { class: 'diagram-ph', text: '◇ Diagrama' })));
  }
  return root;
}

export function scrollToHeading(root, anchor) {
  const h = findHeading(root, anchor);
  if (!h) return false;
  h.scrollIntoView({ block: 'start', behavior: 'smooth' });
  h.classList.remove('flash');
  void h.offsetWidth;
  h.classList.add('flash');
  return true;
}

/* ───────── Mermaid (≈1–2 MB, only loaded when a note has a diagram) ───────── */
let mermaidLoad = null, diagramSeq = 0;
function loadMermaid() {
  mermaidLoad ??= import('../vendor/mermaid/mermaid.esm.min.mjs').then(({ default: mermaid }) => {
    const css = getComputedStyle(document.documentElement), v = name => css.getPropertyValue(name).trim();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: v('--font'),
      themeVariables: {
        darkMode: true,
        background: v('--surface'),
        primaryColor: v('--surface-3'),
        primaryTextColor: v('--text'),
        primaryBorderColor: v('--accent-2'),
        secondaryColor: v('--surface-2'),
        tertiaryColor: v('--bg-1'),
        lineColor: v('--muted'),
        textColor: v('--text-2'),
        noteBkgColor: v('--surface-2'),
        noteTextColor: v('--text-2'),
        noteBorderColor: v('--line-3'),
        fontFamily: v('--font'),
      },
    });
    return mermaid;
  }).catch(err => { mermaidLoad = null; throw err; });
  return mermaidLoad;
}

async function renderDiagrams(sources) {
  for (const pre of sources) {
    const code = pre.textContent;
    try {
      const mermaid = await loadMermaid();
      await mermaid.parse(code);
      const { svg } = await mermaid.render('nb-diagram-' + (++diagramSeq), code);
      const box = el('div', { class: 'diagram', role: 'img' });
      box.innerHTML = svg; // produced by mermaid with securityLevel 'strict'
      pre.replaceWith(box);
    } catch (err) {
      pre.classList.add('mermaid-error');
      pre.before(el('div', { class: 'diagram-error', text: 'Error al diagrama: ' + String(err?.message || err).split('\n')[0] }));
    }
  }
}

/* ───────── Text helpers ───────── */
export function setTask(text, pos, checked) {
  text = text.replace(/\r\n?/g, '\n');
  if (pos < 0 || !/^\[[ xX]\]$/.test(text.slice(pos, pos + 3))) return text;
  return text.slice(0, pos) + (checked ? '[x]' : '[ ]') + text.slice(pos + 3);
}

export function taskStats(text) {
  const { tasks } = parse(text);
  return { total: tasks.length, done: tasks.filter(t => t.checked).length };
}

/** Prefix to continue a list on Enter, or null. Returns {prefix, empty}. */
export function listContinuation(line) {
  let m;
  if ((m = line.match(/^(\s*)([-*+])\s\[( |x|X)\]\s?(.*)$/))) return { prefix: `${m[1]}${m[2]} [ ] `, empty: !m[4].trim() };
  if ((m = line.match(/^(\s*)([-*+])\s(.*)$/))) return { prefix: `${m[1]}${m[2]} `, empty: !m[3].trim() };
  if ((m = line.match(/^(\s*)(\d+)([.)])\s(.*)$/))) return { prefix: `${m[1]}${Number(m[2]) + 1}${m[3]} `, empty: !m[4].trim() };
  return null;
}

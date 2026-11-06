import { api, onNetwork } from './api.js';
import { render as renderMd, setTask, taskStats, listContinuation } from './md.js';
import { toast, confirmDialog, openModal, closeModal, setGuard, onModalClose, isOpen, wireDialog } from './ui.js';
import {
  $, el, icon, groupIcon, GROUP_ICONS, todayISO, addDays, startOfWeek, daysBetween, nextWeekday, parseISO,
  fmtShort, fmtLong, fmtMonth, dowShort, relDay, relTime, fullStamp, debounce,
} from './util.js';

const PAGE = 40;
const DEFAULT_FILTERS = { search: '', group: '', tag: '', hasDate: '', archived: 'false', sort: 'updated' };
const VIEWS = { notes: 'Notes', agenda: 'Agenda', explore: 'Explora' };

const state = {
  view: 'notes',
  today: todayISO(),
  summary: null,
  filters: { ...DEFAULT_FILTERS },
  notes: { pinned: [], items: [], total: 0, loaded: false },
  agenda: { day: todayISO(), data: null },
  tagEdit: false,
  hidden: new Set(),        // notes deleted locally, waiting for the undo window
  pendingDeletes: new Map(), // id → timer
};
try { state.filters.sort = localStorage.getItem('nb-sort') || 'updated'; } catch { /* storage unavailable */ }

const groups = () => state.summary?.groups || [];
const tags = () => state.summary?.tags || [];
const isFiltered = () => { const f = state.filters; return !!(f.search || f.group || f.tag || f.hasDate || f.archived !== 'false'); };

function reportError(err) {
  console.error(err);
  toast(err.message || 'Error inesperat', { type: 'error' });
}

/* ═════════════ Router ═════════════ */
function currentView() { const v = location.hash.slice(1); return VIEWS[v] ? v : 'notes'; }
function go(view) { if (location.hash !== '#' + view) location.hash = view; else showView(view); }

function showView(view) {
  state.view = view;
  for (const v of Object.keys(VIEWS)) $('view-' + v).hidden = v !== view;
  document.querySelectorAll('[data-view]').forEach(a => {
    const on = a.dataset.view === view;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('view-title').textContent = VIEWS[view];
  window.scrollTo({ top: 0 });
  loadView();
}

function loadView() {
  if (state.view === 'notes') return loadNotes();
  if (state.view === 'agenda') return loadAgenda();
  return renderExplore();
}

async function refreshAll() {
  await Promise.all([loadSummary(), state.view === 'explore' ? null : loadView()]);
}

/* ═════════════ Summary: badges, sidebar, chips ═════════════ */
async function loadSummary() {
  try {
    state.summary = await api(`/api/summary?today=${state.today}`);
    renderSummary();
  } catch (err) { if (!state.summary) reportError(err); }
}

function renderSummary() {
  const s = state.summary;
  if (!s) return;
  const pending = s.pending;
  document.querySelectorAll('[data-badge]').forEach(b => {
    b.hidden = !pending;
    b.textContent = pending > 99 ? '99+' : pending;
    b.classList.toggle('red', s.overdue > 0);
  });
  const bell = $('bell');
  bell.classList.toggle('alerting', pending > 0 && !s.overdue);
  bell.classList.toggle('overdue', s.overdue > 0);
  bell.setAttribute('aria-label', pending ? `${pending} recordatoris pendents` : 'Cap recordatori pendent');
  document.title = pending ? `(${pending}) Notebox` : 'Notebox';
  try { pending ? navigator.setAppBadge?.(pending) : navigator.clearAppBadge?.(); } catch { /* unsupported */ }
  document.querySelectorAll('[data-count=total]').forEach(c => { c.textContent = s.total || ''; });

  // Reminder strip on the notes view.
  const strip = $('reminder-alert');
  strip.hidden = !pending;
  strip.classList.toggle('overdue', s.overdue > 0);
  if (pending) {
    $('alert-title').textContent = pending === 1 ? '1 recordatori pendent' : `${pending} recordatoris pendents`;
    const parts = [];
    if (s.today) parts.push(`${s.today} per avui`);
    if (s.overdue) parts.push(`${s.overdue} ${s.overdue === 1 ? 'endarrerit' : 'endarrerits'}`);
    $('alert-sub').textContent = parts.join(' · ');
  }

  renderGroupChips();
  renderSidebar();
  renderActiveFilters();
  if (state.view === 'explore') renderExplore();
  if (isOpen($('filters'))) renderFilterSheet();
}

function renderSidebar() {
  const f = state.filters;
  $('side-groups').replaceChildren(
    ...groups().map(g => el('button', {
      type: 'button', class: 'side-group' + (state.view === 'notes' && String(f.group) === String(g.id) ? ' on' : ''),
      on: { click: () => applyFilter({ group: String(g.id) }) },
    }, groupIcon(g.icon), el('span', { text: g.name }), el('small', { text: g.count }))),
    el('button', { type: 'button', class: 'side-group', on: { click: () => openGroupDialog() } }, icon('i-plus'), el('span', { text: 'Nou grup' })));
  const top = [...tags()].filter(t => t.count).sort((a, b) => b.count - a.count).slice(0, 14);
  $('side-tags').replaceChildren(...top.map(t => el('button', {
    type: 'button', class: 'chip sm' + (f.tag.toLowerCase() === t.name.toLowerCase() ? ' on' : ''), text: '#' + t.name,
    on: { click: () => applyFilter({ tag: t.name }) },
  })));
  if (!top.length) $('side-tags').append(el('span', { class: 'hint', text: 'Encara no hi ha etiquetes.' }));
}

/* ═════════════ Notes view ═════════════ */
let notesToken = 0;

function notesQuery(extra = {}) {
  const f = state.filters, q = new URLSearchParams();
  if (f.search.trim()) q.set('search', f.search.trim());
  if (f.group) q.set('group', f.group);
  if (f.tag) q.set('tag', f.tag);
  if (f.hasDate) q.set('has_date', f.hasDate);
  q.set('archived', f.archived);
  q.set('sort', f.sort);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return '/api/notes?' + q;
}

async function loadNotes({ append = false } = {}) {
  const token = ++notesToken;
  const n = state.notes;
  if (!n.loaded) renderNotesSkeleton();
  try {
    if (isFiltered()) {
      const res = await api(notesQuery({ limit: PAGE, offset: append ? n.items.length : 0 }));
      if (token !== notesToken) return;
      n.pinned = [];
      n.items = append ? n.items.concat(res.items) : res.items;
      n.total = res.total;
    } else {
      const [pinned, rest] = await Promise.all([
        append ? null : api(notesQuery({ pinned: 'true', limit: 200 })),
        api(notesQuery({ pinned: 'false', limit: PAGE, offset: append ? n.items.length : 0 })),
      ]);
      if (token !== notesToken) return;
      if (pinned) n.pinned = pinned.items;
      n.items = append ? n.items.concat(rest.items) : rest.items;
      n.total = rest.total;
    }
    n.loaded = true;
    renderNotes();
  } catch (err) {
    if (token !== notesToken) return;
    if (!n.loaded) $('notes-body').replaceChildren(emptyState('i-alert', 'No s’han pogut carregar les notes', err.message,
      el('button', { type: 'button', class: 'btn ghost sm', text: 'Torna-ho a provar', on: { click: () => loadNotes() } })));
    else reportError(err);
  }
}

function renderNotesSkeleton() {
  $('notes-body').replaceChildren(el('div', { class: 'grid' }, Array.from({ length: 4 }, () => el('div', { class: 'skeleton' }))));
}

function emptyState(iconName, title, text, ...extra) {
  return el('div', { class: 'empty' }, icon(iconName), el('strong', { text: title }), text ? el('p', { text }) : null, ...extra);
}

function section(label, count, nodes, { tone = '' } = {}) {
  return el('section', { class: 'sec' },
    el('header', { class: 'sec-head ' + tone }, el('h2', { class: 'label' }, label, count !== undefined ? el('b', { text: String(count).padStart(2, '0') }) : null)),
    nodes);
}

function renderNotes() {
  const n = state.notes, body = $('notes-body');
  const visible = list => list.filter(note => !state.hidden.has(note.id));
  const pinned = visible(n.pinned), items = visible(n.items);
  const hiddenCount = n.items.length - items.length;
  const out = [];
  const moreBtn = () => n.items.length < n.total
    ? el('div', { class: 'more' }, el('button', { type: 'button', class: 'btn ghost', on: { click: e => { e.currentTarget.disabled = true; loadNotes({ append: true }); } } },
      `Carrega'n més`, el('span', { class: 'mono', text: ` ${n.items.length}/${n.total}` })))
    : null;

  if (isFiltered()) {
    const total = n.total - hiddenCount;
    out.push(el('p', { class: 'result-count', text: total === 1 ? '1 RESULTAT' : `${total} RESULTATS` }));
    if (items.length) out.push(el('div', { class: 'grid' }, items.map(card)), moreBtn());
    else out.push(emptyState('i-search', 'Cap nota coincideix', 'Prova amb altres paraules o treu algun filtre.',
      el('button', { type: 'button', class: 'btn ghost sm', text: 'Neteja els filtres', on: { click: () => resetFilters() } })));
  } else {
    if (!pinned.length && !items.length) {
      out.push(emptyState('i-notes', 'Encara no tens cap nota', 'Guarda idees, llistes, recordatoris… Tot el que vulguis recordar.',
        el('button', { type: 'button', class: 'btn primary', on: { click: () => openEditor() } }, icon('i-plus'), 'Crea la primera nota')));
    } else {
      if (pinned.length) out.push(section('Fixades', pinned.length, el('div', { class: 'grid' }, pinned.map(card))));
      if (items.length) out.push(section(sortLabel(), n.total - hiddenCount, [el('div', { class: 'grid' }, items.map(card)), moreBtn()]));
    }
  }
  body.replaceChildren(...out.filter(Boolean));
}

const sortLabel = () => ({ updated: 'Editades recentment', created: 'Creades recentment', title: 'Per títol', date: 'Per data' })[state.filters.sort];

function reminderPill(note, { withDate = false } = {}) {
  if (!note.date) return null;
  const diff = daysBetween(state.today, note.date);
  const when = relDay(note.date, state.today);
  if (note.done) return el('span', { class: 'pill green' }, icon('i-check'), withDate ? fmtShort(note.date) : 'Fet');
  if (diff < 0) return el('span', { class: 'pill red' }, icon('i-clock'), `Endarrerit · ${when}`);
  if (diff === 0) return el('span', { class: 'pill amber' }, icon('i-clock'), 'Avui');
  return el('span', { class: 'pill cyan' }, icon('i-clock'), diff === 1 ? 'Demà' : fmtShort(note.date));
}

function card(note) {
  const stats = taskStats(note.description);
  const long = note.description.length > 260 || note.description.split('\n').length > 7;
  const node = el('article', {
    class: 'card' + (note.pinned ? ' pinned' : '') + (note.archived ? ' archived' : ''),
    tabindex: '0', role: 'button', 'aria-label': note.title,
    on: {
      click: () => openEditor(note),
      keydown: e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === node) { e.preventDefault(); openEditor(note); } },
    },
  });
  const flags = el('span', { class: 'card-flags' }, note.pinned ? icon('i-pin') : null, note.archived ? icon('i-archive') : null);
  node.append(el('div', { class: 'card-top' }, note.group_icon ? groupIcon(note.group_icon, 'ico gico') : null,
    el('h3', { class: 'card-title', text: note.title }), flags));
  if (note.description.trim()) {
    const md = renderMd(note.description, { maxBlocks: 9, onToggle: (line, checked) => toggleTaskInNote(note, line, checked) });
    node.append(el('div', { class: 'card-body' + (long ? ' fade' : '') }, md));
  }
  if (stats.total) {
    const bar = el('span', { class: 'bar' }, el('i'));
    bar.firstChild.style.width = `${Math.round(stats.done / stats.total * 100)}%`;
    node.append(el('div', { class: 'progress' }, bar, `${stats.done}/${stats.total}`));
  }
  const stop = fn => e => { e.stopPropagation(); fn(); };
  node.append(el('div', { class: 'card-foot' },
    reminderPill(note),
    note.group_name ? el('button', { type: 'button', class: 'pill group', on: { click: stop(() => applyFilter({ group: String(note.group_id) })) } }, note.group_name) : null,
    note.tags.map(t => el('button', { type: 'button', class: 'pill tag', text: '#' + t, on: { click: stop(() => applyFilter({ tag: t })) } })),
    el('span', { class: 'card-time', title: 'Editada ' + fullStamp(note.updated_at), text: relTime(note.updated_at) })));
  return node;
}

async function toggleTaskInNote(note, line, checked) {
  const before = note.description;
  note.description = setTask(before, line, checked);
  rerenderCurrent();
  try {
    const saved = await api(`/api/notes/${note.id}`, { method: 'PATCH', body: { description: note.description } });
    Object.assign(note, saved);
  } catch (err) {
    note.description = before;
    rerenderCurrent();
    reportError(err);
  }
}

function rerenderCurrent() {
  if (state.view === 'notes' && state.notes.loaded) renderNotes();
  if (state.view === 'agenda' && state.agenda.data) renderAgenda();
}

/* Filters */
function applyFilter(patch) {
  // Tapping the active group/tag again clears it.
  for (const key of ['group', 'tag']) if (key in patch && String(state.filters[key]).toLowerCase() === String(patch[key]).toLowerCase()) patch[key] = '';
  Object.assign(state.filters, patch);
  if ('sort' in patch) { try { localStorage.setItem('nb-sort', patch.sort); } catch { /* ignore */ } }
  syncFilterUi();
  if (state.view !== 'notes') go('notes'); else loadNotes();
}

function resetFilters() {
  state.filters = { ...DEFAULT_FILTERS, sort: state.filters.sort };
  $('search').value = '';
  syncFilterUi();
  loadNotes();
}

function syncFilterUi() {
  $('search-clear').hidden = !state.filters.search;
  const f = state.filters;
  const count = (f.tag ? 1 : 0) + (f.hasDate ? 1 : 0) + (f.archived !== 'false' ? 1 : 0);
  $('filter-count').hidden = !count;
  $('filter-count').textContent = count;
  $('open-filters').classList.toggle('on', count > 0);
  renderGroupChips();
  renderActiveFilters();
  renderSidebar();
  if (isOpen($('filters'))) renderFilterSheet();
}

function renderGroupChips() {
  const f = state.filters, s = state.summary;
  const chip = (label, value, iconNode, count) => el('button', {
    type: 'button', class: 'chip' + (String(f.group) === String(value) ? ' on' : ''),
    'aria-pressed': String(String(f.group) === String(value)),
    on: { click: () => applyFilter({ group: value === '' ? '' : String(value) }) },
  }, iconNode, label, count !== undefined ? el('span', { class: 'n', text: count }) : null);
  const chips = [chip('Totes', '', null, s?.total)];
  for (const g of groups()) chips.push(chip(g.name, g.id, groupIcon(g.icon), g.count));
  if (groups().length && s?.ungrouped) chips.push(chip('Sense grup', 'none', null, s.ungrouped));
  chips.push(el('button', { type: 'button', class: 'chip dashed', on: { click: () => openGroupDialog() } }, icon('i-plus'), 'Grup'));
  $('group-chips').replaceChildren(...chips);
}

function renderActiveFilters() {
  const f = state.filters, chips = [];
  const remove = (label, patch) => chips.push(el('button', { type: 'button', class: 'chip sm on removable', on: { click: () => { Object.assign(state.filters, patch); syncFilterUi(); loadNotes(); } } },
    label, el('span', { class: 'x' }, icon('i-x'))));
  if (f.tag) remove('#' + f.tag, { tag: '' });
  if (f.hasDate === 'true') remove('Amb recordatori', { hasDate: '' });
  if (f.hasDate === 'false') remove('Sense recordatori', { hasDate: '' });
  if (f.archived === 'true') remove('Arxivades', { archived: 'false' });
  if (f.archived === 'all') remove('Incloent arxivades', { archived: 'false' });
  $('active-filters').replaceChildren(...chips);
}

function renderFilterSheet() {
  const f = state.filters;
  const list = tags().filter(t => t.count || t.name.toLowerCase() === f.tag.toLowerCase());
  $('f-tags').replaceChildren(...list.map(t => el('button', {
    type: 'button', class: 'chip sm' + (f.tag.toLowerCase() === t.name.toLowerCase() ? ' on' : ''),
    on: { click: () => applyFilter({ tag: t.name }) },
  }, '#' + t.name, el('span', { class: 'n', text: t.count }))));
  if (!list.length) $('f-tags').append(el('span', { class: 'hint', text: 'Encara no hi ha etiquetes.' }));
  document.querySelectorAll('#filters .segmented').forEach(seg => {
    seg.querySelectorAll('button').forEach(b => {
      const on = b.dataset.value === f[seg.dataset.filter];
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  });
}

/* ═════════════ Agenda ═════════════ */
let agendaToken = 0;
async function loadAgenda() {
  const token = ++agendaToken;
  const day = state.agenda.day, from = startOfWeek(day), to = addDays(from, 6);
  renderWeek(state.agenda.data?.days || {});
  try {
    const data = await api(`/api/agenda?today=${state.today}&day=${day}&from=${from}&to=${to}`);
    if (token !== agendaToken) return;
    state.agenda.data = data;
    renderAgenda();
  } catch (err) { if (token === agendaToken) reportError(err); }
}

function renderWeek(days) {
  const day = state.agenda.day, from = startOfWeek(day);
  $('month-label').textContent = fmtMonth(day);
  $('week').replaceChildren(...Array.from({ length: 7 }, (_, i) => {
    const iso = addDays(from, i), info = days[iso];
    const dots = el('span', { class: 'dots' });
    if (info) {
      for (let k = 0; k < Math.min(info.pending, 3); k++) dots.append(el('i'));
      if (!info.pending && info.total) dots.append(el('i', { class: 'done' }));
    }
    return el('button', {
      type: 'button', role: 'option', class: 'day' + (iso === state.today ? ' today' : '') + (iso === day ? ' sel' : ''),
      'aria-selected': String(iso === day), 'aria-label': fmtLong(iso) + (info?.pending ? `, ${info.pending} pendents` : ''),
      on: { click: () => setAgendaDay(iso) },
    }, el('span', { class: 'dow', text: dowShort(iso) }), el('span', { class: 'num', text: parseISO(iso).getDate() }), dots);
  }));
}

function setAgendaDay(iso) {
  state.agenda.day = iso;
  loadAgenda();
}

function renderAgenda() {
  const data = state.agenda.data, day = state.agenda.day;
  renderWeek(data.days);
  const vis = list => list.filter(n => !state.hidden.has(n.id));
  const overdue = vis(data.overdue), items = vis(data.day), upcoming = vis(data.upcoming);
  const out = [];
  if (overdue.length) out.push(section('Endarrerits', overdue.length, el('div', { class: 'rem-list' }, overdue.map(n => reminderRow(n, 'overdue'))), { tone: 'red' }));
  const isToday = day === state.today;
  const head = el('header', { class: 'sec-head amber' }, el('h2', { class: 'label day-title' }, fmtLong(day),
    el('span', { class: 'pill ' + (isToday ? 'amber' : 'cyan'), text: relDay(day, state.today) })),
    el('button', { type: 'button', class: 'btn ghost sm', 'aria-label': 'Afegeix un recordatori', on: { click: () => openEditor(null, { date: day }) } }, icon('i-plus'), el('span', { class: 't', text: 'Afegeix' })));
  out.push(el('section', { class: 'sec' }, head, items.length
    ? el('div', { class: 'rem-list' }, items.map(n => reminderRow(n, 'day')))
    : el('div', { class: 'empty small' }, icon('i-check'), el('p', { text: isToday ? 'Res pendent per avui. Tot controlat.' : 'Cap recordatori per a aquest dia.' }))));
  if (isToday && upcoming.length) out.push(section('Propers', undefined, el('div', { class: 'rem-list' }, upcoming.map(n => reminderRow(n, 'upcoming')))));
  $('agenda-body').replaceChildren(...out);
}

function reminderRow(note, kind) {
  const diff = daysBetween(state.today, note.date);
  const cls = note.done ? 'done' : diff < 0 ? 'overdue' : diff === 0 ? 'pending' : '';
  const ring = el('button', {
    type: 'button', class: 'ring', 'aria-label': note.done ? 'Marca com a pendent' : 'Marca com a fet',
    on: { click: e => { e.stopPropagation(); toggleDone(note); } },
  }, icon('i-check'));
  const stats = taskStats(note.description);
  const meta = el('div', { class: 'rem-meta' },
    kind !== 'day' ? el('span', { class: 'pill ' + (diff < 0 ? 'red' : 'cyan') }, icon('i-clock'), relDay(note.date, state.today)) : null,
    stats.total ? el('span', { class: 'pill' }, icon('i-checkbox'), `${stats.done}/${stats.total}`) : null,
    note.group_name ? el('span', { class: 'pill group' }, note.group_name) : null,
    note.tags.slice(0, 3).map(t => el('span', { class: 'pill tag', text: '#' + t })));
  return el('div', { class: `rem ${cls}`, tabindex: '0', role: 'button', on: { click: () => openEditor(note), keydown: e => { if (e.key === 'Enter' && e.target === e.currentTarget) openEditor(note); } } },
    ring, el('div', { class: 'rem-main' }, el('span', { class: 'rem-title', text: note.title }), meta.childNodes.length ? meta : null), icon('i-chev-r', 'ico chev'));
}

async function toggleDone(note) {
  const done = !note.done;
  note.done = done;
  rerenderCurrent();
  try {
    await api(`/api/notes/${note.id}`, { method: 'PATCH', body: { done } });
    if (done) toast('Recordatori completat', { action: { label: 'Desfés', fn: () => { note.done = true; toggleDone(note); } } });
    refreshAll();
  } catch (err) {
    note.done = !done;
    rerenderCurrent();
    reportError(err);
  }
}

/* Swipe: horizontal gesture on the agenda changes the day (list) or week (strip). */
function swipeable(node, onSwipe) {
  let start = null;
  node.addEventListener('touchstart', e => { if (e.touches.length === 1) start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }; }, { passive: true });
  node.addEventListener('touchend', e => {
    if (!start) return;
    const t = e.changedTouches[0], dx = t.clientX - start.x, dy = t.clientY - start.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - start.t < 800) onSwipe(dx < 0 ? 1 : -1);
    start = null;
  }, { passive: true });
}

/* ═════════════ Explore ═════════════ */
function renderExplore() {
  const s = state.summary;
  if (!s) return;
  const stat = (value, label, tone, fn) => el('button', { type: 'button', class: 'stat ' + tone, on: { click: fn } }, el('b', { text: String(value).padStart(2, '0') }), el('span', { text: label }));
  $('stats').replaceChildren(
    stat(s.total, 'Notes', '', () => { resetFilters(); go('notes'); }),
    stat(s.pending, 'Pendents', s.overdue ? 'red' : 'amber', () => { state.agenda.day = state.today; go('agenda'); }),
    stat(s.upcoming, 'Propers', 'violet', () => { state.agenda.day = state.today; go('agenda'); }),
    stat(s.archived, 'Arxivades', 'green', () => applyFilter({ archived: 'true', group: '', tag: '' })));

  const tiles = groups().map(g => el('div', { class: 'gtile', role: 'button', tabindex: '0', on: { click: () => applyFilter({ group: String(g.id) }), keydown: e => { if (e.key === 'Enter') applyFilter({ group: String(g.id) }); } } },
    groupIcon(g.icon, 'ico gico'),
    el('div', {}, el('div', { class: 'gname', text: g.name }), el('div', { class: 'gcount', text: g.count === 1 ? '1 NOTA' : `${g.count} NOTES` })),
    el('button', { type: 'button', class: 'icon-btn gedit', 'aria-label': `Edita el grup ${g.name}`, on: { click: e => { e.stopPropagation(); openGroupDialog(g); } } }, icon('i-edit'))));
  if (s.ungrouped && groups().length) tiles.push(el('button', { type: 'button', class: 'gtile ghost', on: { click: () => applyFilter({ group: 'none' }) } },
    icon('g-folder', 'ico gico'), el('div', {}, el('div', { class: 'gname', text: 'Sense grup' }), el('div', { class: 'gcount', text: `${s.ungrouped} NOTES` }))));
  tiles.push(el('button', { type: 'button', class: 'gtile add', on: { click: () => openGroupDialog() } }, icon('i-plus', 'ico gico'), el('span', { text: 'Nou grup' })));
  $('group-grid').replaceChildren(...tiles);

  const cloud = $('tag-cloud');
  cloud.classList.toggle('editing', state.tagEdit);
  $('toggle-tag-edit').setAttribute('aria-pressed', String(state.tagEdit));
  $('toggle-tag-edit').querySelector('span').textContent = state.tagEdit ? 'Fet' : 'Gestiona';
  cloud.replaceChildren(...tags().map(t => el('button', {
    type: 'button', class: 'chip', on: { click: () => state.tagEdit ? openTagDialog(t) : applyFilter({ tag: t.name }) },
  }, icon('i-edit'), '#' + t.name, el('span', { class: 'n', text: t.count }))));
  if (!tags().length) cloud.append(el('p', { class: 'hint', text: 'Encara no hi ha etiquetes. Afegeix-ne des de l’editor d’una nota.' }));
}

/* ═════════════ Editor ═════════════ */
const ed = { note: null, tags: [], groupId: null, pinned: false, archived: false, initial: '', saving: false, newGroupIcon: 'folder' };

function editorSnapshot() {
  return JSON.stringify([$('ed-title').value.trim(), $('ed-body').value, $('ed-date').value, $('ed-done').checked, ed.groupId, ed.tags, ed.pinned, $('ed-tag-input').value.trim()]);
}
const editorDirty = () => editorSnapshot() !== ed.initial;

function openEditor(note = null, { date = null } = {}) {
  ed.note = note;
  ed.tags = note ? [...note.tags] : [];
  ed.groupId = note?.group_id ?? (!note && state.view === 'notes' && /^\d+$/.test(state.filters.group) ? Number(state.filters.group) : null);
  if (!note && state.view === 'notes' && state.filters.tag) ed.tags = [state.filters.tag];
  ed.pinned = !!note?.pinned;
  ed.archived = !!note?.archived;
  $('editor-heading').textContent = note ? (note.archived ? 'NOTA ARXIVADA' : 'EDITA LA NOTA') : (date ? 'NOU RECORDATORI' : 'NOVA NOTA');
  $('ed-title').value = note?.title || '';
  $('ed-body').value = note?.description || '';
  $('ed-date').value = note?.date || date || '';
  $('ed-done').checked = !!note?.done;
  $('ed-tag-input').value = '';
  $('ed-error').textContent = '';
  $('ed-stamp').textContent = note ? `CREADA ${fullStamp(note.created_at).toUpperCase()} · EDITADA ${relTime(note.updated_at).toUpperCase()}` : '';
  $('ed-archive').hidden = $('ed-delete').hidden = !note;
  { const label = ed.archived ? 'Desarxiva' : 'Arxiva'; $('ed-archive').title = label; $('ed-archive').setAttribute('aria-label', label); }
  $('ed-new-group').hidden = true;
  setEditorMode('edit');
  syncPin();
  renderDateProp();
  renderGroupProp();
  renderTagProp();
  setSaving(false);
  openModal($('editor'));
  autosize();
  ed.initial = editorSnapshot();
  $('editor').querySelector('.editor-scroll').scrollTop = 0;
  if (!note) $('ed-title').focus();
}

function syncPin() {
  $('ed-pin').setAttribute('aria-pressed', String(ed.pinned));
  $('ed-pin').title = ed.pinned ? 'Deixa de fixar' : 'Fixa';
}

function setEditorMode(mode) {
  document.querySelectorAll('.ed-tabs button').forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  $('ed-body').hidden = mode !== 'edit';
  $('ed-preview').hidden = mode !== 'preview';
  document.querySelector('.fmt').hidden = mode !== 'edit';
  if (mode === 'preview') renderPreview(); else autosize();
}

function renderPreview() {
  const text = $('ed-body').value;
  $('ed-preview').replaceChildren(text.trim() ? renderMd(text, { onToggle: (line, checked) => { $('ed-body').value = setTask($('ed-body').value, line, checked); renderPreview(); } })
    : el('p', { class: 'hint', text: 'Res a mostrar encara.' }));
}

function autosize() {
  const t = $('ed-body');
  if (t.hidden) return;
  t.style.height = 'auto';
  t.style.height = Math.max(150, t.scrollHeight + 2) + 'px';
}

function renderDateProp() {
  const value = $('ed-date').value, today = state.today;
  const options = [['Cap', ''], ['Avui', today], ['Demà', addDays(today, 1)], ['Dilluns', nextWeekday(today, 1)], ['En una setmana', addDays(today, 7)]];
  $('ed-date-chips').replaceChildren(...options.map(([label, iso]) => el('button', {
    type: 'button', class: 'chip sm' + (value === iso ? ' on' : ''), 'aria-pressed': String(value === iso),
    title: iso ? fmtLong(iso) : 'Sense recordatori',
    on: { click: () => { $('ed-date').value = iso; if (!iso) $('ed-done').checked = false; renderDateProp(); } },
  }, label)));
  $('ed-date-label').textContent = value ? `${fmtLong(value)} · ${relDay(value, today)}` : 'Sense recordatori: no sortirà a l’agenda.';
  $('ed-date-label').classList.toggle('hint', !value);
  $('ed-done-wrap').hidden = !value;
}

function renderGroupProp() {
  const chip = (label, id, iconNode) => el('button', {
    type: 'button', class: 'chip sm' + (ed.groupId === id ? ' on' : ''), 'aria-pressed': String(ed.groupId === id),
    on: { click: () => { ed.groupId = id; renderGroupProp(); } },
  }, iconNode, label);
  $('ed-groups').replaceChildren(chip('Cap', null, null), ...groups().map(g => chip(g.name, g.id, groupIcon(g.icon))),
    el('button', { type: 'button', class: 'chip sm dashed', on: { click: showInlineGroupForm } }, icon('i-plus'), 'Nou grup'));
}

function showInlineGroupForm() {
  $('ed-new-group').hidden = false;
  $('ed-new-group-name').value = '';
  ed.newGroupIcon = 'folder';
  renderIconGrid($('ed-new-group-icons'), () => ed.newGroupIcon, v => { ed.newGroupIcon = v; });
  $('ed-new-group-name').focus();
}

async function createInlineGroup() {
  const name = $('ed-new-group-name').value.trim();
  if (!name) { $('ed-new-group-name').focus(); return; }
  try {
    const g = await api('/api/groups', { method: 'POST', body: { name, icon: ed.newGroupIcon } });
    await loadSummary();
    ed.groupId = g.id;
    $('ed-new-group').hidden = true;
    renderGroupProp();
  } catch (err) { reportError(err); }
}

function renderIconGrid(container, get, set) {
  container.replaceChildren(...GROUP_ICONS.map(([id, label]) => el('button', {
    type: 'button', role: 'radio', 'aria-checked': String(get() === id), 'aria-label': label, title: label,
    on: { click: () => { set(id); renderIconGrid(container, get, set); } },
  }, groupIcon(id))));
}

function normalizeTag(raw) { return raw.replace(/,/g, ' ').trim().replace(/^#+/, '').trim().slice(0, 60); }
function addTag(raw) {
  const name = normalizeTag(raw);
  if (!name || ed.tags.some(t => t.toLowerCase() === name.toLowerCase()) || ed.tags.length >= 30) return;
  ed.tags.push(name);
}
function renderTagProp() {
  const box = $('ed-tags'), input = $('ed-tag-input');
  box.querySelectorAll('.chip').forEach(c => c.remove());
  for (const t of ed.tags) box.insertBefore(el('button', {
    type: 'button', class: 'chip sm on removable', 'aria-label': `Treu l'etiqueta ${t}`,
    on: { click: e => { e.stopPropagation(); ed.tags = ed.tags.filter(x => x !== t); renderTagProp(); } },
  }, '#' + t, el('span', { class: 'x' }, icon('i-x'))), input);
  const q = normalizeTag(input.value).toLowerCase();
  const taken = new Set(ed.tags.map(t => t.toLowerCase()));
  const suggestions = tags().filter(t => !taken.has(t.name.toLowerCase()) && (!q || t.name.toLowerCase().includes(q)))
    .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || b.count - a.count).slice(0, 8);
  $('ed-tag-suggest').replaceChildren(...suggestions.map(t => el('button', {
    type: 'button', class: 'chip', text: '#' + t.name,
    on: { click: () => { addTag(t.name); input.value = ''; renderTagProp(); input.focus(); } },
  })));
  if (q && !suggestions.some(t => t.name.toLowerCase() === q)) $('ed-tag-suggest').prepend(el('button', {
    type: 'button', class: 'chip on', on: { click: () => { addTag(input.value); input.value = ''; renderTagProp(); input.focus(); } },
  }, icon('i-plus'), `Crea #${normalizeTag(input.value)}`));
}

function setSaving(saving) {
  ed.saving = saving;
  const btn = $('ed-save');
  btn.disabled = saving;
  btn.replaceChildren(...(saving ? [el('span', { class: 'spinner' }), el('span', { text: 'Desant…' })]
    : [el('span', { text: 'Desa' }), el('kbd', { class: 'desktop-only', text: 'Ctrl ↵' })]));
}

async function saveEditor({ archived = ed.archived } = {}) {
  if (ed.saving) return;
  if ($('ed-tag-input').value.trim()) { addTag($('ed-tag-input').value); $('ed-tag-input').value = ''; renderTagProp(); }
  let title = $('ed-title').value.trim();
  const description = $('ed-body').value;
  // Quick capture: with no title, the first line of the text becomes the title.
  if (!title && description.trim()) {
    const first = description.trim().split('\n')[0].replace(/^\s*([-*+]\s(\[[ xX]\]\s)?|#+\s|\d+[.)]\s)/, '').trim();
    title = first.slice(0, 120);
  }
  if (!title) { $('ed-error').textContent = 'Escriu un títol o una mica de text.'; $('ed-title').focus(); return; }
  const date = $('ed-date').value || null;
  const payload = { title, description, date, done: !!date && $('ed-done').checked, group_id: ed.groupId, pinned: ed.pinned, archived, tags: ed.tags };
  const existing = ed.note;
  setSaving(true);
  $('ed-error').textContent = '';
  try {
    const saved = await api(existing ? `/api/notes/${existing.id}` : '/api/notes', { method: existing ? 'PUT' : 'POST', body: payload });
    setSaving(false);
    await closeModal($('editor'), { force: true });
    if (archived !== !!existing?.archived) {
      toast(archived ? 'Nota arxivada' : 'Nota recuperada de l’arxiu', { action: { label: 'Desfés', fn: () => patchNote(saved.id, { archived: !archived }) } });
    } else if (!existing && saved.date && state.view !== 'agenda') {
      toast(`Recordatori creat · ${relDay(saved.date, state.today)}`, { action: { label: 'Veure', fn: () => { state.agenda.day = saved.date; go('agenda'); } } });
    } else toast(existing ? 'Canvis desats' : 'Nota creada');
    refreshAll();
  } catch (err) {
    setSaving(false);
    $('ed-error').textContent = err.offline ? 'Sense connexió: no s’ha desat. Torna-ho a provar.' : err.message;
  }
}

async function patchNote(id, body) {
  try { await api(`/api/notes/${id}`, { method: 'PATCH', body }); refreshAll(); }
  catch (err) { reportError(err); }
}

/* Delete with undo: hide now, delete after the toast window. */
function scheduleDelete(note) {
  state.hidden.add(note.id);
  rerenderCurrent();
  const commit = () => {
    state.pendingDeletes.delete(note.id);
    api(`/api/notes/${note.id}`, { method: 'DELETE', keepalive: true })
      .catch(err => { if (err.status !== 404) reportError(err); })
      .finally(() => { state.hidden.delete(note.id); refreshAll(); });
  };
  state.pendingDeletes.set(note.id, { timer: setTimeout(commit, 6000), commit });
  toast(`«${note.title.slice(0, 40)}» eliminada`, {
    timeout: 6000,
    action: { label: 'Desfés', fn: () => { clearTimeout(state.pendingDeletes.get(note.id)?.timer); state.pendingDeletes.delete(note.id); state.hidden.delete(note.id); rerenderCurrent(); } },
  });
}
window.addEventListener('pagehide', () => { for (const { timer, commit } of state.pendingDeletes.values()) { clearTimeout(timer); commit(); } });

function wireEditor() {
  const dialog = $('editor');
  wireDialog(dialog);
  setGuard(dialog, async () => !editorDirty() || confirmDialog({ title: 'Vols descartar els canvis?', text: 'Tens canvis sense desar en aquesta nota.', yes: 'Descarta', no: 'Continua editant', danger: true }));
  $('note-form').addEventListener('submit', e => { e.preventDefault(); saveEditor(); });
  dialog.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEditor(); } });
  $('ed-title').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); $('ed-body').focus(); } });
  $('ed-pin').addEventListener('click', () => { ed.pinned = !ed.pinned; syncPin(); });
  $('ed-archive').addEventListener('click', () => saveEditor({ archived: !ed.archived }));
  $('ed-delete').addEventListener('click', async () => {
    const note = ed.note;
    await closeModal(dialog, { force: true });
    scheduleDelete(note);
  });
  document.querySelectorAll('.ed-tabs button').forEach(b => b.addEventListener('click', () => setEditorMode(b.dataset.mode)));
  $('ed-date').addEventListener('change', renderDateProp);
  $('ed-new-group-save').addEventListener('click', createInlineGroup);
  $('ed-new-group-cancel').addEventListener('click', () => { $('ed-new-group').hidden = true; });
  $('ed-new-group-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); createInlineGroup(); } });

  const tagInput = $('ed-tag-input');
  $('ed-tags').addEventListener('click', () => tagInput.focus());
  tagInput.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && tagInput.value.trim())) && !e.ctrlKey && !e.metaKey) {
      if (!tagInput.value.trim()) { if (e.key === 'Enter') e.preventDefault(); return; }
      e.preventDefault(); addTag(tagInput.value); tagInput.value = ''; renderTagProp();
    } else if (e.key === 'Backspace' && !tagInput.value && ed.tags.length) { ed.tags.pop(); renderTagProp(); }
  });
  tagInput.addEventListener('input', () => {
    if (tagInput.value.includes(',')) { const parts = tagInput.value.split(','); tagInput.value = parts.pop(); parts.forEach(addTag); }
    renderTagProp();
  });

  const body = $('ed-body');
  body.addEventListener('input', autosize);
  body.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    const { selectionStart: pos, value } = body;
    if (pos !== body.selectionEnd) return;
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    const cont = listContinuation(value.slice(lineStart, pos));
    if (!cont) return;
    e.preventDefault();
    if (cont.empty) { body.setSelectionRange(lineStart, pos); insertText(body, ''); }
    else insertText(body, '\n' + cont.prefix);
    autosize();
  });
  document.querySelectorAll('[data-fmt]').forEach(b => b.addEventListener('click', () => {
    const prefix = { task: '- [ ] ', list: '- ', heading: '# ' }[b.dataset.fmt];
    const { selectionStart: pos, value } = body;
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    const line = value.slice(lineStart, value.indexOf('\n', pos) === -1 ? value.length : value.indexOf('\n', pos));
    body.focus();
    if (line.trim()) {
      if (line.startsWith(prefix)) return;
      body.setSelectionRange(lineStart, lineStart); insertText(body, prefix);
      body.setSelectionRange(pos + prefix.length, pos + prefix.length);
    } else insertText(body, prefix);
    autosize();
  }));
}

/* Keeps native undo when possible. */
function insertText(textarea, text) {
  if (!document.execCommand?.('insertText', false, text)) textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
}

/* ═════════════ Group & tag dialogs ═════════════ */
const groupEd = { group: null, icon: 'folder' };
function openGroupDialog(group = null) {
  groupEd.group = group;
  groupEd.icon = group?.icon || 'folder';
  $('group-title').textContent = group ? 'Edita el grup' : 'Nou grup';
  $('group-save').textContent = group ? 'Desa' : 'Crea el grup';
  $('group-name').value = group?.name || '';
  $('group-error').textContent = '';
  $('group-delete').hidden = !group;
  renderIconGrid($('group-icons'), () => groupEd.icon, v => { groupEd.icon = v; });
  openModal($('group-dialog'));
  $('group-name').focus();
}

function wireGroupDialog() {
  wireDialog($('group-dialog'));
  $('group-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('group-name').value.trim();
    if (!name) { $('group-error').textContent = 'Cal un nom.'; return; }
    const g = groupEd.group;
    try {
      await api(g ? `/api/groups/${g.id}` : '/api/groups', { method: g ? 'PUT' : 'POST', body: { name, icon: groupEd.icon } });
      await closeModal($('group-dialog'), { force: true });
      toast(g ? 'Grup actualitzat' : `Grup «${name}» creat`);
      refreshAll();
    } catch (err) { $('group-error').textContent = err.message; }
  });
  $('group-delete').addEventListener('click', async () => {
    const g = groupEd.group;
    const ok = await confirmDialog({
      title: `Vols eliminar el grup «${g.name}»?`,
      text: g.count ? `Les ${g.count} notes del grup no s’esborren: quedaran sense grup.` : 'El grup és buit.',
      yes: 'Elimina el grup', danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/groups/${g.id}`, { method: 'DELETE' });
      await closeModal($('group-dialog'), { force: true });
      if (String(state.filters.group) === String(g.id)) { state.filters.group = ''; syncFilterUi(); }
      toast('Grup eliminat');
      refreshAll();
    } catch (err) { $('group-error').textContent = err.message; }
  });
}

let tagEditing = null;
function openTagDialog(tag) {
  tagEditing = tag;
  $('tag-title').textContent = `#${tag.name}`;
  $('tag-name').value = tag.name;
  $('tag-error').textContent = '';
  openModal($('tag-dialog'));
  $('tag-name').focus();
}

function wireTagDialog() {
  wireDialog($('tag-dialog'));
  $('tag-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = normalizeTag($('tag-name').value);
    if (!name) { $('tag-error').textContent = 'Cal un nom.'; return; }
    try {
      await api(`/api/tags/${tagEditing.id}`, { method: 'PUT', body: { name } });
      if (state.filters.tag.toLowerCase() === tagEditing.name.toLowerCase()) state.filters.tag = name;
      await closeModal($('tag-dialog'), { force: true });
      toast('Etiqueta actualitzada');
      refreshAll();
    } catch (err) { $('tag-error').textContent = err.message; }
  });
  $('tag-delete').addEventListener('click', async () => {
    const t = tagEditing;
    const ok = await confirmDialog({ title: `Vols eliminar #${t.name}?`, text: t.count ? `Es traurà de ${t.count === 1 ? '1 nota' : t.count + ' notes'}. Les notes no s’esborren.` : '', yes: 'Elimina', danger: true });
    if (!ok) return;
    try {
      await api(`/api/tags/${t.id}`, { method: 'DELETE' });
      if (state.filters.tag.toLowerCase() === t.name.toLowerCase()) { state.filters.tag = ''; syncFilterUi(); }
      await closeModal($('tag-dialog'), { force: true });
      toast('Etiqueta eliminada');
      refreshAll();
    } catch (err) { $('tag-error').textContent = err.message; }
  });
}

/* ═════════════ Global wiring ═════════════ */
function newNoteFromContext() {
  openEditor(null, { date: state.view === 'agenda' ? state.agenda.day : null });
}

function focusSearch() {
  if (state.view !== 'notes') go('notes');
  requestAnimationFrame(() => { $('search').focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
}

function checkDayRollover() {
  const now = todayISO();
  if (now === state.today) return false;
  if (state.agenda.day === state.today) state.agenda.day = now;
  state.today = now;
  return true;
}

function startClock() {
  const tick = () => {
    $('clock').textContent = new Date().toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit' });
    if (checkDayRollover()) refreshAll();
  };
  tick();
  setInterval(tick, 30000);
  setInterval(loadSummary, 5 * 60000);
}

function remindOnce() {
  const s = state.summary;
  if (!s?.pending || state.view === 'agenda') return;
  const key = 'nb-reminded-' + state.today;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* ignore */ }
  toast(s.pending === 1 ? 'Tens 1 recordatori pendent' : `Tens ${s.pending} recordatoris pendents`, {
    type: 'warn', timeout: 6000, action: { label: 'Veure', fn: () => { state.agenda.day = state.today; go('agenda'); } },
  });
}

function init() {
  document.querySelectorAll('[data-action=new]').forEach(b => b.addEventListener('click', newNoteFromContext));
  document.querySelectorAll('[data-action=search]').forEach(b => b.addEventListener('click', focusSearch));
  $('bell').addEventListener('click', () => { state.agenda.day = state.today; go('agenda'); });
  $('reminder-alert').addEventListener('click', () => { state.agenda.day = state.today; go('agenda'); });

  const search = $('search');
  const runSearch = debounce(() => loadNotes(), 160);
  search.addEventListener('input', () => { state.filters.search = search.value; $('search-clear').hidden = !search.value; runSearch(); });
  search.addEventListener('keydown', e => { if (e.key === 'Escape' && search.value) { e.preventDefault(); $('search-clear').click(); } if (e.key === 'Enter') search.blur(); });
  $('search-clear').addEventListener('click', () => { search.value = ''; state.filters.search = ''; syncFilterUi(); loadNotes(); search.focus(); });
  $('open-filters').addEventListener('click', () => { renderFilterSheet(); openModal($('filters')); });
  wireDialog($('filters'));
  document.querySelectorAll('#filters .segmented').forEach(seg => seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) applyFilter({ [seg.dataset.filter]: b.dataset.value });
  }));
  $('f-reset').addEventListener('click', () => { resetFilters(); renderFilterSheet(); });

  $('week-prev').addEventListener('click', () => setAgendaDay(addDays(state.agenda.day, -7)));
  $('week-next').addEventListener('click', () => setAgendaDay(addDays(state.agenda.day, 7)));
  $('go-today').addEventListener('click', () => setAgendaDay(state.today));
  swipeable($('agenda-body'), dir => setAgendaDay(addDays(state.agenda.day, dir)));
  swipeable($('week'), dir => setAgendaDay(addDays(state.agenda.day, dir * 7)));

  $('new-group').addEventListener('click', () => openGroupDialog());
  $('toggle-tag-edit').addEventListener('click', () => { state.tagEdit = !state.tagEdit; renderExplore(); });

  wireEditor();
  wireGroupDialog();
  wireTagDialog();
  onModalClose($('editor'), () => { ed.note = null; });

  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); newNoteFromContext(); }
    else if (e.key === '/') { e.preventDefault(); focusSearch(); }
  });

  onNetwork(online => {
    document.querySelectorAll('[data-net]').forEach(l => l.classList.toggle('off', !online));
    document.querySelectorAll('[data-net-label]').forEach(l => { l.textContent = online ? 'EN LÍNIA' : 'FORA DE LÍNIA'; });
  });
  window.addEventListener('online', () => refreshAll());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { checkDayRollover(); refreshAll(); } });
  window.addEventListener('hashchange', () => showView(currentView()));

  syncFilterUi();
  startClock();
  showView(currentView());
  loadSummary().then(remindOnce);

  const params = new URLSearchParams(location.search);
  if (params.has('new')) { history.replaceState(null, '', location.pathname + location.hash); newNoteFromContext(); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(err => console.warn('SW', err));
}

init();

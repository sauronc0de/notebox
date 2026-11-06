export const $ = id => document.getElementById(id);

/** Small DOM builder: el('div', {class:'x', text:'y', on:{click}}, child, ...) */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'on') for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

export function icon(name, cls = 'ico') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + name);
  svg.append(use);
  return svg;
}

export const GROUP_ICONS = [
  ['folder', 'Carpeta'], ['briefcase', 'Feina'], ['home', 'Casa'], ['cpu', 'Tecnologia'], ['code', 'Codi'],
  ['star', 'Estrella'], ['book', 'Llibre'], ['school', 'Estudis'], ['lightbulb', 'Idea'], ['gaming', 'Gaming'],
  ['football', 'Futbol'], ['barbell', 'Gimnàs'], ['health', 'Salut'], ['heart', 'Cor'], ['food', 'Menjar'],
  ['gift', 'Regals'], ['cat', 'Gats'], ['plane', 'Viatges'], ['car', 'Cotxe'], ['music', 'Música'],
  ['camera', 'Fotografia'], ['wallet', 'Finances'], ['users', 'Persones'], ['leaf', 'Natura']];
const KNOWN_ICONS = new Set(GROUP_ICONS.map(([id]) => id));
export const groupIcon = (name, cls = 'ico') => icon('g-' + (KNOWN_ICONS.has(name) ? name : 'folder'), cls);

/* ───────── Dates (always local, ISO yyyy-mm-dd) ───────── */
const pad = n => String(n).padStart(2, '0');
export const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = () => isoDate(new Date());
export function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
export function addDays(iso, n) { const d = parseISO(iso); d.setDate(d.getDate() + n); return isoDate(d); }
export function startOfWeek(iso) { const d = parseISO(iso); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return isoDate(d); }
export const daysBetween = (fromIso, toIso) => Math.round((parseISO(toIso) - parseISO(fromIso)) / 86400000);
export function nextWeekday(iso, weekday) { // weekday: 0=Sunday … 6=Saturday; always strictly after iso
  const d = parseISO(iso); const diff = ((weekday - d.getDay() + 7) % 7) || 7; d.setDate(d.getDate() + diff); return isoDate(d);
}

export const fmt = (iso, opts) => parseISO(iso).toLocaleDateString('ca-ES', opts);
const MONTHS = ['gen.', 'febr.', 'març', 'abr.', 'maig', 'juny', 'jul.', 'ag.', 'set.', 'oct.', 'nov.', 'des.'];
/** "dg. 8 nov." */
export const fmtShort = iso => { const d = parseISO(iso); return `${fmt(iso, { weekday: 'short' }).replace(/\.?$/, '.')} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
export const fmtLong = iso => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' });
export const fmtMonth = iso => fmt(iso, { month: 'long', year: 'numeric' });
export const dowShort = iso => fmt(iso, { weekday: 'short' }).replace('.', '');

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** "Avui", "Demà", "Ahir", "fa 3 dies", "d'aquí a 5 dies" */
export function relDay(iso, today = todayISO()) {
  const diff = daysBetween(today, iso);
  if (diff === 0) return 'Avui';
  if (diff === 1) return 'Demà';
  if (diff === -1) return 'Ahir';
  if (diff < 0) return 'fa ' + plural(-diff, 'dia', 'dies');
  if (diff < 7) return "d'aquí a " + plural(diff, 'dia', 'dies');
  return fmtShort(iso);
}

/** Relative time for server UTC timestamps. */
export function relTime(ts) {
  const date = new Date(ts);
  const sec = (Date.now() - date) / 1000;
  if (sec < 60) return 'ara mateix';
  if (sec < 3600) return `fa ${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `fa ${Math.floor(sec / 3600)} h`;
  const days = daysBetween(isoDate(date), todayISO());
  if (days === 1) return 'ahir';
  if (days < 7) return `fa ${days} dies`;
  return date.toLocaleDateString('ca-ES', { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
}

export const fullStamp = ts => new Date(ts).toLocaleString('ca-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

const MESSAGES = {
  'Already exists': 'Ja existeix un element amb aquest nom.',
  'Title is required': 'Cal un títol.',
  'Invalid title': 'El títol no és vàlid (màxim 500 caràcters).',
  'Invalid tag': 'Etiqueta no vàlida (sense comes, màxim 60 caràcters).',
  'Invalid tags': 'Massa etiquetes (màxim 30).',
  'Invalid date': 'La data no és vàlida.',
  'Invalid group name': 'El nom del grup no és vàlid.',
  'Group name is required': 'Cal un nom per al grup.',
  'Note not found': 'Aquesta nota ja no existeix.',
  'Group not found': 'Aquest grup ja no existeix.',
  'Tag not found': 'Aquesta etiqueta ja no existeix.',
  'Description too long': 'El text és massa llarg.',
};

export class ApiError extends Error {
  constructor(message, { status = 0, offline = false } = {}) { super(message); this.status = status; this.offline = offline; }
}

const listeners = new Set();
let online = true;
export const onNetwork = fn => { listeners.add(fn); fn(online); };
function setOnline(value) { if (value !== online) { online = value; listeners.forEach(fn => fn(online)); } }

export async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method, keepalive,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    setOnline(false);
    throw new ApiError('Sense connexió amb el servidor.', { offline: true });
  }
  // The service worker marks responses served from its offline cache.
  setOnline(!response.headers.get('X-Notebox-Offline'));
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const raw = data.error || `HTTP ${response.status}`;
    throw new ApiError(MESSAGES[raw] || raw, { status: response.status });
  }
  return response.status === 204 ? null : response.json();
}

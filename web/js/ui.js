import { $, el, icon } from './util.js';

/* ───────── Toasts ───────── */
export function toast(message, { type = 'info', action, timeout = 3600 } = {}) {
  const box = $('toasts');
  const iconName = type === 'error' ? 'i-alert' : type === 'warn' ? 'i-bell' : 'i-check';
  const node = el('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, icon(iconName), el('span', { text: message }));
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    if (!node.isConnected) return;
    node.classList.add('out');
    setTimeout(() => node.remove(), 200);
  };
  if (action) node.append(el('button', { type: 'button', text: action.label, on: { click: () => { dismiss(); action.fn(); } } }));
  while (box.children.length >= 3) box.firstChild.remove();
  box.append(node);
  timer = setTimeout(dismiss, timeout);
  return { dismiss };
}

/* ───────── Confirm ───────── */
export function confirmDialog({ title, text = '', yes = "D'acord", no = 'Cancel·la', danger = false }) {
  const d = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-text').hidden = !text;
  const yesBtn = $('confirm-yes'), noBtn = $('confirm-no');
  yesBtn.textContent = yes; noBtn.textContent = no;
  yesBtn.className = 'btn ' + (danger ? 'danger-ghost' : 'primary');
  return new Promise(resolve => {
    const done = value => {
      d.removeEventListener('cancel', onCancel);
      yesBtn.onclick = noBtn.onclick = null;
      d.close();
      resolve(value);
    };
    const onCancel = e => { e.preventDefault(); done(false); };
    d.addEventListener('cancel', onCancel);
    yesBtn.onclick = () => done(true);
    noBtn.onclick = () => done(false);
    d.showModal();
    noBtn.focus();
  });
}

/* ───────── Modals with history (Android back button closes them) ───────── */
const stack = [];
const guards = new WeakMap();
const onCloseHandlers = new WeakMap();
let skipPops = 0;

export const setGuard = (dialog, fn) => guards.set(dialog, fn);
export const onModalClose = (dialog, fn) => onCloseHandlers.set(dialog, fn);
export const isOpen = dialog => stack.includes(dialog);

export function openModal(dialog) {
  if (stack.includes(dialog)) return;
  dialog.showModal();
  stack.push(dialog);
  history.pushState({ notebox: stack.length }, '');
}

export async function closeModal(dialog, { force = false, fromPop = false } = {}) {
  if (!stack.includes(dialog)) return true;
  const guard = guards.get(dialog);
  if (!force && guard && !(await guard())) {
    if (fromPop) history.pushState({ notebox: stack.length }, '');
    return false;
  }
  dialog.close();
  stack.splice(stack.indexOf(dialog), 1);
  onCloseHandlers.get(dialog)?.();
  if (!fromPop) { skipPops++; history.back(); }
  return true;
}

window.addEventListener('popstate', () => {
  if (skipPops) { skipPops--; return; }
  const top = stack.at(-1);
  if (top) closeModal(top, { fromPop: true });
});

/** Wire Esc, [data-close] buttons and backdrop taps for every managed dialog. */
export function wireDialog(dialog) {
  dialog.addEventListener('cancel', e => { e.preventDefault(); closeModal(dialog); });
  dialog.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(dialog)));
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', e => { downOnBackdrop = e.target === dialog; });
  dialog.addEventListener('click', e => { if (e.target === dialog && downOnBackdrop) closeModal(dialog); });
}

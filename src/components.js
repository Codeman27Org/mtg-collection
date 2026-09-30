import QRCode from 'qrcode';
import { h } from './dom.js';
import * as account from './account.js';

export function modal({ title, content, wide = false, onClose }) {
  const body = h('div', { class: 'modal-body' }, content);
  const dlg = h(
    'dialog',
    { class: `modal${wide ? ' modal-wide' : ''}`, 'aria-label': title },
    h(
      'header',
      { class: 'modal-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.dismiss() }, '✕'),
    ),
    body,
  );
  let finished = false;
  // Leaving the page (a link, or the phone's Back button) closes the dialog instead of leaving it over the next page.
  const onNavigate = () => dlg.dismiss();
  const finish = () => {
    if (finished) return;
    finished = true;
    removeEventListener('hashchange', onNavigate);
    dlg.remove();
    onClose?.();
  };
  // The native close event is async (and deferred in background tabs); dismiss() finishes immediately.
  dlg.dismiss = () => {
    if (dlg.open) dlg.close();
    finish();
  };
  dlg.addEventListener('close', finish);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.dismiss();
  });
  document.body.append(dlg);
  dlg.showModal();
  addEventListener('hashchange', onNavigate);
  dlg.setBody = (node) => body.replaceChildren(node);
  return dlg;
}

let toastRegion;
export function toast(message, kind = 'info') {
  toastRegion ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: `toast toast-${kind}` }, message);
  toastRegion.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

/** Wraps an async handler: disables the button while running and toasts errors. */
export function action(fn) {
  return async (event) => {
    const btn = event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
    if (btn) btn.disabled = true;
    try {
      await fn(event);
    } catch (err) {
      console.error(err);
      toast(err.message ?? String(err), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

export function confirmDialog(message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const dlg = modal({
      title: 'Are you sure?',
      content: [
        h('p', {}, message),
        h(
          'div',
          { class: 'row end' },
          h('button', { class: 'btn', type: 'button', onclick: () => dlg.dismiss() }, 'Cancel'),
          h(
            'button',
            {
              class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
              type: 'button',
              onclick: () => {
                result = true;
                dlg.dismiss();
              },
            },
            confirmLabel,
          ),
        ),
      ],
      onClose: () => resolve(result),
    });
  });
}

export function lockedBanner() {
  if (account.canEdit() || !account.current()) return null;
  return h(
    'div',
    { class: 'banner banner-warn' },
    'Read-only: log in with your nsec to make changes. ',
    h('a', { href: '#/welcome' }, 'Log in'),
  );
}

export async function qrImage(text, alt) {
  const src = await QRCode.toDataURL(text, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
  return h('img', { class: 'qr', src, alt, width: 240, height: 240 });
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint && h('span', { class: 'field-hint' }, hint));
}

export function selectInput(options, value, onchange, attrs = {}) {
  return h(
    'select',
    { ...attrs, onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)),
  );
}

/**
 * A select drawn in the page. Native select popups are placed by the host window,
 * which embedded browsers (like VS Code's) can get wrong inside a modal dialog.
 */
export function dropdown(options, value, onchange, { label }) {
  let current = value;
  const labelOf = (v) => options.find(([o]) => o === v)?.[1] ?? '';
  const text = h('span', { class: 'dropdown-text' }, labelOf(current));
  const button = h(
    'button',
    { type: 'button', class: 'btn dropdown-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': `${label}: ${labelOf(current)}` },
    text,
    h('span', { class: 'dropdown-caret', 'aria-hidden': 'true' }, '▾'),
  );
  const items = options.map(([v, l]) =>
    h('button', { type: 'button', class: 'menu-item', role: 'option', 'aria-selected': String(v === current), tabindex: -1, onclick: () => choose(v) }, l),
  );
  const list = h('div', { class: 'menu-list dropdown-list', role: 'listbox', 'aria-label': label, hidden: true }, items);
  const wrap = h('div', { class: 'dropdown' }, button, list);

  const onOutside = (e) => {
    if (!wrap.contains(e.target)) close();
  };
  function open() {
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    // Open upward when there isn't room below (e.g. near the bottom of a dialog).
    const below = window.innerHeight - button.getBoundingClientRect().bottom;
    wrap.classList.toggle('dropdown-up', below < list.offsetHeight + 8 && button.getBoundingClientRect().top > below);
    document.addEventListener('pointerdown', onOutside, true);
    (items.find((b) => b.getAttribute('aria-selected') === 'true') ?? items[0])?.focus();
  }
  function close(refocus = false) {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (refocus) button.focus();
  }
  function choose(v) {
    wrap.setValue(v);
    close(true);
    onchange(v);
  }
  /** Updates the shown value without firing onchange. */
  wrap.setValue = (v) => {
    current = v;
    text.textContent = labelOf(v);
    button.setAttribute('aria-label', `${label}: ${labelOf(v)}`);
    for (const [i, b] of items.entries()) b.setAttribute('aria-selected', String(options[i][0] === v));
  };

  button.addEventListener('click', () => (list.hidden ? open() : close()));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1].focus();
    } else if (e.key === 'Escape') {
      // Keep Escape from also closing the surrounding dialog.
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close();
    }
  });
  return wrap;
}

export function loading(text = 'Loading…') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
}

export function emptyState(title, ...children) {
  return h('div', { class: 'empty' }, h('h3', {}, title), ...children);
}

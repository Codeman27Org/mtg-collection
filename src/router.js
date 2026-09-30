import { h } from './dom.js';
import { emit } from './bus.js';

const routes = [];
let guard = null;
let cleanup = null;
let token = 0;

export function route(pattern, view, { isPublic = false } = {}) {
  routes.push({ pattern, view, isPublic });
}

export function setGuard(fn) {
  guard = fn;
}

export function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(qs ?? '') };
}

export function navigate(path) {
  if (location.hash.slice(1) === path) render();
  else location.hash = path;
}

/** Only same-app paths are allowed as ?next= targets. */
export function nextPath(query) {
  const next = query?.get('next') ?? '/';
  return /^\/(?!\/)[\w\-/?=&%.]*$/.test(next) ? next : '/';
}

let outlet;
export function mount(el) {
  outlet = el;
  window.addEventListener('hashchange', render);
  render();
}

export async function render() {
  const mine = ++token;
  const { path, query } = parseHash();
  let match = null;
  let params = [];
  for (const r of routes) {
    const m = path.match(r.pattern);
    if (m) {
      match = r;
      params = m.slice(1).map(decodeURIComponent);
      break;
    }
  }
  if (!match) return navigate('/');
  const redirect = await guard?.(match, path);
  if (mine !== token) return;
  if (redirect && redirect !== path) return navigate(redirect);

  cleanup?.();
  cleanup = null;
  const container = h('div', { class: 'view' });
  outlet.replaceChildren(container);
  window.scrollTo(0, 0);
  emit('route', path);
  try {
    const done = await match.view(container, { params, query });
    if (mine !== token) done?.();
    else cleanup = done ?? null;
  } catch (err) {
    console.error(err);
    if (mine === token) container.replaceChildren(h('div', { class: 'banner banner-error' }, `Something went wrong: ${err.message}`));
  }
}

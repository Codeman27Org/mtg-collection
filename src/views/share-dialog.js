import { h } from '../dom.js';
import * as shares from '../shares.js';
import * as locations from '../locations.js';
import { describeFilter as describeWith } from '../collection-filter.js';
import { UNSORTED, UNSORTED_TOKEN } from '../location-logic.js';
import { modal, action, toast, qrImage, confirmDialog } from '../components.js';
import { copyText } from '../util.js';

const daysLeft = (s) => Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 86400000));
let describeFilter = describeWith;

async function loadDescriber() {
  const lookup = await locations.lookup();
  describeFilter = (f) => describeWith(f, { locationName: (token) => lookup(token === UNSORTED_TOKEN ? UNSORTED : token).name });
}

async function shareCard(share, rerender) {
  const url = await shares.link(share);
  const input = h('input', { type: 'text', readonly: true, value: url, class: 'grow', 'aria-label': 'Share link', onfocus: (e) => e.target.select() });
  return h(
    'div',
    { class: 'share-card stack' },
    h('strong', {}, share.title),
    share.type === 'collection' ? h('span', { class: 'muted small' }, describeFilter(share.filter)) : null,
    h('div', { class: 'row' }, input, h('button', { class: 'btn btn-primary', type: 'button', onclick: action(async () => { await copyText(url); toast('Link copied'); }) }, 'Copy')),
    h('p', { class: 'muted small' }, `Expires in ${daysLeft(share)} days. Anyone with this link can view this. It updates when you make changes.`),
    await qrImage(url, 'QR code for the share link'),
    h(
      'div',
      { class: 'row wrap' },
      h('button', { class: 'btn', type: 'button', onclick: action(async () => { await shares.renew(share.id); toast('New link created; the old one stopped working'); rerender(); }) }, 'New link'),
      h(
        'button',
        {
          class: 'btn btn-danger',
          type: 'button',
          onclick: action(async () => {
            if (!(await confirmDialog('Stop sharing? People with the link will see “no longer active”. Anyone who already saved it keeps the old snapshot.', { confirmLabel: 'Stop sharing', danger: true }))) return;
            await shares.stop(share.id);
            toast('Sharing stopped');
            rerender();
          }),
        },
        'Stop sharing',
      ),
    ),
  );
}

/** type: 'deck' | 'collection'. For collections, filter is the current viewer filter. */
export async function openShareDialog({ type, targetId = null, title, filter = null }) {
  await loadDescriber();
  const dlg = modal({ title: type === 'deck' ? 'Share deck' : 'Share collection', content: [] });
  async function render() {
    const active = (await shares.list()).filter((s) => shares.isActive(s) && s.type === type && (type === 'collection' || s.targetId === targetId));
    const intro = h('p', {}, 'Creates a secret link. Relays can’t read what you share, and viewers don’t need an account. Links expire after 30 days.');
    const createBtn = h(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        onclick: action(async () => {
          const f = type === 'collection' ? structuredClone(filter) : null;
          const shareTitle = type === 'collection' ? (describeFilter(f) === 'whole collection' ? title : `${title}: ${describeFilter(f)}`) : title;
          await shares.create({ type, targetId, filter: f, title: shareTitle });
          render();
        }),
      },
      type === 'collection' ? `Create link for: ${describeFilter(filter)}` : 'Create link',
    );
    const cards = await Promise.all(active.map((s) => shareCard(s, render)));
    dlg.setBody(h('div', { class: 'stack' }, intro, ...cards, type === 'collection' || !active.length ? createBtn : null));
  }
  await render();
}

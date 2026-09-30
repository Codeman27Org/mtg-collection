import { h } from '../dom.js';
import * as collection from '../collection.js';
import * as locations from '../locations.js';
import { modal, dropdown, field, action, toast } from '../components.js';

const NEW = '__new__';

/**
 * Location dropdown with a "+ New location…" choice that reveals a name field.
 * value() resolves to a location id, creating the new location if needed.
 */
export async function locationPicker(initial = '', { exclude, label = 'Location', onChange, includeDecks = true } = {}) {
  const opts = (await locations.all())
    .filter((l) => l.id !== exclude && (includeDecks || l.kind !== 'deck'))
    .map((l) => [l.id, l.kind === 'deck' ? `Deck: ${l.name}` : l.name]);
  opts.push([NEW, '+ New location…']);
  let current = opts.some(([id]) => id === initial) ? initial : opts[0][0];
  const nameInput = h('input', { type: 'text', maxlength: 100, placeholder: 'e.g. Red binder', 'aria-label': 'New location name', hidden: current !== NEW });
  const menu = dropdown(opts, current, (v) => {
    current = v;
    nameInput.hidden = v !== NEW;
    if (v === NEW) nameInput.focus();
    else onChange?.(v);
  }, { label });
  return {
    el: h('div', { class: 'row wrap location-picker' }, menu, nameInput),
    async value() {
      if (current !== NEW) return current;
      const rec = await locations.create(nameInput.value);
      current = rec.id;
      return rec.id;
    },
  };
}

/** Move some copies of one stack. */
export async function openMoveDialog(entry, card, { onDone } = {}) {
  const lookup = await locations.lookup();
  const qty = h('input', { type: 'number', min: 1, max: entry.qty, value: entry.qty, 'aria-label': 'How many' });
  const picker = await locationPicker(undefined, { exclude: entry.location ?? '', label: 'Move to' });
  const dlg = modal({
    title: `Move ${card.name}`,
    content: h(
      'form',
      {
        class: 'stack',
        onsubmit: action(async (e) => {
          e.preventDefault();
          const n = Math.max(1, Math.min(entry.qty, parseInt(qty.value, 10) || 1));
          const to = await picker.value();
          await collection.move([{ entry, qty: n, to }]);
          toast(`Moved ${n} to ${(await locations.lookup())(to).name}`);
          dlg.dismiss();
          onDone?.();
        }),
      },
      h('p', { class: 'muted' }, `From ${lookup(entry.location).name}: ${entry.qty} ${entry.qty === 1 ? 'copy' : 'copies'} (${card.set.toUpperCase()}${entry.finish === 'nonfoil' ? '' : `, ${entry.finish}`}${entry.condition === 'NM' ? '' : `, ${entry.condition}`}).`),
      entry.qty > 1 ? field('How many', qty) : null,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'To'), picker.el),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Move'),
    ),
  });
}

/** Move every copy in a list of stacks (e.g. the filtered collection) to one location. */
export async function openBulkMoveDialog(entries, { onDone } = {}) {
  const count = entries.reduce((n, e) => n + e.qty, 0);
  const picker = await locationPicker(undefined, { label: 'Move to' });
  const dlg = modal({
    title: 'Move cards',
    content: h(
      'form',
      {
        class: 'stack',
        onsubmit: action(async (e) => {
          e.preventDefault();
          const to = await picker.value();
          const moved = await collection.move(entries.map((x) => ({ entry: x, qty: x.qty, to })));
          const name = (await locations.lookup())(to).name;
          toast(`Moved ${moved.toLocaleString()} cards to ${name}`);
          dlg.dismiss();
          onDone?.();
        }),
      },
      h('p', {}, `Move all ${count.toLocaleString()} cards shown (${entries.length.toLocaleString()} stacks) to:`),
      picker.el,
      h('p', { class: 'muted small' }, 'Cards already there stay put. Cards moved into a deck remember where they came from.'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, `Move ${count.toLocaleString()} cards`),
    ),
  });
}

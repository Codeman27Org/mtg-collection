import { h } from '../dom.js';
import * as account from '../account.js';
import * as decks from '../decks.js';
import * as collection from '../collection.js';
import { navigate } from '../router.js';
import { field, action, lockedBanner, toast, dropdown } from '../components.js';
import { readDeckFile, readDeckText, importIntoDeck, importSummary, COLLECTION_MODES } from '../deck-import.js';
import { FORMATS, FORMAT_LABELS } from '../constants.js';

/** Radio group for how an imported deck list touches the collection. */
export function collectionModeField(initial = 'none') {
  let mode = initial;
  const el = h(
    'fieldset',
    { class: 'stack' },
    h('legend', {}, 'These cards and your collection'),
    Object.entries(COLLECTION_MODES).map(([value, label]) =>
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'collection-mode', value, checked: value === mode, onchange: () => (mode = value) }), ` ${label}`),
    ),
    h('p', { class: 'muted small' }, 'Decks always link to your collection by card, so nothing is counted twice. “Add only the cards I don’t have” also accounts for copies already used in your other decks.'),
  );
  return { el, value: () => mode };
}

export default async function newDeckView(root) {
  root.append(h('h1', {}, 'New deck'));
  if (!account.canEdit()) {
    root.append(lockedBanner());
    return;
  }
  const modeField = collectionModeField();
  const hasCollection = (await collection.entries()).length > 0;
  let start = hasCollection ? 'collection' : 'scryfall';
  const name = h('input', { type: 'text', maxlength: 100, placeholder: 'e.g. Odric Soldiers' });
  let formatValue = FORMATS[0];
  const format = dropdown(FORMATS.map((f) => [f, FORMAT_LABELS[f]]), formatValue, (v) => (formatValue = v), { label: 'Format' });
  const list = h('textarea', { rows: 12, placeholder: '1 Sol Ring\n1 Command Tower\n\nCommander\n1 Krenko, Mob Boss' });
  const file = h('input', {
    type: 'file',
    accept: '.txt,.csv,.dek',
    onchange: () => {
      if (file.files[0] && !name.value.trim()) name.value = file.files[0].name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    },
  });
  const status = h('p', { class: 'muted small', role: 'status' });
  const importBox = h(
    'div',
    { class: 'stack', hidden: start !== 'import' },
    modeField.el,
    field('Paste a list', list, 'MTGA, Moxfield, Archidekt, and TappedOut text all work.'),
    field('…or upload a file', file, 'A .csv from most deck sites, a .txt list, or an MTGO .dek. The deck name defaults to the file name.'),
    status,
  );
  const startOptions = [
    ['collection', 'Pick cards from my collection', hasCollection ? 'Search what you own and add it card by card.' : 'Your collection is empty. Import it first to use this.'],
    ['scryfall', 'Search all cards', 'Any card; the ones you own are marked.'],
    ['import', 'Import a list', 'Paste or upload a deck list.'],
  ];
  const startField = h(
    'fieldset',
    { class: 'stack' },
    h('legend', {}, 'How do you want to start?'),
    startOptions.map(([value, label, hint]) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'radio',
          name: 'deck-start',
          value,
          checked: value === start,
          disabled: value === 'collection' && !hasCollection,
          onchange: () => {
            start = value;
            importBox.hidden = start !== 'import';
          },
        }),
        ` ${label} `,
        h('span', { class: 'muted small' }, hint),
      ),
    ),
    h('p', { class: 'muted small' }, 'You can switch between your collection and all cards at any time while building.'),
  );

  root.append(
    h(
      'form',
      {
        class: 'panel stack narrow',
        onsubmit: action(async (e) => {
          e.preventDefault();
          const create = () => decks.create({ name: name.value || 'Untitled deck', format: formatValue });
          if (start !== 'import') return navigate(`/decks/${(await create()).id}?source=${start}`);
          let parsed = { rows: [], errors: [] };
          if (file.files[0]) parsed = await readDeckFile(file.files[0]);
          else if (list.value.trim()) parsed = readDeckText(list.value);
          const deck = await create();
          if (parsed.rows.length) {
            const mode = modeField.value();
            const result = await importIntoDeck(deck.id, parsed.rows, {
              format: formatValue,
              mode,
              onProgress: (text, done, total) => (status.textContent = `${text}… ${done}/${total}`),
            });
            toast(importSummary(result, mode), result.unresolved.length ? 'error' : 'info');
          }
          navigate(`/decks/${deck.id}`);
        }),
      },
      startField,
      field('Deck name', name),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Format'), format),
      importBox,
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create deck'),
    ),
  );
  name.focus();
}

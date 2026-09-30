import { h, frag } from '../dom.js';
import * as account from '../account.js';
import * as collection from '../collection.js';
import * as scryfall from '../scryfall.js';
import { parseCardCsv, MAX_FILE_BYTES } from '../csv-import.js';
import { resolveRows } from '../import-resolve.js';
import { cardPrice } from '../card-utils.js';
import { navigate } from '../router.js';
import { lockedBanner, action, toast } from '../components.js';
import * as locations from '../locations.js';
import { locationPicker } from './location-ui.js';
import { usd } from '../util.js';

function progressBar() {
  const bar = h('progress', { max: 1, value: 0 });
  const label = h('span', { class: 'muted small' });
  return {
    el: h('div', { class: 'stack' }, label, bar),
    set(text, done, total) {
      label.textContent = `${text}… ${done}/${total}`;
      bar.max = total || 1;
      bar.value = done;
    },
  };
}

const FIELD_LABELS = {
  scryfallId: 'Scryfall ID',
  qty: 'quantity',
  name: 'name',
  setCode: 'set code',
  setName: 'set name',
  set: 'set',
  cn: 'collector number',
  finish: 'foil/finish',
  condition: 'condition',
  language: 'language',
  location: 'location',
};

export default async function importView(root) {
  root.append(h('h1', {}, 'Import collection'));
  if (!account.canEdit()) {
    root.append(lockedBanner());
    return;
  }
  const stage = h('div', { class: 'stack' });
  let defaultLocation = '';

  async function handleFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return toast('File is larger than 5 MB.', 'error');
    let parsed;
    try {
      parsed = parseCardCsv(await file.text());
    } catch (err) {
      return toast(err.message, 'error');
    }
    const detected = Object.entries(parsed.columns)
      .filter(([f]) => FIELD_LABELS[f])
      .map(([f, header]) => `${FIELD_LABELS[f]} = “${header}”`)
      .join(', ');
    const progress = progressBar();
    stage.replaceChildren(
      h('p', {}, `${file.name}: ${parsed.rows.length} stacks · ${parsed.totalCards} cards${parsed.skipped ? ` · ${parsed.skipped} rows skipped` : ''}`),
      h('p', { class: 'muted small' }, `Detected columns: ${detected}${parsed.columns.qty ? '' : ' (no quantity column, so each row counts as 1 card)'}`),
      progress.el,
    );
    try {
      await resolveRows(parsed.rows, (text, done, total) => progress.set(text, done, total));
    } catch (err) {
      return stage.replaceChildren(h('div', { class: 'banner banner-error' }, `Lookup failed: ${err.message}`));
    }
    renderReport(parsed);
  }

  async function renderReport(parsed) {
    const { rows } = parsed;
    const matched = rows.filter((r) => r.card);
    const review = rows.filter((r) => r.review);
    const unresolved = rows.filter((r) => !r.card);
    const value = matched.reduce((n, r) => n + (cardPrice(r.card, r.finish) ?? 0) * r.qty, 0);
    const hasCollection = (await collection.entries()).length > 0;
    // With an existing collection, make the user choose: replace wipes cards missing from a partial file.
    let mode = hasCollection ? null : 'replace';
    const fileLocations = [...new Set(matched.map((r) => r.locationName).filter(Boolean))];
    const known = new Set((await locations.list()).map((l) => l.name.toLowerCase()));
    const newLocations = fileLocations.filter((n) => !known.has(n.toLowerCase()));
    const picker = await locationPicker(defaultLocation, { label: 'Location for these cards', onChange: (v) => (defaultLocation = v) });
    const locationBox = h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label' }, fileLocations.length ? 'Cards without a location in the file go to' : 'Put these cards in'),
      picker.el,
      fileLocations.length
        ? h(
            'span',
            { class: 'field-hint' },
            `The file’s location column puts cards in ${fileLocations.length} ${fileLocations.length === 1 ? 'location' : 'locations'}: ${fileLocations.join(', ')}.`,
            newLocations.length ? ` New: ${newLocations.join(', ')}.` : '',
          )
        : null,
    );

    const unresolvedList = unresolved.length
      ? h(
          'div',
          { class: 'stack' },
          h('h3', {}, `Unresolved (${unresolved.length})`),
          h('p', { class: 'muted small' }, 'Fix these by typing the right card name, or leave them out.'),
          ...unresolved.map((r) => {
            const input = h('input', { type: 'text', value: r.name, 'aria-label': `Card name for ${r.name}` });
            return h(
              'div',
              { class: 'row' },
              h('span', { class: 'grow' }, `${r.qty}× ${r.name || r.scryfallId}${r.setName || r.setCode ? ` (${r.setName || r.setCode}${r.cn ? ` #${r.cn}` : ''})` : ''}`),
              input,
              h(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  onclick: action(async () => {
                    const card = await scryfall.named(input.value);
                    if (!card) throw new Error(`No card found for “${input.value}”.`);
                    r.card = card;
                    r.review = true;
                    renderReport(parsed);
                  }),
                },
                'Find',
              ),
            );
          }),
        )
      : null;

    const reviewList = review.length
      ? h(
          'details',
          {},
          h('summary', {}, `${review.length} matched by name only (printing may differ)`),
          h('ul', {}, review.map((r) => h('li', {}, `${r.qty}× ${r.name} → ${r.card.set_name} #${r.card.collector_number}`))),
        )
      : null;

    const importBtn = h(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        disabled: !mode,
        onclick: action(async () => {
          const fallback = (defaultLocation = await picker.value());
          const ids = new Map();
          for (const name of fileLocations) ids.set(name, (await locations.findOrCreate(name)).id);
          const changed = await collection.importRows(
            matched.map((r) => ({
              scryfallId: r.card.id,
              finish: r.finish,
              condition: r.condition,
              language: r.language,
              qty: r.qty,
              location: r.locationName ? ids.get(r.locationName) : fallback,
            })),
            mode,
          );
          toast(`Imported. ${changed} stacks changed.`);
          navigate('/collection');
        }),
      },
      `Import ${matched.length} stacks`,
    );
    const pick = (value) => () => {
      mode = value;
      importBtn.disabled = false;
    };

    stage.replaceChildren(frag(
      h(
        'div',
        { class: 'stats' },
        h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(matched.reduce((n, r) => n + r.qty, 0))), h('div', { class: 'stat-label' }, 'Cards matched')),
        h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(unresolved.length)), h('div', { class: 'stat-label' }, 'Unresolved')),
        h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, usd(value)), h('div', { class: 'stat-label' }, 'Current value')),
      ),
      reviewList,
      unresolvedList,
      locationBox,
      hasCollection
        ? h(
            'fieldset',
            { class: 'stack' },
            h('legend', {}, 'You already have a collection. How should this file be applied?'),
            h('label', { class: 'check' }, h('input', { type: 'radio', name: 'mode', onchange: pick('replace') }), ' Replace: this file is everything in its location(s); cards there that aren’t in the file are removed. Other locations aren’t touched.'),
            h('label', { class: 'check' }, h('input', { type: 'radio', name: 'mode', onchange: pick('merge') }), ' Add: these are new cards (quantities are added to what’s there)'),
          )
        : null,
      importBtn,
    ));
  }

  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', onchange: (e) => handleFile(e.target.files[0]) });
  const drop = h(
    'label',
    {
      class: 'dropzone',
      ondragover: (e) => {
        e.preventDefault();
        drop.classList.add('over');
      },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        handleFile(e.dataTransfer.files[0]);
      },
    },
    h('strong', {}, 'Drop a collection CSV here'),
    h('span', { class: 'muted' }, 'or choose a file'),
    fileInput,
  );
  root.append(
    h(
      'p',
      { class: 'muted' },
      'Any CSV with a card name or Scryfall ID column works, including exports from CardCastle, Moxfield, ManaBox, Archidekt, Deckbox, and TCGplayer. Quantity, set, collector number, foil, condition, and language columns are used when present. A Scryfall ID column gives exact printings.',
    ),
    drop,
    stage,
  );
}

// Dialogs shared by the scanner and its review: pick a name, pick a printing.
import { h } from '../dom.js';
import * as scryfall from '../scryfall.js';
import { modal } from '../components.js';
import { cardImage } from '../card-utils.js';
import { debounce } from '../util.js';
import { printingsOf } from '../scan/identify.js';

const pct = (n) => `${Math.round(n * 100)}%`;

/** A name search box with Scryfall autocomplete. onPick(name). */
function nameSearch(onPick, placeholder = 'Search card names…') {
  const list = h('ul', { class: 'scan-suggest', role: 'listbox' });
  const update = debounce(async () => {
    const names = await scryfall.autocomplete(input.value).catch(() => []);
    list.replaceChildren(
      ...names.slice(0, 8).map((name) => h('li', {}, h('button', { class: 'btn scan-choice', type: 'button', onclick: () => onPick(name) }, name))),
    );
  }, 250);
  const input = h('input', { type: 'search', placeholder, 'aria-label': 'Card name', autocomplete: 'off', oninput: update });
  return { el: h('div', { class: 'stack' }, input, list), input };
}

/**
 * Asks which card this is when the title couldn't be read well.
 * read: { text, matches: [{ name, score }] }; titleImage: optional canvas of what was read. Resolves to a name or null.
 */
export function askName(read, titleImage) {
  return new Promise((resolve) => {
    let result = null;
    const pick = (name) => {
      result = name;
      dlg.dismiss();
    };
    const search = nameSearch(pick);
    if (titleImage) titleImage.className = 'scan-title-crop';
    const dlg = modal({
      title: 'Which card is this?',
      content: h(
        'div',
        { class: 'stack' },
        titleImage ?? null,
        h('p', { class: 'muted small' }, read?.text ? `Read “${read.text}”, which isn’t a clear match.` : 'Couldn’t read the card name.'),
        read?.matches?.length
          ? h(
              'div',
              { class: 'row wrap' },
              read.matches.map((m) => h('button', { class: 'btn scan-choice', type: 'button', onclick: () => pick(m.name) }, m.name, h('span', { class: 'muted small' }, pct(m.score)))),
            )
          : null,
        search.el,
        h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.dismiss() }, 'Skip this card')),
      ),
      onClose: () => resolve(result),
    });
    if (!read?.matches?.length) search.input.focus();
  });
}

const printingLabel = (c) => `${c.set.toUpperCase()} #${c.collector_number}`;

/** A grid of printings to tap. Resolves to a card, or null. suggested is shown first. */
export function askPrinting(printings, { suggested, title = 'Which printing?', note } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const ordered = suggested ? [suggested, ...printings.filter((p) => p.id !== suggested.id)] : printings;
    const dlg = modal({
      title,
      wide: true,
      content: h(
        'div',
        { class: 'stack' },
        note ? h('p', { class: 'muted small' }, note) : null,
        h(
          'div',
          { class: 'scan-printings' },
          ordered.map((p) =>
            h(
              'button',
              {
                class: `scan-printing${p.id === suggested?.id ? ' suggested' : ''}`,
                type: 'button',
                onclick: () => {
                  result = p;
                  dlg.dismiss();
                },
              },
              h('img', { src: cardImage(p, 'small'), alt: '', loading: 'lazy', width: 146, height: 204 }),
              h('span', { class: 'small' }, printingLabel(p)),
              h('span', { class: 'muted small' }, `${p.set_name} (${String(p.released_at ?? '').slice(0, 4)})`),
            ),
          ),
        ),
        h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.dismiss() }, 'Skip this card')),
      ),
      onClose: () => resolve(result),
    });
  });
}

/** Change a scanned card: search a name (or keep the current one), then pick the printing. Resolves to a card or null. */
export function pickCard(current) {
  return new Promise((resolve) => {
    let chosen = null;
    const choose = async (name) => {
      chosen = name;
      dlg.dismiss();
    };
    const search = nameSearch(choose, 'A different card…');
    const dlg = modal({
      title: 'Change card',
      content: h(
        'div',
        { class: 'stack' },
        current ? h('button', { class: 'btn', type: 'button', onclick: () => choose(current.name) }, `Pick another printing of ${current.name}`) : null,
        search.el,
      ),
      onClose: async () => {
        if (!chosen) return resolve(null);
        try {
          const printings = await printingsOf(chosen);
          resolve(printings.length === 1 ? printings[0] : await askPrinting(printings, { suggested: current?.name === chosen ? current : null }));
        } catch (err) {
          console.error(err);
          resolve(null);
        }
      },
    });
    search.input.focus();
  });
}

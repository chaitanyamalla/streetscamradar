// ---------------------------------------------------------------------------
// The reference page: levels, alerts, sources.
//
// Most of it is plain markup with data-i18n on it. The four tables are built
// here instead, because each of them is a list the rest of the site already
// knows — the ladder in the database, the badges the database can grant, the
// point weights — and writing them out by hand in HTML would mean a page that
// says one thing while the map does another.
// ---------------------------------------------------------------------------
import { bootPage } from './page.js';
import { t, tOr, plural } from './i18n.js';
import { esc, badgeChip, BADGES } from './ui.js';
import { REPORT_WINDOW_DAYS } from './config.js';
import { contributorLadder, pointWeights } from './data.js';

const $ = (sel) => document.querySelector(sel);

// What the ladder looks like if the database cannot be reached. The page is a
// reference, so it has to say something true rather than nothing at all, and
// these are the seeded values in schema.sql.
const LADDER = [[1, 0], [2, 10], [3, 25], [4, 50], [5, 90],
                [6, 150], [7, 230], [8, 330], [9, 450], [10, 600]];
const WEIGHTS = { report: 5, confirmation: 4, given: 1 };

let ladder = LADDER;
let weights = WEIGHTS;

function paintPoints() {
  const row = (key, n) => `
    <tr><th scope="row">${esc(t(key))}</th>
        <td>${esc(plural('guide.points.n', n))}</td></tr>`;
  $('#points-table').innerHTML = `
    <tbody>
      ${row('guide.points.report', weights.report)}
      ${row('guide.points.received', weights.confirmation)}
      ${row('guide.points.given', weights.given)}
    </tbody>`;
}

function paintLadder() {
  $('#levels-table').innerHTML = `
    <thead><tr>
      <th scope="col">${esc(t('guide.levels.col.level'))}</th>
      <th scope="col">${esc(t('guide.levels.col.points'))}</th>
    </tr></thead>
    <tbody>${ladder.map(([level, points]) => `
      <tr>
        <th scope="row"><span class="lv-n">${esc(t('profile.level.n', { n: level }))}</span>
          ${tOr(`level.${level}`, '') ? `<span class="lv-name">${esc(tOr(`level.${level}`, ''))}</span>` : ''}</th>
        <td>${points}</td>
      </tr>`).join('')}</tbody>`;
}

function paintBadges() {
  $('#badge-guide').innerHTML = BADGES.map(slug => `
    <div class="badge-explain">
      ${badgeChip(slug)}
      <p>${esc(tOr(`badge.${slug}.note`, ''))}</p>
    </div>`).join('');
}

function paintSources() {
  // Each row names what it is, who publishes it, and the one limit that
  // matters for it. The limit is the part people need and the part a logo in a
  // footer never tells them.
  const rows = [
    ['guide.source.reports', 'guide.source.reports.who', 'guide.source.reports.limit'],
    ['guide.source.disasters', 'guide.source.disasters.who', 'guide.source.disasters.limit'],
    ['guide.source.weather', 'guide.source.weather.who', 'guide.source.weather.limit'],
    ['guide.source.advisory', 'guide.source.advisory.who', 'guide.source.advisory.limit'],
    ['guide.source.hospitals', 'guide.source.hospitals.who', 'guide.source.hospitals.limit'],
  ];
  $('#sources-table').innerHTML = `
    <thead><tr>
      <th scope="col">${esc(t('guide.source.col.layer'))}</th>
      <th scope="col">${esc(t('guide.source.col.who'))}</th>
      <th scope="col">${esc(t('guide.source.col.limit'))}</th>
    </tr></thead>
    <tbody>${rows.map(([what, who, limit]) => `
      <tr><th scope="row">${esc(t(what))}</th>
          <td>${esc(t(who))}</td>
          <td>${esc(t(limit))}</td></tr>`).join('')}</tbody>`;

  $('#guide-window').textContent = t('guide.source.window', { days: REPORT_WINDOW_DAYS });
}

function paintAll() {
  paintPoints();
  paintLadder();
  paintBadges();
  paintSources();
}

await bootPage({ onLanguage: paintAll });

// The real ladder and the real weights, if the database answers. It usually
// does and it usually matches; what this catches is the day somebody retunes
// contributor_levels and this page would otherwise go on quoting the numbers
// it shipped with.
try {
  const [live, w] = await Promise.all([contributorLadder(), pointWeights()]);
  if (live?.length) ladder = live;
  if (w) weights = { ...weights, ...w };
  paintAll();
} catch { /* the seeded values stand */ }

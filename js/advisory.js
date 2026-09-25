// ---------------------------------------------------------------------------
// Travel advisories, from the German Federal Foreign Office.
//
// This panel is in German, and only in German — on purpose.
//
// The advisories are written in Berlin, in German, for German citizens
// travelling abroad. Wrapping them in English or Polish chrome would suggest
// they are general advice for anybody, which they are not, and translating
// the ministry's own wording is exactly what their terms forbid. So the
// panel speaks the language of the thing it is describing, and the country
// names are the ministry's own rather than the browser's.
//
// For now everyone sees it, which is a testing decision, not the end state.
// The intended shape is to show it to readers it is actually for — German
// speakers, and travellers heading out of Germany — and to add other
// countries' advisories for everyone else. The seam for that is STRINGS plus
// SOURCE below: a second source means a second table of both, chosen per
// reader, and nothing else here changes.
//
// What this shows, and what it deliberately does not
// --------------------------------------------------
// It shows the STATUS of an advisory — which of four levels applies, the
// official title, when the ministry last changed it — and links to the
// official page for the text. It never reproduces the text itself.
//
// Their terms require the information to be taken complete, kept current, and
// not put in a distorting context, and ask that country text be linked rather
// than copied. A ticker of excerpts fails all of that: a multi-page advisory
// cannot be complete in a strip, and fragments out of context are precisely
// what they warn about. A level is a fact about the advisory rather than a
// piece of it, and the link means the words a reader acts on are always the
// ministry's own, always current.
// ---------------------------------------------------------------------------

import { emergencyFor } from './emergency.js';

/** Where this comes from, said once so the UI never hardcodes it twice. */
export const SOURCE = {
  name: 'Auswärtiges Amt',
  locale: 'de-DE',
  url: 'https://www.auswaertiges-amt.de/de/reiseundsicherheit/reise-und-sicherheitshinweise',
};

// The panel's own words. German, because the advisories are.
//
// Formal "Sie", where js/locales/de.js uses "du". Not an oversight: the rest
// of the site is us talking to a traveller, and this panel is us relaying a
// ministry, which addresses people as "Sie". Matching the source's own register
// is what stops the relay reading as our own chatty advice.
export const STRINGS = {
  kicker: 'Reisehinweise',
  prompt: 'Ort suchen',
  eyebrow: 'Offizielle Reisehinweise',
  title: 'Reise- und Sicherheitshinweise',
  whose: 'Herausgegeben vom Auswärtigen Amt für Reisende aus Deutschland. '
       + 'Wir zeigen den Status und verlinken den amtlichen Text — wir geben ihn '
       + 'weder wieder noch übersetzen wir ihn.',
  level: {
    warning:       'Reisewarnung',
    partial:       'Teilreisewarnung',
    situation:     'Sicherheitshinweis',
    situationPart: 'Sicherheitshinweis für Teile des Landes',
    none:          'Keine Warnung in Kraft',
  },
  explain: {
    warning:       'Das Auswärtige Amt warnt vor Reisen in dieses Land.',
    partial:       'Das Auswärtige Amt warnt vor Reisen in Teile dieses Landes.',
    situation:     'Für dieses Land liegt ein Sicherheitshinweis vor. Das ist keine Reisewarnung.',
    situationPart: 'Für Teile dieses Landes liegt ein Sicherheitshinweis vor. Das ist keine Reisewarnung.',
    none:          'Es liegen nur allgemeine Länderinformationen vor — keine Reisewarnung und kein Sicherheitshinweis.',
  },
  empty: 'Für diesen Ort liegen keine Hinweise vor. Zoomen Sie auf ein Land oder '
       + 'suchen Sie eines, um zu sehen, ob eine Warnung gilt.',
  // Facts, as short key/value pairs. A reader deciding something wants the
  // emergency number and the two dates; the prose that used to sit here said
  // the same thing at ten times the length.
  emergency: 'Notruf',
  changedKey: 'Zuletzt geändert',
  checkedKey: 'Von uns abgerufen',
  checkedRecent: 'vor unter 1 Std.',
  checkedHours: 'vor {n} Std.',
  checkedDays: 'vor {n} Tagen',
  context: '{warn} von {total} Ländern mit Reisewarnung, {partial} mit Teilreisewarnung.',
  readOfficial: 'Amtlichen Hinweis lesen',
  sourceNote: 'Nur auf Deutsch, nur beim Auswärtigen Amt. Vor der Reise immer dort lesen.',
  ariaChip: 'Reisehinweise für {country}: {level}',
  // The service labels for the emergency numbers, in German, so the panel does
  // not mix languages mid-sentence.
  services: {
    'emergency.all': 'Alle Dienste',
    'emergency.or': 'oder',
    'emergency.police': 'Polizei',
    'emergency.fire': 'Feuerwehr',
    'emergency.ambulance': 'Rettungsdienst',
  },
};

/** German service labels for emergencyFor(), so the panel stays one language. */
export const germanServiceLabel = (key) => STRINGS.services[key] ?? key;

const fill = (text, params = {}) =>
  Object.entries(params).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), text);

// Most serious first. The first one set is the one shown: a country under a
// full travel warning is not also "worth a look at the security notice".
const LEVELS = [
  { key: 'warning',                level: 'warning'       },
  { key: 'partial_warning',        level: 'partial'       },
  { key: 'situation_warning',      level: 'situation'     },
  { key: 'situation_part_warning', level: 'situationPart' },
];

/** Which level applies, or 'none' when the ministry publishes only ordinary
 *  country information. 'none' is an answer worth showing, not an absence. */
export function advisoryLevel(row) {
  if (!row) return null;
  for (const { key, level } of LEVELS) {
    if (row[key] === true || row[key] === 'true') return level;
  }
  return 'none';
}

/** How loudly to draw it. Two tiers, not four: a reader scanning a map needs
 *  to know "is this serious" faster than the exact gradation, and the words
 *  carry the gradation. */
export const advisoryTone = (level) =>
  level === 'warning' || level === 'partial' ? 'is-severe'
    : level === 'none' ? 'is-clear' : 'is-notice';

export const levelLabel = (level) => STRINGS.level[level] ?? '';
export const levelExplain = (level) => STRINGS.explain[level] ?? '';

/** The country as the ministry names it, which is already German. Falling back
 *  to the code rather than to the browser's idea of the name, so the panel
 *  never mixes two languages in one sentence. */
export const countryTitle = (row) => row?.country_name || row?.country_code || '';

/**
 * The official page for an advisory.
 *
 * `auswaertiges-amt.de/de/-/{contentId}` is their own short-link form — the
 * same one their site uses internally — so it survives the country page being
 * reorganised, which a hand-built path would not.
 */
export const officialUrl = (contentId) =>
  `https://www.auswaertiges-amt.de/de/-/${encodeURIComponent(contentId)}`;

/** "3. März 2026", or nothing if the source gave no date. */
export function changedOn(row) {
  if (!row?.last_modified) return '';
  const date = new Date(row.last_modified);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(SOURCE.locale,
      { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
  } catch {
    return date.toLocaleDateString();
  }
}

/**
 * How many countries carry each level right now.
 *
 * Context a single country cannot give: "Reisewarnung" means more when you can
 * see it applies to eighteen countries out of two hundred rather than to half
 * the world.
 */
export function advisoryStats(rows) {
  const all = [...(rows?.values?.() ?? rows ?? [])];
  if (!all.length) return null;
  const warn = all.filter(r => r.warning === true || r.warning === 'true').length;
  const partial = all.filter(r => r.partial_warning === true || r.partial_warning === 'true').length;
  return { total: all.length, warn, partial };
}

export const contextLine = (stats) =>
  (stats ? fill(STRINGS.context, stats) : '');

/** How old our copy is. Shown rather than hidden: the refresh is daily, and a
 *  reader deciding something on this deserves to know that without digging. */
export function refreshedAgo(row) {
  if (!row?.refreshed_at) return '';
  const hours = Math.floor((Date.now() - new Date(row.refreshed_at).getTime()) / 3600000);
  if (!Number.isFinite(hours) || hours < 0) return '';
  if (hours < 1) return STRINGS.checkedRecent;
  if (hours < 24) return fill(STRINGS.checkedHours, { n: hours });
  return fill(STRINGS.checkedDays, { n: Math.floor(hours / 24) });
}

/** The country's emergency numbers, labelled in German. Not the ministry's
 *  data — ours — but it is what somebody reading a travel warning wants next. */
export function emergencyLine(countryCode) {
  const info = emergencyFor(countryCode, {
    label: germanServiceLabel,
    name: (_code, fallbackName) => fallbackName,
  });
  if (!info?.numbers?.length) return '';
  return info.numbers.map(n => n.number).join(' · ');
}

/** The chip's screen-reader label. */
export const chipAria = (row, level) =>
  fill(STRINGS.ariaChip, { country: countryTitle(row), level: levelLabel(level) });

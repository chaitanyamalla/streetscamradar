// ---------------------------------------------------------------------------
// Language.
//
// Which language to show is decided in this order:
//
//   1. what you last chose here, kept in this browser
//   2. what your account says, if you are signed in
//   3. what your browser asks for
//   4. English
//
// Point 3 is deliberately the browser's language and not your IP address. An
// Italian standing in Prague wants Italian; geolocating them would hand them
// Czech, confidently and wrongly. navigator.languages is the setting a person
// actually chose, it costs no request, and it tells us nothing about where
// they are.
//
// English is built in; every other language loads one file at a time, on
// demand, so a French reader never downloads Polish. English being present
// from the first line of script means t() can never return a bare key, even
// if something asks for a string before the chosen language has loaded.
// ---------------------------------------------------------------------------

import en from './locales/en.js';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'cs', label: 'Čeština' },
  { code: 'pl', label: 'Polski' },
];

const CODES = LANGUAGES.map(l => l.code);
const STORAGE_KEY = 'ssr.lang';

let current = 'en';
let strings = en;
const fallback = en;        // a missing key shows English, not a key

/** What the browser asks for, first one we actually speak. */
function fromBrowser() {
  const wanted = navigator.languages?.length
    ? navigator.languages
    : [navigator.language || 'en'];
  for (const tag of wanted) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (CODES.includes(base)) return base;
  }
  return null;
}

function stored() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return CODES.includes(saved) ? saved : null;
  } catch {
    return null;            // private window, blocked storage: not worth caring
  }
}

function remember(code) {
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* see above */ }
}

export const currentLanguage = () => current;
export const isSupported = (code) => CODES.includes(code);

/** The language to start in, before we know whether anyone is signed in. */
export const preferredLanguage = () => stored() || fromBrowser() || 'en';

async function load(code) {
  const module = await import(`./locales/${code}.js`);
  return module.default;
}

/**
 * Switch the page to a language. Loads its file, swaps every marked element,
 * and tells the rest of the app to redraw whatever it renders itself.
 */
export async function setLanguage(code, { remember: save = true } = {}) {
  const wanted = CODES.includes(code) ? code : 'en';
  strings = wanted === 'en' ? en : await load(wanted);

  current = wanted;
  if (save) remember(wanted);
  document.documentElement.lang = wanted;
  applyTranslations();
  document.dispatchEvent(new CustomEvent('languagechange', { detail: { code: wanted } }));
  return wanted;
}

/**
 * A string by key, with {placeholders} filled in.
 *
 * A missing key falls back to English and then to the key itself, so a gap in
 * a translation shows a readable English sentence rather than "profile.title".
 */
export function t(key, params) {
  let text = strings[key] ?? fallback[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/**
 * Plural helper for the handful of counts we show. English and the Romance
 * languages need one/other; Czech and Polish have a third form for 2-4, which
 * their own files handle by giving that form its own key. A language without
 * that form simply has no `.few` key, and falls back to `.other`.
 */
export function pluralForm(n) {
  return n === 1 ? 'one' : (n >= 2 && n <= 4 ? 'few' : 'other');
}

const has = (key) => strings[key] !== undefined || fallback[key] !== undefined;

/** A plural string that carries more than the count — {shown}, {total}, … */
export function tn(key, n, params) {
  const wanted = `${key}.${pluralForm(n)}`;
  const chosen = has(wanted) ? wanted : `${key}.${n === 1 ? 'one' : 'other'}`;
  return t(chosen, { n, ...params });
}

export const plural = (key, n) => tn(key, n);

/**
 * A string we may not have, with what to say instead.
 *
 * Scam categories live in the database, so the site can gain one without a
 * deploy. We translate the ones we know by slug and fall back to whatever
 * label the row carries, which beats showing "category.new_thing".
 */
export const tOr = (key, fallbackText) => (has(key) ? t(key) : fallbackText);

/** A date written the way the reader's language writes dates. */
export function formatDate(value, options = { year: 'numeric', month: 'long' }) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(current, options).format(date);
  } catch {
    return date.toLocaleDateString();
  }
}

/** Swap every element carrying a data-i18n hint. */
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  // Some elements need their markup kept (a <br>, an <em>, a link), so those
  // carry the translated HTML instead. The strings are ours, not a visitor's.
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  for (const [attr, name] of [['data-i18n-placeholder', 'placeholder'],
                              ['data-i18n-aria', 'aria-label'],
                              ['data-i18n-title', 'title']]) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      el.setAttribute(name, t(el.getAttribute(attr)));
    }
  }
  const title = document.querySelector('title');
  if (title) title.textContent = t('meta.title');
  const description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute('content', t('meta.description'));
}

/**
 * The country's name in the reader's language, from its ISO code. Browsers
 * carry every translation of every country name already; shipping our own
 * would be 190 names per language, wrong more often, and stale.
 */
export function countryName(code, fallbackName = '') {
  if (!code) return fallbackName;
  try {
    return new Intl.DisplayNames([current], { type: 'region' }).of(code.toUpperCase())
      || fallbackName;
  } catch {
    return fallbackName;
  }
}

/** Fill a <select> with the languages on offer. */
export function renderLanguagePicker(select) {
  select.innerHTML = LANGUAGES
    .map(l => `<option value="${l.code}">${l.label}</option>`)
    .join('');
  select.value = current;
}

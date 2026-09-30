// ---------------------------------------------------------------------------
// Light or dark.
//
// Decided in the same order language is, and for the same reason:
//
//   1. what you last chose here, kept in this browser
//   2. what your system asks for
//   3. light
//
// Point 2 is the OS switch, which most people set once and forget. Following
// it until somebody says otherwise is the whole of "respecting the setting";
// asking on the first visit is asking a question the computer already answered.
//
// The attribute is written by index.html before the first paint, from this
// same storage key, so a reader who chose dark never sees a flash of cream on
// the way to it. Everything after that goes through here.
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'ssr.theme';
const THEMES = ['light', 'dark'];

/** What the system asks for, when it says anything at all. */
const fromSystem = () =>
  (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light');

function stored() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(saved) ? saved : null;
  } catch {
    return null;            // private window, blocked storage: not worth caring
  }
}

function forget() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* see above */ }
}

export const preferredTheme = () => stored() || fromSystem();

/**
 * What was CHOSEN, which is not the same as what is showing.
 *
 * 'system' means nothing is stored and the page is following the device. The
 * header button only ever sets light or dark; the picker in the profile is
 * where you can hand the decision back.
 */
export const themeChoice = () => stored() ?? 'system';
export const currentTheme = () =>
  (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

// The browser chrome above the page — the phone's status bar — is told the
// same thing, or it stays cream over a dark page.
const CHROME = { light: '#101d26', dark: '#081116' };

const listeners = new Set();
/** Called with the new theme after every change, including the first. */
export const onThemeChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function applyTheme(theme, { remember = true } = {}) {
  const next = THEMES.includes(theme) ? theme : 'light';
  document.documentElement.dataset.theme = next;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', CHROME[next]);
  if (remember) {
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* see above */ }
  }
  for (const fn of listeners) fn(next);
  return next;
}

export const toggleTheme = () =>
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');

/** 'system', 'light' or 'dark' — what the picker sets. */
export function chooseTheme(choice) {
  if (choice !== 'system') return applyTheme(choice);
  // Handing the decision back means forgetting ours, not storing the word
  // "system": a stored theme is what stops followSystem from acting, and
  // whatever the device says today it may say otherwise at sunset.
  forget();
  return applyTheme(fromSystem(), { remember: false });
}

/**
 * Follow the system switch until the reader overrules it.
 *
 * Somebody who has never touched our toggle is following their computer, and
 * should keep following it when it changes at sunset. Somebody who HAS chosen
 * has said what they want, and a sunset must not overrule them — so this
 * checks storage each time rather than unsubscribing, which would also have
 * to be undone if they later cleared the choice.
 */
export function followSystem() {
  window.matchMedia?.('(prefers-color-scheme: dark)')
    ?.addEventListener?.('change', (e) => {
      if (!stored()) applyTheme(e.matches ? 'dark' : 'light', { remember: false });
    });
}

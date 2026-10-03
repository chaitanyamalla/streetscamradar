// ---------------------------------------------------------------------------
// The shell every page but the map shares.
//
// index.html is wired by app.js, which is a thousand lines of map. The other
// pages — the guide, the admin panel — want four of the things it does and
// none of the rest: the language picker, the dark-mode button, the year in the
// footer, and the nav link to whichever page you are on marked as current.
//
// So they call this instead of importing app.js, which would pull MapLibre and
// a dozen fetches onto a page that has no map on it.
// ---------------------------------------------------------------------------
import { setLanguage, preferredLanguage, renderLanguagePicker, applyTranslations,
         currentLanguage } from './i18n.js';
import { toggleTheme, currentTheme, onThemeChange } from './theme.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Wire the header. Resolves once the page is in the reader's language, so a
 * caller can draw its own content afterwards and have t() answer properly.
 *
 * `onLanguage` is called after every change as well as the first time, because
 * anything a page builds in JavaScript — a table of levels, a list of members
 * — is not covered by data-i18n and has to be rebuilt by hand.
 */
export async function bootPage({ onLanguage } = {}) {
  // The language the reader already chose, without re-saving it: arriving on a
  // page is not choosing anything.
  await setLanguage(preferredLanguage(), { remember: false });

  const picker = $('#lang-select');
  if (picker) {
    renderLanguagePicker(picker);
    picker.value = currentLanguage();
    picker.addEventListener('change', async (e) => {
      await setLanguage(e.target.value);
    });
  }

  const themeButton = $('#theme-button');
  if (themeButton) {
    themeButton.addEventListener('click', () => toggleTheme());
    themeButton.setAttribute('aria-pressed', String(currentTheme() === 'dark'));
    onThemeChange((theme) =>
      themeButton.setAttribute('aria-pressed', String(theme === 'dark')));
  }

  document.addEventListener('languagechange', () => {
    applyTranslations();
    if (picker) picker.value = currentLanguage();
    onLanguage?.();
  });

  applyTranslations();
  onLanguage?.();
}

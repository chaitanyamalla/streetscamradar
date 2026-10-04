// ---------------------------------------------------------------------------
// StreetScamRadar — app wiring.
//
// The map drives everything: whenever it settles on a new view we ask the
// database what this viewer is allowed to see there, and redraw. What comes
// back differs for members and visitors, but that decision is the database's,
// not this file's.
// ---------------------------------------------------------------------------
import { isConfigured, missingConfig, PLACE_ZOOM, PRECISE_ZOOM, REPORT_WINDOW_DAYS,
         REPORT_MOVE_WINDOW_HOURS, SAFETY_MIN_ZOOM, EMERGENCY_MIN_ZOOM,
         SUGGEST_MIN_CHARS, SUGGEST_DEBOUNCE_MS, REPORT_BOUNDS,
         WEATHER_COUNTRIES } from './js/config.js';
import { getCategories, fetchForBounds, submitReport, withdrawReport,
         mySupports, addSupport, removeSupport, flagReport, fetchSafetyPlaces,
         myReports, myConfirmationCount, myConfirmedReports, editMyReport,
         deleteMyAccount, getProfile, saveDisplayName, saveLocale, fetchAdvisories,
         myStanding, contributorsBoard, saveListed,
         fetchDisasters, fetchWeatherWarnings, fetchBlockedCountries,
         supabase } from './js/data.js';
import { initAuth, onAuthChange, sendMagicLink, signInWithPassword, signUpWithPassword,
         signInWithGoogle, signOut, enabledProviders, changePassword } from './js/auth.js';
import { searchPlaces, suggestPlaces, describePoint, locateMe } from './js/geo.js';
import { emergencyFor } from './js/emergency.js';
import { preferredTheme, currentTheme, applyTheme, toggleTheme, chooseTheme,
         themeChoice, onThemeChange, followSystem } from './js/theme.js';
import { createMap, addLayers, setMapTheme, setReports, setDensity, boundsOf, flyToPlace,
         registerCategoryIcons, registerSafetyIcons, setSafetyPlaces, setSafetyVisible,
         setHazards, setDisasters, setWeather, startPulse, maplibregl } from './js/map.js';
import { quakesIn, inBounds, quakeTone, hazardLabel, isLive, hasEnded,
         isUpcoming } from './js/hazards.js';
import { hazardSignSVG } from './js/hazard-signs.js';
import { esc, toast, liftToast, renderCategoryFilters, renderReportList, popupHTML, safetyPopupHTML,
         setGateNote, renderProfileReports, renderProfileStats, STAT_TITLE_KEYS,
         setAgeSlider, ageLabel, reportScopeLine, renderStanding, renderBoard,
         categoryLabel, advisoryDialogHTML, quakePopupHTML, disasterPopupHTML,
         weatherDialogHTML, weatherPopupHTML } from './js/ui.js';
import { countryName } from './js/i18n.js';
import { STRINGS as ADVISORY, advisoryLevel, advisoryTone, levelLabel, countryTitle,
         changedOn, chipAria, advisoryStats, copyAgeDays } from './js/advisory.js';
import { t, plural, formatDate, setLanguage, preferredLanguage, currentLanguage,
         isSupported, renderLanguagePicker } from './js/i18n.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  categories: [],
  activeCategories: new Set(),
  lastFetch: { mode: 'summary', reports: [], cells: [], hiddenCount: 0 },
  supported: new Set(),
  picking: false,
  safetyOn: true,
  // How far back the chips above the report list are set, in days. The widest
  // chip to begin with, deliberately: a map that opens already hiding four of
  // its seven days looks like a quiet city rather than a filtered one, and
  // nothing on screen would say which it was. Not remembered between visits
  // for the same reason.
  ageDays: REPORT_WINDOW_DAYS,
  profile: null,      // display_name and home area, read once at sign-in
  safetyPlaces: [],   // what the safety layer last loaded, for the country lookup
  advisories: null,   // country_code -> row, read once per session
  blockedCountries: null,  // where reporting is closed, read once per session
  disasters: null,    // country_code -> rows, mirrored from GDACS every few hours
  weather: null,      // country_code -> rows, from MeteoAlarm and NOAA/NWS
  weatherMarkers: [], // the subset of those that came with a position
  weatherLayers: {},  // kind -> on/off, from the legend behind the chip
  disasterMarkers: [],     // the GDACS events currently drawn
  // Which hazard layers are switched on. One per kind GDACS publishes, keyed
  // by the kind itself so a row and a marker cannot disagree about what it
  // controls, and whatever the reader switches is remembered.
  //
  // Earthquakes used to start off, and the reason was a good one: they came
  // live from USGS at every magnitude, and a ring drawn across a city centre
  // for a quake nobody felt competed with the pins this site exists for. They
  // come from the same GDACS table as everything else now, and only when GDACS
  // graded them Orange or Red or they were magnitude 6 and above — which is
  // news wherever it happens. The reason for the exception went with the
  // change that made it, so the exception goes too.
  layers: { earthquake: true, flood: true, cyclone: true,
            wildfire: true, volcano: true },
  countryWeather: null,    // { code, weather } for the chip and its dialog
  advisoryCountry: null,   // whose advisory the chip is currently showing
  // The country of the place the reader searched for, which outranks anything
  // worked out from the view until they move the map themselves. See
  // rememberSearchedCountry below for why it has to.
  searchedCountry: null,
  pin: null,          // { lat, lng, address, city, countryCode }
  pinPending: null,   // in-flight reverse geocode for that pin
  placeLabel: null,   // null = nowhere chosen yet, so the header says "anywhere"
};

const signedIn = () => Boolean(state.user);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// index.html already wrote data-theme before the first paint; this hands the
// same answer to the map, so it starts on the right basemap rather than
// loading the light one and swapping a moment later.
applyTheme(preferredTheme(), { remember: false });
followSystem();

const map = createMap('city-map', currentTheme());
let layersReady = false;
let openPopup = null;   // only one info window at a time

/**
 * Everything that lives on the map rather than in the style.
 *
 * Called on first load and again after every basemap swap, because setStyle
 * throws all of it away — sources, layers and the images the layers name.
 */
// The ring around the red alerts. A style swap throws its layers away, so the
// loop writing to them is stopped before the new ones are built.
let pulse = null;

function buildMapLayers() {
  pulse?.stop();
  addLayers(map);
  pulse = startPulse(map);
  layersReady = true;
  if (state.categories.length) registerCategoryIcons(map, state.categories);
  registerSafetyIcons(map);
  setSafetyVisible(map, state.safetyOn);
}

map.on('load', () => {
  buildMapLayers();

  // A pin that opens something should look like it.
  for (const layer of ['report-point', 'report-icon', 'clusters', 'safety-icon',
                       'hazard-ring', 'volcano-icon', 'disaster-icon', 'weather-icon']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => {
      map.getCanvas().style.cursor = state.picking ? 'crosshair' : '';
    });
  }

  refresh();
  refreshSafety();
});
map.on('moveend', () => scheduleRefresh());
// Moving the map yourself hands the country back to the view. `originalEvent`
// is what MapLibre sets when a gesture started the move and leaves unset when
// our own flyTo or fitBounds did, which is the difference that matters: the
// flight a search starts must not immediately undo the search. dragstart is
// belt and braces for the commonest gesture of the two.
map.on('movestart', (e) => { if (e?.originalEvent) forgetSearchedCountry(); });
map.on('dragstart', () => forgetSearchedCountry());
map.on('click', onMapClick);

if (!isConfigured()) {
  $('#setup-detail').innerHTML = missingConfig() === 'key'
    ? 'Paste the <b>anon / public</b> key from Supabase → Project Settings → API into <code>js/config.js</code>, and run <code>supabase/schema.sql</code> in the SQL editor.'
    : 'Add your Supabase URL and anon key to <code>js/config.js</code>. Steps are in <code>README.md</code>.';
  $('#setup-banner').hidden = false;
}

init().catch(err => {
  console.error(err);
  toast(t('toast.startupFailed'), { error: true });
});

async function init() {
  // Before anything draws: a page that renders in English and then flips is
  // worse than a page that waits the few milliseconds for its own language.
  await setLanguage(preferredLanguage(), { remember: false });
  wireLanguage();

  await initAuth();
  onAuthChange(async user => {
    state.user = user;
    state.profile = null;
    paintAuthState();
    refresh();
    // One small read, so the avatar can show the name you chose rather than
    // whatever your email happens to start with.
    if (user) {
      try {
        state.profile = await getProfile();
        await adoptAccountLanguage();
        paintAvatar();
      } catch (err) {
        console.error(err);      // the email initial is a fine fallback
      }
    }
  });

  if (isConfigured()) {
    // Where reporting is closed. One small read, and a failure here leaves the
    // map open — the database refuses those reports either way.
    fetchBlockedCountries()
      .then(codes => { state.blockedCountries = codes; })
      .catch(() => { state.blockedCountries = new Set(); });

    try {
      state.categories = await getCategories();
      state.activeCategories = new Set(state.categories.map(c => c.slug));
      if (layersReady) registerCategoryIcons(map, state.categories);
      renderCategoryFilters($('#category-filters'), state.categories, state.activeCategories);
      fillCategorySelect();
    } catch (err) {
      console.error(err);
      $('#category-filters').innerHTML =
        `<p class="muted-note">${esc(t('filters.categoriesFailed'))}</p>`;
    }
  } else {
    $('#category-filters').innerHTML = `<p class="muted-note">${esc(t('filters.connect'))}</p>`;
  }

  wireUI();
  await paintProviders();
}

// ---------------------------------------------------------------------------
// Language
//
// Two pickers, one setting: the one in the header, which anybody can reach
// without an account, and the one in the profile, which is the same choice
// written down against your account. Whichever you use, the other follows.
//
// Everything with a data-i18n attribute is swapped by the engine itself. What
// this file has to do is redraw the parts it renders from JavaScript — the
// report list, the profile, the emergency bar — and put back the two labels
// that hold live values rather than a fixed string.
// ---------------------------------------------------------------------------
function wireLanguage() {
  for (const select of [$('#lang-select'), $('#profile-lang')]) {
    if (!select) continue;
    renderLanguagePicker(select);
    select.addEventListener('change', () => chooseLanguage(select.value));
  }
  document.addEventListener('languagechange', onLanguageChanged);
}

async function chooseLanguage(code) {
  if (code === currentLanguage()) return;
  await setLanguage(code);
  // Signed in, the choice belongs to the account, not to this browser.
  if (signedIn()) {
    const saved = await saveLocale(code);
    if (saved) {
      state.profile = { ...(state.profile ?? {}), locale: code };
      toast(t('toast.languageSaved'));
    }
  }
}

/** What your account says, once we know who you are. The browser's guess was
 *  only ever a stand-in until this arrived. */
async function adoptAccountLanguage() {
  const wanted = state.profile?.locale;
  if (!wanted || !isSupported(wanted) || wanted === currentLanguage()) return;
  await setLanguage(wanted);
}

/**
 * The two ends of the slider, named.
 *
 * Here rather than in a data-i18n attribute because both carry a number that
 * comes from app_settings, which a plain attribute cannot fill — the same
 * reason #when-hint is rewritten below.
 */
function paintAgeEnds() {
  $('#age-end-near').textContent = ageLabel(1, REPORT_WINDOW_DAYS);
  $('#age-end-far').textContent = ageLabel(REPORT_WINDOW_DAYS, REPORT_WINDOW_DAYS);
}

function onLanguageChanged() {
  for (const select of [$('#lang-select'), $('#profile-lang')]) {
    if (select) select.value = currentLanguage();
  }
  // applyTranslations has just written the default into both of these, so the
  // live values go back on top of it.
  if (state.placeLabel) $('#place-label').textContent = state.placeLabel;
  if (signedIn()) $('#profile-email').textContent = state.user?.email ?? t('header.signedIn');
  $('#when-hint').textContent = t('report.whenHint', { days: REPORT_WINDOW_DAYS });
  paintAgeEnds();
  setAgeSlider($('#age-range'), state.ageDays, REPORT_WINDOW_DAYS);
  if (!state.pin) $('#pin-status').textContent = t('report.noPin');

  paintAuthState();
  if (state.categories.length) {
    renderCategoryFilters($('#category-filters'), state.categories, state.activeCategories);
    fillCategorySelect();
  }
  if (layersReady && isConfigured()) {
    draw(); refreshSafety(); refreshHazards();
    // Both of these hold a line in the reader's language — the chip's prompt,
    // the bar's country and service names — so they are repainted too. Neither
    // re-reads anything: the country and the advisory rows are already in hand.
    refreshEmergency(); refreshAdvisory();
  }
  if ($('#profile-dialog').open) paintProfileList();
  // An open popup holds text built in the old language, and there is no way to
  // rebuild it without knowing which feature it came from. Closing it is
  // honest; the pin is still there to tap again.
  openPopup?.remove();
  openPopup = null;
}

/** Only show the Google button if the provider is actually switched on. */
async function paintProviders() {
  const { google } = await enabledProviders();
  $('#google-signin').hidden = !google;
}

function paintAuthState() {
  const btn = $('#auth-button');
  btn.textContent = t(signedIn() ? 'header.signOut' : 'header.signIn');
  btn.setAttribute('title', signedIn()
    ? state.user.email ?? t('header.signedIn')
    : t('header.signIn.title'));
  paintAvatar();
}

/**
 * The header's way into your account: one letter, not two words.
 *
 * Your display name first, because it is what you chose to be called; the
 * email otherwise, since everyone has one. The full identity stays in the
 * title and the aria-label, so the button is still readable to a screen
 * reader and on hover.
 */
function paintAvatar() {
  const button = $('#profile-button');
  button.hidden = !signedIn();
  if (!signedIn()) return;

  const name = (state.profile?.display_name || '').trim();
  const email = state.user?.email ?? '';
  const initial = (name || email).trim().charAt(0);
  $('#profile-initial').textContent = initial || '\u2022';
  const label = name || email || t('header.signedIn');
  button.title = t('header.profile.of', { who: label });
  button.setAttribute('aria-label', t('header.profile.aria', { who: label }));
}

// ---------------------------------------------------------------------------
// Dialogs and the back button
//
// A modal dialog is a place you went, so the phone's back button should bring
// you out of it. Without this, back leaves the site entirely — which on a
// phone is the single easiest way to lose what you were typing.
// ---------------------------------------------------------------------------
// What is open is a function of where you are in history, and popstate's job
// is to make the page match. Anything that closes a dialog as part of going
// somewhere else closes it quietly — otherwise the close handler below would
// treat it as the user going back and pop an entry we are relying on.
//
// Counted, not flagged, and this is the whole subtlety of this section: a
// dialog's `close` event is QUEUED, not dispatched where close() was called.
// A boolean set and cleared around the call is always back to false by the
// time the event arrives, so the flag suppressed nothing — it only looked
// like it did, because the event usually arrived before anything else could
// go wrong. A count per dialog survives the wait.
const quietCloses = new WeakMap();

function closeQuietly(dialog) {
  if (!dialog?.open) return;
  quietCloses.set(dialog, (quietCloses.get(dialog) ?? 0) + 1);
  dialog.close();
}

/** Was this close event one of ours? Asked once per event, and spent. */
function wasQuiet(dialog) {
  const owed = quietCloses.get(dialog) ?? 0;
  if (!owed) return false;
  quietCloses.set(dialog, owed - 1);
  return true;
}

function openDialog(selector) {
  const dialog = $(selector);
  if (!dialog || dialog.open) return;
  document.querySelectorAll('dialog[open]').forEach(closeQuietly);
  dialog.showModal();
  // A dialog joins the top layer above anything already in it, so a message
  // put up a moment ago would now be behind this window. Lift it back.
  liftToast();
  // One entry per window, not one per opening. A close event that arrived late
  // leaves the entry it was going to pop still standing, and pushing a second
  // one for the same window means closing it lands on the first — which says
  // this window should be open, so popstate dutifully reopens it. A window you
  // just shut reappearing is worse than a back button that skips a step.
  if (history.state?.dialog !== selector) history.pushState({ dialog: selector }, '');
}

/** Leave the dialog for the page behind it, keeping the dialog in history so
 *  back returns to it rather than to whatever you were browsing before. */
function leaveDialogForPage(selector) {
  history.pushState({ dialog: null }, '');
  closeQuietly($(selector));
}

// The X, Escape, or a button that closes: all of them mean "back".
//
// Two things have to be true before a step back is owed, and both are about
// the queue this event came off rather than about the dialog.
//
//   OURS ALREADY     popstate and openDialog close windows themselves. Those
//                    are not somebody leaving, and a step back for one of them
//                    pops an entry the page is relying on.
//   STILL CLOSED     the window may have been REOPENED in the time the event
//                    spent queued, and then there is nothing to go back from.
//                    This is the one that was wrong, and it cost the report
//                    window: picking a place closes it and a refused pin
//                    reopens it in the same turn, so the close event landed on
//                    an open window, stepped back anyway, and popstate shut the
//                    window a person was looking at. Visible only once the ring
//                    around the red alerts was drawing every frame, which is
//                    enough to reorder the two — the fault was always there.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => {
    if (wasQuiet(dialog)) return;
    if (dialog.open) return;
    if (history.state?.dialog === `#${dialog.id}`) history.back();
  });
}

window.addEventListener('popstate', () => {
  const wanted = history.state?.dialog ?? null;
  for (const open of document.querySelectorAll('dialog[open]')) {
    if (`#${open.id}` !== wanted) closeQuietly(open);
  }
  const dialog = wanted && $(wanted);
  // Reopened, not rebuilt: whichever set of reports you were looking at is
  // still on screen, which is what coming back should mean.
  if (dialog && !dialog.open) dialog.showModal();
});

// ---------------------------------------------------------------------------
// Profile
//
// Your own corner of the site: what you have filed, what it collected, and the
// two settings that are actually yours to change. It reads reports_feed the
// same way the map does — which is why reports that have aged off the map are
// still here, since that view keeps your own rows visible to you whatever
// their age.
// ---------------------------------------------------------------------------
const profile = { reports: [], confirmed: null, stats: null, filter: 'filed',
                  standing: null, board: null };

async function openProfile() {
  $('#profile-email').textContent = state.user?.email ?? t('header.signedIn');
  $('#profile-reports').innerHTML = `<p class="empty-note">${esc(t('filters.loading'))}</p>`;
  $('#profile-stats').innerHTML = '';
  profile.filter = 'filed';
  profile.board = null;
  openDialog('#profile-dialog');
  await loadProfile();
}

async function loadProfile() {
  try {
    // myStanding is in the same breath but cannot fail the rest: it returns
    // null on a database without the levels tables rather than throwing, so an
    // older schema costs the level block and nothing else.
    const [reports, given, saved, standing] = await Promise.all([
      myReports(), myConfirmationCount(), getProfile(), myStanding(),
    ]);
    profile.standing = standing;
    renderStanding($('#profile-standing'), standing);
    $('#profile-listed').checked = Boolean(standing?.listed ?? saved?.listed);
    profile.reports = reports;
    profile.confirmed = null;              // fetched only if you ask for it

    const cutoff = Date.now() - REPORT_WINDOW_DAYS * 86400000;
    profile.stats = {
      filed: reports.length,
      live: reports.filter(r => new Date(r.happened_at).getTime() > cutoff).length,
      received: reports.reduce((sum, r) => sum + (Number(r.support_count) || 0), 0),
      given,
    };
    paintProfileList();

    state.profile = saved;
    paintAvatar();
    $('#profile-name').value = saved?.display_name ?? '';
    const since = saved?.created_at ?? state.user?.created_at;
    $('#profile-since').textContent = since
      ? t('profile.memberSince', { when: formatDate(since) })
      : '';
  } catch (err) {
    console.error(err);
    $('#profile-reports').innerHTML = `<p class="empty-note">${esc(t('profile.failed'))}</p>`;
  }
}

async function loadBoard(force = false) {
  if (profile.board && !force) return;
  const host = $('#contributors-board');
  if (!profile.board) host.innerHTML = `<p class="empty-note">${esc(t('filters.loading'))}</p>`;
  profile.board = await contributorsBoard(20);
  renderBoard(host, profile.board);
}

/** Which reports the current tile is counting. */
function reportsForFilter() {
  const cutoff = Date.now() - REPORT_WINDOW_DAYS * 86400000;
  if (profile.filter === 'live') {
    return profile.reports.filter(r => new Date(r.happened_at).getTime() > cutoff);
  }
  if (profile.filter === 'received') {
    return profile.reports.filter(r => (Number(r.support_count) || 0) > 0);
  }
  if (profile.filter === 'given') return profile.confirmed ?? [];
  return profile.reports;
}

function paintProfileList() {
  if (!profile.stats) return;
  renderProfileStats($('#profile-stats'), profile.stats, profile.filter);
  $('#reports-heading').textContent = t(STAT_TITLE_KEYS[profile.filter]);
  $('#stat-back').hidden = profile.filter === 'filed';
  renderProfileReports($('#profile-reports'), reportsForFilter(),
    state.categories, REPORT_WINDOW_DAYS,
    { mine: profile.filter !== 'given', moveWindowHours: REPORT_MOVE_WINDOW_HOURS });
}

async function showStat(key) {
  profile.filter = key;
  if (key === 'given' && profile.confirmed === null) {
    $('#profile-reports').innerHTML = `<p class="empty-note">${esc(t('filters.loading'))}</p>`;
    try {
      profile.confirmed = await myConfirmedReports();
    } catch (err) {
      console.error(err);
      profile.confirmed = [];
    }
  }
  paintProfileList();
}

/** Close the profile and put the report in front of you on the map. */
function showReportOnMap(id) {
  const report = [...profile.reports, ...(profile.confirmed ?? [])]
    .find(r => String(r.id) === String(id));
  if (!report) return;
  leaveDialogForPage('#profile-dialog');
  map.flyTo({ center: [report.lng, report.lat], zoom: Math.max(map.getZoom(), 15), duration: 700 });
  showPopup([report.lng, report.lat], popupHTML(report, state.categories));
}

// ---------------------------------------------------------------------------
// Fetch + draw
// ---------------------------------------------------------------------------
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refresh(); refreshSafety(); }, 350);   // wait for the pan to settle
}

let inFlight = 0;
async function refresh() {
  if (!layersReady || !isConfigured()) return;
  const ticket = ++inFlight;
  try {
    const result = await fetchForBounds(boundsOf(map),
      { signedIn: signedIn(), ageDays: state.ageDays });
    if (ticket !== inFlight) return;         // a newer request already won
    state.lastFetch = result;

    if (signedIn() && result.reports.length) {
      state.supported = await mySupports(result.reports.map(r => r.id));
      if (ticket !== inFlight) return;
    }
    draw();
  } catch (err) {
    console.error(err);
    toast(err.message || t('toast.loadFailed'), { error: true });
  }
}

const passesCategory = (r) =>
  state.activeCategories.size === 0 || state.activeCategories.has(r.category);

/**
 * Inside the window the chips are set to.
 *
 * Applied here as well as in the fetch, and both are needed. The fetch is what
 * narrows the counts a signed-out visitor sees, which only the database can
 * do; this is what makes a chip respond the instant it is pressed, on rows the
 * page already has, instead of after a round trip.
 *
 * Counted back from now rather than from midnight. "Today" at nine in the
 * morning would otherwise mean nine hours, and a scam at eleven last night
 * would be filed under a day the reader cannot see any more.
 */
const passesAge = (r) => {
  if (state.ageDays >= REPORT_WINDOW_DAYS) return true;
  const when = new Date(r.happened_at).getTime();
  return Number.isFinite(when) && when > Date.now() - state.ageDays * 86400000;
};

const passesFilter = (r) => passesCategory(r) && passesAge(r);

// Hospitals are not gated by sign-in or the report window — they are public
// OSM data, the same for everyone, refreshed independently of the report fetch
// above. Police stations were dropped: police come to you when you call the
// number the emergency bar shows, so a map of stations was answering a
// question nobody had.
let safetyInFlight = 0;
async function refreshSafety() {
  if (!layersReady || !isConfigured()) return;
  const status = $('#safety-status');

  // Forget the last view's places before fetching this one's. They also name
  // the country for the emergency numbers, and a stale set will happily name
  // the country you just panned away from.
  state.safetyPlaces = [];

  if (!state.safetyOn) { status.textContent = t('safety.off'); return; }
  if (map.getZoom() < SAFETY_MIN_ZOOM) {
    status.textContent = t('safety.zoomIn');
    status.classList.remove('is-warning');
    return;
  }

  const ticket = ++safetyInFlight;
  try {
    const places = await fetchSafetyPlaces(boundsOf(map));
    if (ticket !== safetyInFlight) return;       // a newer request already won
    state.safetyPlaces = places;
    setSafetyPlaces(map, places);
    status.classList.remove('is-warning');
    status.textContent = places.length
      ? t('safety.count', { n: places.length })
      : t('safety.none');
  } catch (err) {
    if (ticket !== safetyInFlight) return;
    console.error(err);
    status.textContent = t('safety.failed');
    status.classList.add('is-warning');
  }
}

// ---------------------------------------------------------------------------
// Natural hazards
//
// Three layers, one panel, and a hard line: everything here was published by
// an agency whose job it is, and none of it is ours. We add no judgement, no
// severity of our own and no advice — the panel names the source on every row
// and says so in as many words.
//
// They are split by whether the thing HAS a place:
//
//   earthquakes   an epicentre — rings on the map, sized by magnitude, which
//                 is why they are not symbols like the rest. From GDACS with
//                 everything else, and only the ones it grades Orange or Red,
//                 or that reach magnitude 6: the green magnitude-fives a
//                 hundred kilometres down are the ones nobody felt.
//   GDACS events  floods, cyclones, wildfires and volcanoes, each
//                 with a position and a glyph, counted for the view like the
//                 earthquakes. What the position MEANS varies, and the popup
//                 says which: a volcano and a fire are where they are, a
//                 cyclone is where the storm was last placed, and a flood is
//                 the centre of the area affected — a region, not a street.
//                 Better to draw it and say what it is than to leave a flood
//                 off a map about travelling somewhere.
//   weather       a region, from the national met services through MeteoAlarm,
//                 and the only one with no place to draw: a warning covers
//                 counties at a time. So it stays a chip for the country in
//                 view — the same shape of answer as the travel advisory
//                 above it, to the same question.
// ---------------------------------------------------------------------------
let hazardTicket = 0;

async function refreshHazards() {
  const ticket = ++hazardTicket;
  await refreshCountryHazards(ticket);
}

/**
 * Earthquakes, drawn where they happened, from the same GDACS rows as
 * everything else.
 *
 * Only the ones worth a traveller's attention reach the table at all: GDACS
 * grades an earthquake Orange or Red, or it is magnitude 6 and above. The
 * nineteen green magnitude-fives a hundred kilometres down that GDACS lists on
 * an ordinary day are the ones nobody felt, and they are filtered out at the
 * refresh rather than here — see supabase/ops/fetch_disasters.py.
 */
function paintQuakes() {
  const status = $('#earthquake-status');
  if (!state.layers.earthquake) {
    setHazards(map, []);
    status.textContent = t('safety.off');
    return;
  }
  if (!state.disasters) { status.textContent = t('hazards.failed'); return; }

  // Number(null) is 0, which is a perfectly finite magnitude and a lie. A row
  // with no magnitude has nothing to size a ring by, and a default would be a
  // number we made up.
  const asMagnitude = (value) =>
    (value === null || value === undefined || value === '') ? NaN : Number(value);

  const quakes = uniqueEvents(row => row.kind === 'earthquake')
    .map(row => ({
      id: row.event_id, lat: row.lat, lng: row.lng, kind: 'earthquake',
      magnitude: asMagnitude(row.magnitude), depth_km: row.depth_km,
      place: row.name, at: row.from_date, url: row.url,
      severity: row.severity, ended: hasEnded(row), tsunami: false,
      tone: quakeTone(Number(row.magnitude)),
    }))
    .filter(q => Number.isFinite(q.magnitude));

  const inView = quakesIn(quakes, boundsOf(map));
  setHazards(map, inView);
  status.textContent = inView.length ? plural('hazards.inView', inView.length)
                                     : t('hazards.noneInView');
}

/**
 * Every GDACS event once, whatever `keep` says to keep.
 *
 * The table holds one row per event per country, so anything crossing a border
 * arrives more than once and the map would draw it twice.
 */
function uniqueEvents(keep) {
  const rows = [];
  const seen = new Set();
  for (const list of state.disasters?.values() ?? []) {
    for (const row of list) {
      if (seen.has(row.event_id) || !keep(row)) continue;
      // Still happening, or new in the same week the reports use — the same
      // number, imported rather than retyped. What drops off is what ENDED a
      // week ago, not what has been going on for one.
      if (!isLive(row, REPORT_WINDOW_DAYS)) continue;
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
      seen.add(row.event_id);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * The GDACS markers, and the weather chip.
 *
 * Both come from tables of ours, so they are fetched once and then only
 * recounted as the map moves.
 */
async function refreshCountryHazards(ticket) {
  const chip = $('#weather-chip');
  if (!isConfigured()) { chip.hidden = true; return; }

  if (!state.disasters) {
    try {
      state.disasters = await fetchDisasters();
    } catch (err) {
      // Quiet: a missing hazard list is not worth interrupting a map for.
      // All three map rows read from this one table, so all three say so —
      // "none in view" would be a claim we are in no position to make.
      console.error(err);
      chip.hidden = true;
      for (const kind of Object.keys(state.layers)) {
        const status = $(`#${kind}-status`);
        if (status) status.textContent = t('hazards.failed');
      }
      return;
    }
    if (ticket !== hazardTicket) return;
  }
  paintDisasterMarkers();

  if (!state.weather) {
    try {
      state.weather = await fetchWeatherWarnings();
    } catch (err) {
      console.error(err);
      state.weather = new Map();     // the markers are still worth showing
    }
    if (ticket !== hazardTicket) return;
  }

  paintWeatherMarkers();

  const code = viewIsOneCountry() ? await currentCountry() : null;
  if (ticket !== hazardTicket) return;

  const covered = Boolean(code) && WEATHER_COUNTRIES.has(code);
  const weather = code ? state.weather?.get(code) ?? [] : [];

  // The line inside the legend. It says which of three things is true, and they
  // are genuinely different claims: we are not looking here, we are looking and
  // there is nothing, we are looking and here is how much.
  $('#weather-note').textContent = `${t('hazards.weather')} — ` + (
    !code ? t('weather.zoomIn')
    : !covered ? t('weather.notCovered')
    : weather.length ? plural('weather.count', weather.length)
    : t('weather.none'));

  state.countryWeather = { code, weather };
  if ($('#weather-dialog').open) paintWeatherDialog();

  // The chip is there whenever MeteoAlarm covers the country in view, including
  // when there is nothing out. A chip that only appeared on a bad day gave its
  // absence two meanings a reader cannot tell apart — "all clear" and "nobody is
  // watching here" — and the whole point of the panel line above is that those
  // are not the same. Outside the covered countries it does go, because then
  // there is nothing to say and the panel line says that too.
  if (!covered) {
    chip.hidden = true;
    $('#weather-legend-toggle').hidden = true;
    toggleWeatherLegend(false);
    paintWeatherLegend([]);
    return;
  }

  // What is being warned of, named — "Wind, Rain" answers the question somebody
  // is actually asking, where "3 warnings" only makes them go and look. Worst
  // first, three at most, then a count: a busy country can have six kinds at
  // once and the chip would be cut off mid-word on a phone.
  const severeFirst = [...weather].sort(
    (a, b) => (a.severity === b.severity ? 0 : a.severity === 'severe' ? -1 : 1));
  const all = [...new Set(severeFirst.map(r => r.kind))];
  const named = all.map(hazardLabel);
  const kinds = named.slice(0, 3).join(', ')
    + (named.length > 3 ? ` +${named.length - 3}` : '');
  const severe = severeFirst.some(r => r.severity === 'severe');

  chip.hidden = false;
  $('#weather-legend-toggle').hidden = false;
  chip.className = 'advisory-chip weather-chip '
    + (!all.length ? 'is-clear' : severe ? 'is-severe' : 'is-notice');

  // The glyph is the answer before the words are read: the worst kind out, or
  // the sun when there is nothing. Drawn from the same paths as the markers, so
  // the chip and the map cannot drift apart.
  $('#weather-sign').innerHTML = hazardSignSVG(all[0] ?? 'clear', { size: 22 });
  $('#weather-kinds').textContent = all.length ? kinds : t('weather.allClear');
  chip.setAttribute('aria-label', `${t('hazards.weather')}: ${countryName(code, code)} — `
    + (all.length ? named.join(', ') : t('weather.allClear')));

  paintWeatherLegend(all);
}

/**
 * The legend behind the weather chip's caret: a key and a set of switches.
 *
 * One row per kind being warned of in this country RIGHT NOW, not one per kind
 * MeteoAlarm can issue. Twelve rows of which two have anything in them is a key
 * nobody reads to the bottom of, and the rows worth reading are the live ones.
 *
 * Each row carries the same drawing as the marker it describes, so the map can
 * be read from the key, and a switch, because a reader watching for wind does
 * not want eleven rain signs over the same coast. The switches are remembered
 * the way the GDACS ones are.
 */
function paintWeatherLegend(kinds) {
  const host = $('#weather-legend-rows');
  if (!host) return;

  // Rebuilt only when the set of kinds changes, so a pan inside one country does
  // not throw away a switch somebody is in the middle of using.
  const signature = kinds.join('|');
  if (host.dataset.kinds === signature) return;
  host.dataset.kinds = signature;

  if (!kinds.length) { host.innerHTML = ''; return; }

  host.innerHTML = kinds.map(kind => `
    <label class="hazard-row">
      <input type="checkbox" data-weather-kind="${esc(kind)}" />
      <span class="hz-mark" aria-hidden="true">${hazardSignSVG(kind, { size: 16 })}</span>
      <span class="hz-text">
        <span class="hz-name">${esc(hazardLabel(kind))}</span>
        <span class="hz-note" data-weather-count="${esc(kind)}"></span>
      </span>
    </label>`).join('');

  for (const box of host.querySelectorAll('[data-weather-kind]')) {
    const kind = box.dataset.weatherKind;
    box.checked = weatherKindOn(kind);
    box.addEventListener('change', (e) => {
      state.weatherLayers[kind] = e.target.checked;
      writeSetting(`ssr.weather.${kind}`, String(e.target.checked));
      paintWeatherMarkers();
    });
  }
  countWeatherLegend();
}

/**
 * Is a weather kind switched on?
 *
 * On unless somebody turned it off. A kind nobody has an opinion about is a kind
 * they want to see — the opposite default would hide a red wind warning from a
 * reader who never opened the legend.
 */
function weatherKindOn(kind) {
  if (!(kind in state.weatherLayers)) {
    const stored = readSetting(`ssr.weather.${kind}`);
    state.weatherLayers[kind] = stored === null ? true : stored === 'true';
  }
  return state.weatherLayers[kind];
}

/** How many of each kind are out, beside its row. */
function countWeatherLegend() {
  const rows = state.countryWeather?.weather ?? [];
  for (const note of $('#weather-legend-rows')?.querySelectorAll('[data-weather-count]') ?? []) {
    const kind = note.dataset.weatherCount;
    const n = rows.filter(r => r.kind === kind).length;
    note.textContent = !weatherKindOn(kind) ? t('safety.off') : plural('weather.count', n);
  }
}

/**
 * Tell the ring whether there is anything red to ring.
 *
 * It animates frame by frame, and a loop waking sixty times a second to move a
 * circle nobody can see is a flat battery on a phone in a pocket. The page knows
 * what it just drew, so it says so, and on the ordinary day when nothing is red
 * anywhere the loop never starts.
 */
function tellPulse() {
  const red = (rows) => rows?.some(r => r.severity === 'severe'
    && !r.ended && !r.upcoming) ?? false;
  pulse?.setActive(red(state.disasterMarkers) || red(state.weatherMarkers));
}

/**
 * The weather warnings that came with a position, drawn.
 *
 * Every country at once, not just the one in view: these are map markers, and a
 * marker has to be there before you pan onto it. The chip is the thing that is
 * about one country.
 *
 * Most warnings have no position and simply are not here — MeteoAlarm gives
 * none at all, NOAA gives one with about a third of its alerts. That is not a
 * gap to apologise for: the chip and its list carry every warning, and this
 * layer adds a place to the ones that have one.
 *
 * Whether a warning has STARTED is worked out here, with a clock, and travels
 * with the row — a style expression cannot ask what time it is. The layer fades
 * the ones that have not, and the popup says so in words.
 */
function paintWeatherMarkers() {
  // One marker per point and kind, not one per warning. Most of Europe's area
  // names are weather zones rather than places — "Ibérica aragonesa" is not
  // somewhere a geocoder has heard of — so those warnings sit on the middle of
  // their country, and Spain on a wet afternoon would be forty identical tiles
  // stacked on Madrid. Stacked markers are not more information, they are one
  // marker drawn forty times with thirty-nine popups you cannot reach.
  //
  // The worst severity wins, and the one still in force beats one that has not
  // started, because that is the order somebody reads them in.
  const byPoint = new Map();
  for (const list of state.weather?.values() ?? []) {
    for (const row of list) {
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
      // A kind switched off in the legend does not reach the source at all,
      // rather than being drawn and hidden: one way to hide a marker is enough,
      // and the count beside its row has to agree with what is on the map.
      if (!weatherKindOn(row.kind)) continue;

      const marker = { ...row, upcoming: isUpcoming(row) };
      const key = `${row.lat},${row.lng}|${row.kind}`;
      const standing = byPoint.get(key);
      if (!standing) { byPoint.set(key, marker); continue; }
      // Keep the louder of the two, and remember that more than one is here so
      // the popup can say so rather than pretending it is the only one.
      const better = (a, b) =>
        a.severity !== b.severity ? (a.severity === 'severe' ? a : b)
        : a.upcoming !== b.upcoming ? (a.upcoming ? b : a)
        : a;
      const kept = better(standing, marker);
      kept.also = (standing.also ?? 0) + 1;
      byPoint.set(key, kept);
    }
  }
  state.weatherMarkers = fanOut([...byPoint.values()]);
  setWeather(map, state.weatherMarkers);
  tellPulse();
  countWeatherLegend();
}

// How far apart two markers sharing a point are drawn, in screen pixels between
// centres. A weather tile is about 24px across at mid zoom, so this is roughly
// one tile's width of daylight: enough to see there are several and to hit the
// one you meant, without throwing them so far they look like separate places.
const FAN_PIXELS = 30;

// Past this many on one point, a ring stops being readable and becomes a
// necklace. The rest go on a second ring further out.
const FAN_RING = 8;

// How far a marker may ever be moved from the point it belongs to, whatever the
// zoom says. Without this the ring keeps growing in degrees as you zoom out —
// it is held at a constant size on SCREEN, and a pixel is worth more ground
// every time you zoom out — so Greece's markers ended up in the Aegean and on
// the way to Albania.
//
// 0.35° is about 39km, which keeps a ring inside every country MeteoAlarm
// covers from the point the geocoder calls its middle. It binds only below
// roughly zoom 6, where 0.35° is a handful of pixels: zoomed out that far the
// markers sit on top of each other again, which is right, because at a
// continent's width you are not picking one of them out anyway.
const FAN_MAX_DEGREES = 0.35;

/**
 * Separate the markers that share a point.
 *
 * Greece is the case this was reported for: every area name its service sends is
 * a weather zone — "East Sterea & Evvoia" — and none of them is a place a
 * geocoder knows, so every one falls back to the middle of Greece and five kinds
 * of warning arrive on the same pixel. Collapsing identical kinds was not
 * enough, because the ones left are all different.
 *
 * They are fanned around the point they share rather than hidden behind each
 * other. Three things make that honest rather than a fudge:
 *
 *   The point was never exact. These are the ones the lookup could only place on
 *   their country; the popup says so, and a marker 30px off the middle of Greece
 *   is no less true than one exactly on it.
 *
 *   The spread is in SCREEN pixels, not degrees. It is worked out from the
 *   current zoom, so the fan looks the same whether you are looking at Europe or
 *   at Athens, and the markers stay over the country rather than sliding into
 *   the sea as you zoom out.
 *
 *   Nothing moves that did not have to. A marker alone on its point is left
 *   exactly where it is, which is every marker a service gave real geometry for.
 */
function fanOut(rows) {
  const shared = new Map();
  for (const row of rows) {
    const key = `${row.lat},${row.lng}`;
    if (!shared.has(key)) shared.set(key, []);
    shared.get(key).push(row);
  }

  const zoom = map.getZoom?.() ?? 5;
  const out = [];
  for (const group of shared.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }

    // Web Mercator metres per pixel, then into degrees. Latitude first because
    // a degree of longitude shrinks towards the poles and Norway would
    // otherwise fan twice as wide as Cyprus.
    const lat = group[0].lat;
    const metresPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** zoom;

    // The cap is applied to the OUTERMOST ring, not to the first one, so a
    // second ring cannot step over it. Everything inside scales down with it.
    const rings = Math.ceil(group.length / FAN_RING);
    const furthest = 1 + (rings - 1) * 0.9;
    const dLat = Math.min((FAN_PIXELS * metresPerPixel) / 111320,
                          FAN_MAX_DEGREES / furthest);
    const dLng = dLat / Math.max(Math.cos(lat * Math.PI / 180), 0.2);

    // Worst first, so the one that matters takes the top of the ring where the
    // eye lands, rather than wherever the table happened to order it.
    const ordered = [...group].sort((a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'severe' ? -1 : 1)
      || (a.upcoming === b.upcoming ? 0 : a.upcoming ? 1 : -1));

    ordered.forEach((row, i) => {
      const ring = Math.floor(i / FAN_RING);
      const onRing = Math.min(ordered.length - ring * FAN_RING, FAN_RING);
      const angle = (2 * Math.PI * (i % FAN_RING)) / onRing - Math.PI / 2;
      const reach = 1 + ring * 0.9;
      out.push({
        ...row,
        lat: row.lat + dLat * reach * Math.sin(angle) * -1,
        lng: row.lng + dLng * reach * Math.cos(angle),
        // Marked so the popup can own up to having been moved, and so a test
        // can tell a fanned marker from one drawn where its data put it.
        fanned: true,
      });
    });
  }
  return out;
}

/**
 * Every GDACS event with a usable position, drawn, and counted for the view.
 *
 * Counted for the VIEW rather than for the country, like the earthquakes: the
 * question a marker answers is "what is going on where I am looking", and a
 * cyclone two hundred miles off the coast is in view long before it is in the
 * country.
 */
function paintDisasterMarkers() {
  // Earthquakes have a layer of their own — rings sized by magnitude, which is
  // information a symbol cannot carry.
  paintQuakes();

  // Whether it is over is worked out once, here, and travels with the row: the
  // map greys an ended marker and the popup says "Ended 28 Sep" instead of
  // claiming it is still going. Both need the clock, which a style expression
  // does not have.
  const rows = uniqueEvents(row => row.kind !== 'earthquake')
    .map(row => ({ ...row, ended: hasEnded(row) }));
  state.disasterMarkers = rows.filter(r => state.layers[r.kind]);
  setDisasters(map, state.disasterMarkers);
  tellPulse();

  const bounds = boundsOf(map);
  // The same words for every row, because they answer the same question about
  // the same rectangle of map.
  for (const kind of Object.keys(state.layers)) {
    if (kind === 'earthquake') continue;          // its own layer, counted there
    const status = $(`#${kind}-status`);
    if (!status) continue;
    const here = inBounds(rows.filter(r => r.kind === kind), bounds).length;
    status.textContent = !state.layers[kind] ? t('safety.off')
      : here ? plural('hazards.inView', here)
      : t('hazards.noneInView');
  }
}

/**
 * Is the map looking at somewhere reporting is closed?
 *
 * Only ever true when it is sure: the view has to be inside one country and
 * that country has to be on the list. A view spanning three countries answers
 * no, and the pin refusal catches it later — better than telling somebody the
 * region is closed when we do not know which region they mean.
 */
async function regionClosedHere() {
  if (!isConfigured() || !viewIsOneCountry()) return false;
  const code = await currentCountry();
  return Boolean(code && state.blockedCountries?.has(code));
}


/** Show or hide the weather legend, which floats over the map under its chip. */
function toggleWeatherLegend(open) {
  const panel = $('#weather-legend');
  const button = $('#weather-legend-toggle');
  const show = open ?? panel.hidden;
  panel.hidden = !show;
  button.setAttribute('aria-expanded', String(show));
}

function paintWeatherDialog() {
  const { code, weather } = state.countryWeather ?? {};
  // The country in the eyebrow, because the chip is about a country and the
  // reader has just crossed one to get here.
  $('#weather-eyebrow').textContent = countryName(code, code ?? '');
  $('#weather-title').textContent = t('hazards.weather');
  $('#weather-body').innerHTML = weatherDialogHTML(weather ?? []);
}

/**
 * Open an info window on the map.
 *
 * On a phone the window kept opening past the edge of the map, so you had to
 * drag before you could read it. MapLibre picks which side to open on from the
 * room available at that instant, and a pin near an edge has room on neither.
 * So on a narrow screen the map moves the pin into view first — a little below
 * centre, which leaves the taller half of the map above it for the window —
 * and the window is narrower there too, because a phone has less to spare.
 *
 * On a wide screen nothing moves: there is room wherever it opens, and moving
 * the map under someone who did not ask is its own annoyance.
 */
const narrowScreen = () => window.matchMedia('(max-width: 900px)').matches;

function showPopup(lngLat, html) {
  openPopup?.remove();
  const narrow = narrowScreen();
  if (narrow) map.easeTo({ center: lngLat, offset: [0, 60], duration: 320 });

  openPopup = new maplibregl.Popup({
    offset: 16,
    closeButton: true,
    maxWidth: narrow ? '248px' : '300px',
    className: 'report-popup',
  })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);
  return openPopup;
}

// ---------------------------------------------------------------------------
// Emergency numbers for the country on screen
//
// Not the country the phone is in: somebody planning a trip should see the
// numbers for where they are going, and somebody who has just been robbed
// should not have to work out what to dial.
//
// Which country that is comes free most of the time — the reports and safety
// places already in view carry a country code. Only an empty patch of map
// needs Nominatim, and that answer is cached by half-degree cell so panning
// around one city asks once.
// ---------------------------------------------------------------------------
const countryCache = new Map();

function countryFromView() {
  const codes = [
    ...state.lastFetch.reports.map(r => r.country_code),
    ...state.safetyPlaces.map(p => p.country_code),
  ].filter(Boolean);
  if (!codes.length) return null;
  // The commonest, so a report just over a border does not flip the numbers.
  const tally = new globalThis.Map();
  codes.forEach(c => tally.set(c, (tally.get(c) ?? 0) + 1));
  return [...tally].sort((a, b) => b[1] - a[1])[0][0];
}

async function countryAtCentre() {
  const { lat, lng } = map.getCenter();
  const key = `${Math.round(lat * 2)}|${Math.round(lng * 2)}`;
  if (countryCache.has(key)) return countryCache.get(key);
  try {
    const { countryCode } = await describePoint(lat, lng);
    countryCache.set(key, countryCode ?? null);
    return countryCode ?? null;
  } catch {
    return null;                       // no numbers is fine; a wrong one is not
  }
}

/**
 * Which country is on screen, resolved once per view and shared.
 *
 * The emergency bar and the travel advisory both need this, and each asking
 * separately meant two Nominatim lookups for one pan — the cache made the
 * second free only if the first had already landed, which racing calls do not
 * guarantee. Sharing one promise also keeps the two panels agreeing with each
 * other, which matters more than the request: a bar naming France beside an
 * advisory for Spain would be worse than either being slow.
 */
let countryPending = null;
const forgetCountry = () => { countryPending = null; };

/**
 * The country the reader asked for, as opposed to the one the map is over.
 *
 * Searching a place used to tell these panels nothing, and both of the ways
 * they had of working it out for themselves fail on exactly that move:
 *
 *   The zoom gate below. A country is fitted to its own bounding box, which
 *   is zoom 5 or 6 on a desktop and 3 or 4 on a phone — under the gate, so the
 *   chip went on prompting for a place while the map sat on France.
 *
 *   The centre of that box. Reverse-geocoding it answers whatever is at the
 *   centroid, which for Norway is Sweden, for Croatia is Bosnia, and for a
 *   country with overseas territory is open ocean. Even a city search could
 *   miss, because the reports already loaded belonged to the view we just
 *   left.
 *
 * A search result carries its own country code, from the geocoder that found
 * it, so there is nothing to infer: the reader named a place and the panels
 * follow it. It holds until they move the map themselves, at which point the
 * view is theirs again and the inference below takes over.
 */
function rememberSearchedCountry(code) {
  state.searchedCountry = code || null;
  forgetCountry();
}

const forgetSearchedCountry = () => {
  if (!state.searchedCountry) return;
  state.searchedCountry = null;
  forgetCountry();
};

/**
 * Whether anything on screen can be named for one country.
 *
 * Zoomed out across a continent, one country's answer is a lie — that is as
 * true of an advisory as of an emergency number, so both use the same test.
 * It also keeps the geocoder out of a plain page load: at world zoom there is
 * nothing to look up and nothing worth showing.
 *
 * A searched country passes whatever the zoom, because there the answer was
 * not inferred from the view at all. Both panels ask this one question so they
 * cannot disagree: a bar naming France beside an advisory for Spain would be
 * worse than either being slow.
 */
const viewIsOneCountry = () =>
  Boolean(state.searchedCountry) || map.getZoom() >= EMERGENCY_MIN_ZOOM;

function currentCountry() {
  if (!countryPending) {
    const known = state.searchedCountry || countryFromView();
    countryPending = known ? Promise.resolve(known) : countryAtCentre();
  }
  return countryPending;
}

let emergencyTicket = 0;
async function refreshEmergency() {
  const bar = $('#emergency-bar');

  // Zoomed out across several countries, one country's numbers would be a lie.
  if (!viewIsOneCountry()) { bar.hidden = true; return; }

  const ticket = ++emergencyTicket;
  const code = await currentCountry();
  if (ticket !== emergencyTicket) return;

  const info = emergencyFor(code);
  // Nothing rather than a guess: an emergency number that does not work is
  // worse than none at all.
  if (!info) { bar.hidden = true; return; }

  $('#eb-country').textContent = info.name;
  $('#eb-numbers').innerHTML = info.numbers.map(n => `
    <span class="eb-num"><span>${esc(n.label)}</span><a href="tel:${esc(n.number.replace(/\s/g, ''))}">${esc(n.number)}</a></span>
  `).join('');
  bar.hidden = false;
}

// ---------------------------------------------------------------------------
// Travel advisory for the country on screen
//
// It follows the same country the emergency bar follows — worked out from the
// reports and hospitals already in view, so most of the time it costs nothing.
// The chip shows the level; the dialog adds the dates and the link.
//
// The chip stays visible with nothing resolved, prompting for a place, so it
// also serves as the way in when you have not searched for anywhere yet.
// ---------------------------------------------------------------------------
let advisoryTicket = 0;

/** The chip with no country behind it: a prompt, and the way into the dialog. */
function paintAdvisoryPrompt(chip) {
  state.advisoryCountry = null;
  chip.hidden = false;
  chip.className = 'advisory-chip is-empty';
  // Nothing in the level line, and no stand-in for it. It held "Search a
  // place" — "Ort suchen" in German — which was an instruction nobody needed:
  // the chip is in the corner of a map that already has a search box, and
  // telling a reader to search in order to find out whether they need to
  // search is a sentence that earns no room. The chip says what it is, and
  // fills in once there is a country. CSS promotes the name line to the
  // level's size while this is empty, so it does not read as a caption with
  // nothing under it.
  const line = $('#advisory-level');
  line.textContent = '';
  // lang="de" is right for a level, which is the ministry's own word. There is
  // no level here, so it comes off and goes back on with the next real one.
  line.removeAttribute('lang');
  chip.setAttribute('aria-label', t('advisory.chipName'));
  if ($('#advisory-dialog').open) paintAdvisoryDialog();
}

async function refreshAdvisory() {
  const chip = $('#advisory-chip');
  if (!isConfigured()) { chip.hidden = true; return; }

  const ticket = ++advisoryTicket;
  // Zoomed out, the chip still shows — it is the way into the dialog — but as
  // a prompt rather than as a country's status, and without asking anybody.
  const code = viewIsOneCountry() ? await currentCountry() : null;
  if (ticket !== advisoryTicket) return;

  // Nothing to look up yet, so nothing is read: a visitor who never zooms in
  // should not pay for two hundred rows they were never shown.
  if (!code) { paintAdvisoryPrompt(chip); return; }

  if (!state.advisories) {
    try {
      state.advisories = await fetchAdvisories();
    } catch (err) {
      console.error(err);
      chip.hidden = true;        // quiet: a missing advisory is not an error
      return;                    // worth interrupting a map with
    }
    if (ticket !== advisoryTicket) return;
  }

  // A country the ministry does not publish on — Germany itself among them,
  // since it does not advise Germans about home.
  const row = state.advisories.get(code) ?? null;
  if (!row) { paintAdvisoryPrompt(chip); return; }
  state.advisoryCountry = row;

  const level = advisoryLevel(row);
  chip.hidden = false;
  chip.className = `advisory-chip ${advisoryTone(level)}`;
  // The country used to be this chip's top line. The name took that place, so
  // the country moves to the label a screen reader announces and to the dialog
  // behind the chip — the map is already showing you which country you are in,
  // and what the chip has to say that the map cannot is the level.
  const line = $('#advisory-level');
  line.textContent = levelLabel(level);
  line.setAttribute('lang', 'de');     // the ministry's own word for it again
  chip.setAttribute('aria-label', chipAria(row, level));

  if ($('#advisory-dialog').open) paintAdvisoryDialog();
}

/** The panel's fixed wording. Set from JS rather than left in the markup so
 *  there is one place it lives, next to the strings it belongs with. */
function paintAdvisoryChrome() {
  $('#advisory-eyebrow').textContent = ADVISORY.eyebrow;
}

function paintAdvisoryDialog() {
  const row = state.advisoryCountry;
  const level = advisoryLevel(row);
  // The heading is the country, so the dialog says what it is about before it
  // says how serious it is.
  $('#advisory-title').textContent = row ? countryTitle(row) : ADVISORY.title;
  $('#advisory-body').innerHTML = advisoryDialogHTML(row, {
    level,
    tone: row ? advisoryTone(level) : 'is-empty',
    changed: row ? changedOn(row) : '',
    stats: advisoryStats(state.advisories),
    ageDays: copyAgeDays(state.advisories),
  });
}

function draw() {
  const { mode, reports, cells, hiddenCount } = state.lastFetch;
  const visible = reports.filter(passesFilter);

  setReports(map, visible);
  setDensity(map, mode === 'summary' ? cells : []);

  const totalCells = cells.reduce((sum, c) => sum + Number(c.total), 0);
  $('#reports-count').textContent = mode === 'summary' ? totalCells : visible.length;
  $('#reports-title').textContent = t(mode === 'summary'
    ? 'reports.title.region' : 'reports.title.here');
  $('#reports-scope').textContent = reportScopeLine(
    { mode, ageDays: state.ageDays, windowDays: REPORT_WINDOW_DAYS });
  setAgeSlider($('#age-range'), state.ageDays, REPORT_WINDOW_DAYS);

  renderReportList($('#report-list'), visible, {
    categories: state.categories, mode, supported: state.supported, signedIn: signedIn(),
    narrowed: state.ageDays < REPORT_WINDOW_DAYS,
  });
  setGateNote($('#gate-note'), { mode, shown: visible.length, hiddenCount, signedIn: signedIn() });

  // After the fetch, not alongside it: run in parallel and this reads the
  // previous view's reports, finds no country in them, and asks the geocoder
  // for something the answer already contained. The advisory rides on the
  // same country lookup.
  forgetCountry();
  refreshEmergency();
  refreshAdvisory();
  refreshHazards();
}

// ---------------------------------------------------------------------------
// When it happened
//
// This used to be a dropdown of rough buckets — earlier today, yesterday,
// earlier this week. A date and a time say what actually happened, a phone
// gives them its own pickers, and pinning min/max to the visibility window
// means the form cannot offer an answer the map would then throw away.
// ---------------------------------------------------------------------------
const asLocalISO = (d) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();

function primeWhenFields() {
  const dateField = $('#scam-when-date');
  const timeField = $('#scam-when-time');
  const now = new Date();
  dateField.max = asLocalISO(now).slice(0, 10);
  dateField.min = asLocalISO(new Date(now.getTime() - REPORT_WINDOW_DAYS * 86400000)).slice(0, 10);
  if (!dateField.value) dateField.value = dateField.max;
  if (!timeField.value) timeField.value = asLocalISO(now).slice(11, 16);
  $('#when-hint').textContent = t('report.whenHint', { days: REPORT_WINDOW_DAYS });
}

/** The chosen moment, or null if the pair does not make one. */
function whenChosen() {
  const date = $('#scam-when-date').value;
  const time = $('#scam-when-time').value;
  if (!date || !time) return null;
  const when = new Date(`${date}T${time}`);
  return Number.isNaN(when.getTime()) ? null : when;
}

// ---------------------------------------------------------------------------
// Map interaction
// ---------------------------------------------------------------------------
function onMapClick(e) {
  if (state.picking) {
    setPin({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    stopPicking();
    primeWhenFields();
    openDialog('#report-dialog');
    return;
  }

  // Query a small box rather than a point, so a fingertip on a phone hits the
  // pin it was aimed at.
  const pad = 8;
  const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  const layers = ['report-icon', 'report-point', 'clusters', 'safety-icon',
                  'volcano-icon', 'disaster-icon', 'weather-icon', 'hazard-ring']
    .filter(id => map.getLayer(id));
  const hits = layersReady ? map.queryRenderedFeatures(box, { layers }) : [];
  if (!hits.length) return;

  const hit = hits[0];
  if (hit.properties.cluster) {
    map.easeTo({ center: hit.geometry.coordinates, zoom: map.getZoom() + 2 });
    return;
  }

  const html = hit.layer?.id === 'safety-icon' ? safetyPopupHTML(hit.properties)
    : hit.layer?.id === 'hazard-ring' ? quakePopupHTML(hit.properties)
    : hit.layer?.id === 'weather-icon' ? weatherPopupHTML(hit.properties)
    : hit.layer?.id === 'volcano-icon' || hit.layer?.id === 'disaster-icon'
      ? disasterPopupHTML(hit.properties)
    : popupHTML(hit.properties, state.categories);

  showPopup(hit.geometry.coordinates, html);
}

function startPicking() {
  state.picking = true;
  document.getElementById('city-map').classList.add('is-picking');
  toast(t('report.pickHint'));
}
function stopPicking() {
  state.picking = false;
  document.getElementById('city-map').classList.remove('is-picking');
}

/**
 * Where a report cannot be.
 *
 * Nobody is pickpocketed in the middle of the Atlantic, and a pin there is
 * either a mis-tap or somebody playing. Two checks, in order of what they
 * cost: the latitude band is free and local, the rest waits for the geocoder
 * that was being asked for the address anyway.
 *
 * A geocoder that could not answer is never treated as "you are at sea" —
 * see describePoint. Being unable to name a street must not stop a report.
 */
function refusePin(place) {
  if (place?.countryCode === 'AQ') return 'toast.pinPolar';
  if (place?.known && place?.onWater) return 'toast.pinOnWater';
  // Somewhere we are not serving. The database refuses these too; this is so
  // nobody writes out a report that was never going to be accepted.
  if (place?.countryCode && state.blockedCountries?.has(place.countryCode)) {
    return 'toast.regionClosed';
  }
  return null;
}

const outsideBounds = (lat) => lat < REPORT_BOUNDS.minLat || lat > REPORT_BOUNDS.maxLat;

function clearPin(reason) {
  state.pin = null;
  const status = $('#pin-status');
  status.classList.remove('is-set');
  status.textContent = t('report.noPin');
  if (reason) toast(t(reason), { error: true });
}

function setPin({ lat, lng, label }) {
  if (outsideBounds(lat)) { clearPin('toast.pinPolar'); return Promise.resolve(); }

  state.pin = { lat, lng, address: null, city: null, countryCode: null };
  const status = $('#pin-status');
  status.classList.add('is-set');
  status.textContent = label
    ?? t('report.pinnedAt', { lat: lat.toFixed(4), lng: lng.toFixed(4) });

  // Naming the place is a second network call. Keep the promise so that
  // submitting quickly waits for it rather than posting without a city.
  state.pinPending = describePoint(lat, lng).then(place => {
    if (state.pin?.lat !== lat || state.pin?.lng !== lng) return;   // pin moved on

    const refusal = refusePin(place);
    if (refusal) { clearPin(refusal); return; }

    state.pin = { lat, lng, address: place.address, city: place.city, countryCode: place.countryCode };
    status.textContent = place.label
      ? `📍 ${place.address ? place.address + ', ' : ''}${place.label}`
      : `📍 ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }).finally(() => { state.pinPending = null; });

  return state.pinPending;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
async function runSearch(query) {
  const box = $('#search-results');
  if (!query.trim()) { box.hidden = true; return; }
  box.hidden = false;
  const note = (text) =>
    `<p class="muted-note" style="padding:12px 13px">${esc(text)}</p>`;
  box.innerHTML = note(t('search.searching'));
  try {
    const hits = await searchPlaces(query);
    if (!hits.length) {
      box.innerHTML = note(t('search.none'));
      return;
    }
    box.innerHTML = hits.map((h, i) => `
      <button type="button" class="search-hit" data-hit="${i}">
        <b>${esc(h.label)}</b><span>${esc(h.detail)}</span>
      </button>`).join('');
    box.__hits = hits;
  } catch (err) {
    box.innerHTML = note(err.message);
  }
}

// ---------------------------------------------------------------------------
// Suggestions while you type
//
// Not a free-for-all. Every keystroke would be a request to somebody else's
// free service, so nothing is asked until there are a few characters and until
// typing pauses, and each new request cancels the one before it — which also
// stops a slow answer landing on top of a newer, faster one.
//
// The search button still goes to Nominatim, which is better at a full,
// deliberate query. These two are allowed to disagree: one is a guess at what
// you are typing, the other is an answer to what you typed.
// ---------------------------------------------------------------------------
let suggestTimer = 0;
let suggestRun = null;          // the in-flight request, so it can be cancelled
let suggestSeq = 0;

function showSuggestions(hits) {
  const box = $('#search-results');
  if (!hits.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = hits.map((h, i) => `
    <button type="button" class="search-hit" data-hit="${i}" role="option" aria-selected="false">
      <b>${esc(h.label)}</b>${h.detail ? `<span>${esc(h.detail)}</span>` : ''}
    </button>`).join('');
  box.__hits = hits;
  box.__cursor = -1;
}

function askForSuggestions(typed) {
  clearTimeout(suggestTimer);
  suggestRun?.abort();

  const query = typed.trim();
  if (query.length < SUGGEST_MIN_CHARS) { $('#search-results').hidden = true; return; }

  suggestTimer = setTimeout(async () => {
    const run = new AbortController();
    suggestRun = run;
    const ticket = ++suggestSeq;
    try {
      // Biased to the middle of the map, so a street name finds the one where
      // the reader is already looking.
      const centre = map.getCenter();
      const hits = await suggestPlaces(query,
        { near: { lat: centre.lat, lng: centre.lng }, signal: run.signal });
      if (ticket === suggestSeq) showSuggestions(hits);
    } catch (err) {
      // An abort is the expected way one of these ends. Anything else is the
      // suggestion service having a moment, which must not interrupt someone
      // in the middle of typing — the search button still works.
      if (err?.name !== 'AbortError') console.warn('suggestions unavailable:', err);
    }
  }, SUGGEST_DEBOUNCE_MS);
}

/** Arrow keys through the list, Enter to take one, Escape to dismiss it. */
function moveSuggestion(step) {
  const box = $('#search-results');
  const options = [...box.querySelectorAll('[data-hit]')];
  if (box.hidden || !options.length) return false;

  const next = ((box.__cursor ?? -1) + step + options.length + 1) % (options.length + 1);
  box.__cursor = next === options.length ? -1 : next;
  options.forEach((option, i) => {
    const on = i === box.__cursor;
    option.classList.toggle('is-active', on);
    option.setAttribute('aria-selected', String(on));
    if (on) option.scrollIntoView({ block: 'nearest' });
  });
  return true;
}

function goToPlace(place) {
  // Before the flight, not after: flyToPlace fires moveend, which runs the
  // whole refresh — including the two panels that are about to ask which
  // country this is.
  rememberSearchedCountry(place.countryCode);
  flyToPlace(map, place, PLACE_ZOOM);
  state.placeLabel = place.label;
  $('#place-label').textContent = place.label;

  // The box says what was chosen, not what was typed. Leaving "lisbo" sitting
  // there after picking Lisbon reads as though nothing was taken.
  const box = $('#place-search');
  box.value = place.fullName ?? place.label;
  box.__lastSuggested = box.value;      // so this does not ask for suggestions again
  $('#search-results').hidden = true;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function fillCategorySelect() {
  const sel = $('#scam-category');
  const chosen = sel.value;
  sel.innerHTML = state.categories
    .map(c => `<option value="${esc(c.slug)}">${esc(c.glyph)} ${esc(categoryLabel(c))}</option>`).join('');
  if (chosen) sel.value = chosen;   // a language change must not reset the form
}

/**
 * Remembering a choice between visits.
 *
 * Wrapped because localStorage throws rather than returns null in a private
 * window in some browsers, and a remembered panel state is never worth a blank
 * page. Nothing personal is stored here — only which panels you left open.
 */
function readSetting(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeSetting(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not important enough */ }
}

function wireUI() {
  // --- search
  const searchBox = $('#place-search');
  $('#place-form').addEventListener('submit', e => {
    e.preventDefault();
    clearTimeout(suggestTimer);
    suggestRun?.abort();

    // If a suggestion is highlighted, that is the answer — no point asking a
    // second service about a place somebody has already picked.
    const box = $('#search-results');
    const chosen = (box.__hits ?? [])[box.__cursor ?? -1];
    if (chosen) { goToPlace(chosen); return; }
    runSearch(searchBox.value);
  });

  searchBox.addEventListener('input', e => askForSuggestions(e.target.value));
  searchBox.addEventListener('focus', e => {
    // Not after a suggestion was taken: the box holds a chosen place, and
    // reopening the list over it is noise.
    if (e.target.value === e.target.__lastSuggested) return;
    if ((e.target.value ?? '').trim().length >= SUGGEST_MIN_CHARS
        && ($('#search-results').__hits ?? []).length) {
      $('#search-results').hidden = false;
    }
  });
  searchBox.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && moveSuggestion(1)) e.preventDefault();
    else if (e.key === 'ArrowUp' && moveSuggestion(-1)) e.preventDefault();
    else if (e.key === 'Escape') { $('#search-results').hidden = true; }
  });

  $('#search-results').addEventListener('click', e => {
    const btn = e.target.closest('[data-hit]');
    if (!btn) return;
    const hits = $('#search-results').__hits ?? [];
    const place = hits[Number(btn.dataset.hit)];
    if (place) goToPlace(place);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.place-search') && !e.target.closest('#search-results')) {
      $('#search-results').hidden = true;
    }
  });

  $('#locate-me').addEventListener('click', async () => {
    try {
      toast(t('toast.locating'));
      const here = await locateMe();
      // Whatever was searched before is not where you are. Cleared before the
      // flight so the panels do not spend it showing the old country.
      forgetSearchedCountry();
      map.flyTo({ center: [here.lng, here.lat], zoom: PLACE_ZOOM, duration: 900 });
      const place = await describePoint(here.lat, here.lng);
      state.placeLabel = place.label ?? t('place.whereYouAre');
      $('#place-label').textContent = state.placeLabel;
      // Where you are is a place you chose, like a searched one, so the
      // advisory and the emergency numbers follow it rather than re-deriving
      // it from the view.
      if (place.countryCode) {
        rememberSearchedCountry(place.countryCode);
        refreshEmergency();
        refreshAdvisory();
      }
      toast(t('toast.showingAround'));
    } catch (err) {
      toast(err.message || t('toast.locateFailed'), { error: true });
    }
  });
  $('#place-chip').addEventListener('click', () => $('#place-search').focus());

  // --- travel advisory
  paintAdvisoryChrome();
  $('#advisory-chip').addEventListener('click', () => {
    paintAdvisoryDialog();
    openDialog('#advisory-dialog');
  });

  // --- map controls
  $('#zoom-in').addEventListener('click', () => map.zoomIn());
  $('#zoom-out').addEventListener('click', () => map.zoomOut());

  // --- filters
  $('#category-filters').addEventListener('click', e => {
    const chip = e.target.closest('[data-category]');
    if (!chip) return;
    const slug = chip.dataset.category;
    const on = state.activeCategories.has(slug);
    on ? state.activeCategories.delete(slug) : state.activeCategories.add(slug);
    chip.setAttribute('aria-pressed', String(!on));
    draw();
  });
  // The filter panel is a <details> that opens and closes at any width.
  //
  // It used to be forced open on a desktop and forced shut on a phone, and a
  // resize would overrule whatever you had just clicked. Now the first visit
  // is decided by the room available — open where there is space, closed on a
  // phone where the map matters more — and after that your last choice is
  // remembered and nothing overrules it.
  const filterPanel = $('#filter-panel');
  const FILTERS_OPEN = 'ssr.filters.open';
  const stored = readSetting(FILTERS_OPEN);
  filterPanel.open = stored === null
    ? window.matchMedia('(min-width: 901px)').matches
    : stored === 'true';
  filterPanel.addEventListener('toggle', () =>
    writeSetting(FILTERS_OPEN, String(filterPanel.open)));

  // The reports card, same idea and one difference: it only closes on a wide
  // screen. There it floats over the bottom-right of the map and is the
  // biggest thing covering it, so being able to put it away is the point. On a
  // phone it sits in normal flow below the map and covers nothing, so there is
  // nothing to put away — and a head that invited a tap and then hid the list
  // would be taking something away rather than giving it. So it is held open
  // below the breakpoint, the choice made above the breakpoint is remembered,
  // and crossing the breakpoint puts that choice back rather than losing it.
  const reportsCard = $('#reports-card');
  const REPORTS_OPEN = 'ssr.reports.open';
  const wide = window.matchMedia('(min-width: 901px)');
  const applyReportsWidth = () => {
    reportsCard.open = wide.matches ? readSetting(REPORTS_OPEN) !== 'false' : true;
  };
  applyReportsWidth();
  wide.addEventListener('change', applyReportsWidth);
  reportsCard.addEventListener('toggle', () => {
    // Only a choice made where closing is possible is a choice. The forced
    // open above would otherwise write 'true' over what somebody had set on
    // their laptop the moment they turned their phone sideways.
    if (wide.matches) writeSetting(REPORTS_OPEN, String(reportsCard.open));
  });

  $('#safety-toggle').addEventListener('change', e => {
    state.safetyOn = e.target.checked;
    setSafetyVisible(map, state.safetyOn);
    refreshSafety();
  });

  // The switches, and the memory of them. A reader who turned the earthquakes
  // on should not have to do it again tomorrow — nor should one who turned
  // something off have it come back.

  // The key beside each switch is drawn from the same paths as the marker on
  // the map. A legend redrawn by hand stops matching the map the first time
  // either one changes, and then it is worse than no legend.
  for (const mark of document.querySelectorAll('[data-hazard-sign]')) {
    mark.innerHTML = hazardSignSVG(mark.dataset.hazardSign, { size: 16 });
  }
  // Each switch is named after its kind, so there is no table mapping one to
  // the other to fall out of step. What a switch does is decide whether that
  // kind reaches the map source at all — no layer visibility to keep in
  // agreement with it.
  for (const kind of Object.keys(state.layers)) {
    const box = $(`#${kind}-toggle`);
    if (!box) continue;
    const stored = readSetting(`ssr.layer.${kind}`);
    if (stored !== null) state.layers[kind] = stored === 'true';
    box.checked = state.layers[kind];
    box.addEventListener('change', e => {
      state.layers[kind] = e.target.checked;
      writeSetting(`ssr.layer.${kind}`, String(e.target.checked));
      refreshHazards();
    });
  }

  // --- light and dark ------------------------------------------------------
  //
  // The button only ever says what it wants; everything that follows from a
  // theme change is subscribed to the change itself, so the system switch
  // flipping at sunset takes the map with it exactly as a click does.
  const themeButton = $('#theme-button');
  const themePicker = $('#profile-theme');
  themeButton.addEventListener('click', () => toggleTheme());
  themePicker.addEventListener('change', (e) => chooseTheme(e.target.value));
  onThemeChange((theme) => {
    themeButton.setAttribute('aria-pressed', String(theme === 'dark'));
    // The picker shows the CHOICE, not the result: the header button sets an
    // explicit light or dark, so using it has to move the picker off "match
    // my device" — otherwise it would claim to be following a device it is
    // no longer following.
    themePicker.value = themeChoice();
    if (!layersReady) return;      // the load handler will use the right one
    // The basemap swap discards every source, layer and image, so they are
    // rebuilt and then filled again — without the redraw the new basemap
    // arrives with nothing on it, which looks like a map with no reports.
    layersReady = false;
    setMapTheme(map, theme, () => {
      buildMapLayers();
      refresh();
      refreshSafety();
      refreshHazards();
    });
  });
  themeButton.setAttribute('aria-pressed', String(currentTheme() === 'dark'));
  themePicker.value = themeChoice();

  $('#weather-legend-toggle').addEventListener('click', () => toggleWeatherLegend());
  $('#weather-legend-close').addEventListener('click', () => toggleWeatherLegend(false));

  // Clicking the map is how you dismiss it — it floats over the thing it is
  // about, and reaching for the × to see what you just switched on is silly.
  // The legend is NOT closed by a click on a marker's popup, which is inside
  // the map: closing the key the moment somebody uses what it describes would
  // be the one time it is most wanted.
  $('#city-map').addEventListener('click', () => toggleWeatherLegend(false));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#weather-legend').hidden) toggleWeatherLegend(false);
  });

  $('#weather-chip').addEventListener('click', () => {
    paintWeatherDialog();
    openDialog('#weather-dialog');
  });

  $('#reset-filters').addEventListener('click', () => {
    state.activeCategories = new Set(state.categories.map(c => c.slug));
    renderCategoryFilters($('#category-filters'), state.categories, state.activeCategories);
    draw();
  });

  // --- how far back
  //
  // Two things happen when the slider moves and they run at different speeds.
  // draw() repaints from rows the page already holds, so the map follows the
  // thumb as it is dragged. refresh() re-asks the database, which is the only
  // way the counts in the density circles — added up there, not here — can
  // follow at all, and asking on every step of a drag would be seven requests
  // for one gesture. So that one waits for the dragging to stop.
  let ageRefresh;
  $('#age-range').addEventListener('input', e => {
    const days = Number(e.target.value);
    if (!days || days === state.ageDays) return;
    state.ageDays = days;
    draw();
    clearTimeout(ageRefresh);
    ageRefresh = setTimeout(refresh, 250);
  });

  paintAgeEnds();

  // --- report list actions
  $('#report-list').addEventListener('click', async e => {
    const entry = e.target.closest('.report-entry');
    if (entry && !e.target.closest('.chip-action')) {
      const report = state.lastFetch.reports.find(x => String(x.id) === entry.dataset.report);
      if (report) {
        map.flyTo({ center: [report.lng, report.lat], zoom: Math.max(map.getZoom(), 15), duration: 700 });
        showPopup([report.lng, report.lat], popupHTML(report, state.categories));
      }
      return;
    }

    const support = e.target.closest('[data-support]');
    const flag = e.target.closest('[data-flag]');
    const withdraw = e.target.closest('[data-withdraw]');
    try {
      if (support) {
        const id = support.dataset.support;
        state.supported.has(id) ? await removeSupport(id) : await addSupport(id);
        state.supported.has(id) ? state.supported.delete(id) : state.supported.add(id);
        await refresh();
      } else if (flag) {
        await flagReport(flag.dataset.flag, 'wrong');
        toast(t('toast.flagged'));
      } else if (withdraw) {
        if (!confirm(t('profile.withdrawAsk'))) return;
        await withdrawReport(withdraw.dataset.withdraw);
        toast(t('toast.withdrawn'));
        await refresh();
      }
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  // --- dialogs
  document.addEventListener('click', e => {
    const closer = e.target.closest('[data-close]');
    if (closer) document.getElementById(closer.dataset.close)?.close();
    if (e.target.closest('[data-open-auth]')) openDialog('#auth-dialog');
  });

  $('#auth-button').addEventListener('click', async () => {
    if (signedIn()) { await signOut(); toast(t('toast.signedOut')); }
    else openDialog('#auth-dialog');
  });

  // --- profile
  $('#profile-button').addEventListener('click', openProfile);

  // Typing DELETE is the guard. A button this final should take more than a
  // mis-tap, and a second "are you sure" is just another thing to tap through.
  const deleteButton = $('#delete-account');
  const deleteField = $('#delete-confirm');
  const syncDeleteButton = () => {
    deleteButton.disabled = deleteField.value.trim().toUpperCase() !== 'DELETE';
  };
  syncDeleteButton();
  deleteField.addEventListener('input', syncDeleteButton);

  deleteButton.addEventListener('click', async () => {
    if (deleteField.value.trim().toUpperCase() !== 'DELETE') return;
    deleteButton.disabled = true; deleteButton.textContent = t('profile.closing');
    try {
      await deleteMyAccount();
      $('#profile-dialog').close();
      await signOut();
      toast(t('toast.accountClosed'));
      await refresh();
    } catch (err) {
      deleteButton.textContent = t('profile.closeButton');
      syncDeleteButton();
      toast(err.message, { error: true });
    }
  });

  $('#profile-signout').addEventListener('click', async () => {
    $('#profile-dialog').close();
    await signOut();
    toast(t('toast.signedOut'));
  });

  $('#profile-stats').addEventListener('click', e => {
    const tile = e.target.closest('[data-stat]');
    if (tile) showStat(tile.dataset.stat);
  });
  $('#stat-back').addEventListener('click', () => showStat('filed'));

  const entryOf = (id) => $(`.profile-report[data-report="${CSS.escape(id)}"]`);

  $('#profile-reports').addEventListener('click', async e => {
    const show = e.target.closest('[data-show]');
    if (show) { showReportOnMap(show.dataset.show); return; }

    // Withdrawing asks in the page rather than through a browser confirm box,
    // which on a phone is a grey strip at the top that is easy to dismiss
    // without reading.
    const ask = e.target.closest('[data-withdraw]');
    if (ask) {
      const entry = entryOf(ask.dataset.withdraw);
      entry.querySelector('[data-confirm]').hidden = false;
      entry.querySelector('.report-actions').hidden = true;
      return;
    }
    const no = e.target.closest('[data-withdraw-no]');
    if (no) {
      const entry = entryOf(no.dataset.withdrawNo);
      entry.querySelector('[data-confirm]').hidden = true;
      entry.querySelector('.report-actions').hidden = false;
      return;
    }
    const yes = e.target.closest('[data-withdraw-yes]');
    if (yes) {
      yes.disabled = true;
      try {
        await withdrawReport(yes.dataset.withdrawYes);
        toast(t('toast.withdrawn'));
        await Promise.all([loadProfile(), refresh()]);
      } catch (err) {
        yes.disabled = false;
        toast(err.message, { error: true });
      }
      return;
    }

    // Your confirmation on somebody else's report is the one thing there that
    // is yours, so it is the one thing you can take back.
    const unconfirm = e.target.closest('[data-unconfirm]');
    if (unconfirm) {
      unconfirm.disabled = true;
      try {
        const id = unconfirm.dataset.unconfirm;
        await removeSupport(id);
        state.supported.delete(id);
        profile.confirmed = null;
        await Promise.all([loadProfile().then(() => showStat('given')), refresh()]);
        toast(t('toast.confirmationRemoved'));
      } catch (err) {
        unconfirm.disabled = false;
        toast(err.message, { error: true });
      }
      return;
    }

    const find = e.target.closest('[data-find]');
    if (find) {
      const form = entryOf(find.dataset.find).querySelector('[data-edit-form]');
      const status = form.querySelector('[data-pin-status]');
      const query = form.querySelector('input[name="address"]').value.trim();
      if (!query) { toast(t('toast.typeAddress'), { error: true }); return; }
      status.textContent = t('profile.edit.looking');
      try {
        const [place] = await searchPlaces(query, 1);
        if (!place) { status.textContent = t('toast.needAddress'); return; }
        const detail = await describePoint(place.lat, place.lng);
        // Moving a report is the same claim as filing one, so it answers to
        // the same rule: not into the sea, not into the ice.
        const refusal = outsideBounds(place.lat) ? 'toast.pinPolar' : refusePin(detail);
        if (refusal) { status.textContent = t(refusal); return; }
        form.dataset.lat = place.lat;
        form.dataset.lng = place.lng;
        form.dataset.city = detail.city ?? '';
        form.dataset.country = detail.countryCode ?? '';
        form.dataset.label = detail.address ?? place.label ?? query;
        status.textContent = t('profile.edit.movedTo', { place: form.dataset.label });
        status.classList.add('is-set');
      } catch (err) {
        status.textContent = err.message;
      }
      return;
    }

    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const entry = entryOf(edit.dataset.edit);
      entry.querySelector('[data-edit-form]').hidden = false;
      entry.querySelector('.report-actions').hidden = true;
      entry.querySelector('input[name="headline"]').focus();
      return;
    }
    const cancel = e.target.closest('[data-edit-cancel]');
    if (cancel) {
      const entry = entryOf(cancel.dataset.editCancel);
      entry.querySelector('[data-edit-form]').hidden = true;
      entry.querySelector('.report-actions').hidden = false;
    }
  });

  $('#profile-reports').addEventListener('change', e => {
    const retime = e.target.closest('input[name="retime"]');
    if (retime) retime.closest('form').querySelector('[data-when]').hidden = !retime.checked;
    const remove = e.target.closest('input[name="remove"]');
    if (remove) remove.closest('form').querySelector('[data-where]').hidden = !remove.checked;
  });

  $('#profile-reports').addEventListener('submit', async e => {
    const form = e.target.closest('[data-edit-form]');
    if (!form) return;
    e.preventDefault();

    const id = form.dataset.editForm;
    const data = new FormData(form);
    let happenedAt = null;

    // The time only moves if you asked it to. Correcting a typo should not
    // quietly change when the scam happened.
    if (data.get('retime')) {
      const when = new Date(`${data.get('date')}T${data.get('time')}`);
      if (Number.isNaN(when.getTime())) { toast(t('toast.notATime'), { error: true }); return; }
      if (when.getTime() > Date.now() + 5 * 60000) {
        toast(t('toast.whenFuture'), { error: true }); return;
      }
      if (when.getTime() < Date.now() - REPORT_WINDOW_DAYS * 86400000) {
        toast(t('toast.whenTooOld', { days: REPORT_WINDOW_DAYS }), { error: true }); return;
      }
      happenedAt = when.toISOString();
    }

    // Only moves if you ticked the box and actually found somewhere.
    let place = null;
    if (data.get('remove')) {
      if (!form.dataset.lat) {
        toast(t('toast.findFirst'), { error: true });
        return;
      }
      place = {
        lat: Number(form.dataset.lat), lng: Number(form.dataset.lng),
        address: form.dataset.label || null,
        city: form.dataset.city || null,
        countryCode: form.dataset.country || null,
      };
    }

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true; button.textContent = t('profile.edit.saving');
    try {
      await editMyReport(id, {
        headline: data.get('headline'),
        description: data.get('description'),
        happenedAt,
        place,
      });
      toast(t('toast.reportUpdated'));
      await Promise.all([loadProfile(), refresh()]);
    } catch (err) {
      button.disabled = false; button.textContent = t('profile.edit.save');
      toast(err.message, { error: true });
    }
  });

  $('#name-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const name = $('#profile-name').value.trim();
      await saveDisplayName(name);
      state.profile = { ...(state.profile ?? {}), display_name: name || null };
      paintAvatar();
      toast(t('toast.nameSaved'));
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  $('#profile-listed').addEventListener('change', async e => {
    const wanted = e.target.checked;
    try {
      await saveListed(wanted);
      if (profile.standing) profile.standing.listed = wanted;
      // The board is other people's rows, and the one that just changed is
      // yours — so it is re-read rather than patched, and only while the
      // drawer showing it is open.
      if ($('#board-disclosure').open) loadBoard(true);
      toast(t(wanted ? 'toast.listedOn' : 'toast.listedOff'));
    } catch (err) {
      e.target.checked = !wanted;                      // say so by not moving
      toast(err.message, { error: true });
    }
  });

  // Fetched when the drawer is first opened, not when the dialog is. It is a
  // league table somebody may never look at, and a round trip for it on every
  // visit to your own profile is a round trip for nothing.
  $('#board-disclosure').addEventListener('toggle', () => {
    if ($('#board-disclosure').open) loadBoard();
  });

  // Not '#password-form': the sign-in dialog already owns that id, and
  // querySelector would hand back its form instead of this one.
  $('#profile-password-form').addEventListener('submit', async e => {
    e.preventDefault();
    const first = $('#new-password').value;
    const again = $('#new-password-again').value;
    if (first !== again) { toast(t('toast.passwordMismatch'), { error: true }); return; }

    const button = $('#save-password');
    button.disabled = true; button.textContent = t('profile.edit.saving');
    try {
      await changePassword(first);
      $('#new-password').value = '';
      $('#new-password-again').value = '';
      toast(t('toast.passwordChanged'));
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      button.disabled = false; button.textContent = t('profile.changePassword');
    }
  });

  // Password sign-in sends no email, so it works regardless of the project's
  // email rate limit — which is what blocks magic links on a free project.
  const credentials = () => ({
    email: $('#auth-email').value.trim(),
    password: $('#auth-password').value,
  });

  async function runAuth(button, label, fn) {
    const { email, password } = credentials();
    if (!email || !password) { toast(t('toast.needEmailAndPassword'), { error: true }); return; }
    const original = button.textContent;
    button.disabled = true; button.textContent = label;
    try {
      const result = await fn(email, password);
      if (result?.needsConfirmation) {
        toast(t('toast.accountCreated'));
      } else {
        toast(t('toast.welcome'));
      }
      $('#auth-dialog').close();
      $('#auth-password').value = '';
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      button.disabled = false; button.textContent = original;
    }
  }

  $('#password-form').addEventListener('submit', e => {
    e.preventDefault();
    runAuth($('#password-signin'), t('auth.signingIn'), signInWithPassword);
  });
  $('#password-signup').addEventListener('click', () =>
    runAuth($('#password-signup'), t('auth.creating'), signUpWithPassword));

  $('#magic-link').addEventListener('click', async () => {
    const email = $('#auth-email').value.trim();
    if (!email) { toast(t('toast.needEmail'), { error: true }); return; }
    const btn = $('#magic-link');
    btn.disabled = true; btn.textContent = t('auth.sending');
    try {
      await sendMagicLink(email);
      toast(t('toast.magicSent'));
      $('#auth-dialog').close();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false; btn.textContent = t('auth.magicLink');
    }
  });

  $('#google-signin').addEventListener('click', async () => {
    try { await signInWithGoogle(); }
    catch (err) { toast(err.message, { error: true }); }
  });

  // --- report form
  $('#open-report').addEventListener('click', async () => {
    // Before the sign-in gate, not after it. Asking a visitor to make an
    // account and only then telling them we do not take reports where they are
    // standing is a waste of their time and ours.
    if (await regionClosedHere()) { toast(t('toast.regionClosed'), { error: true }); return; }

    if (!signedIn()) {
      toast(t('toast.joinToReport'));
      openDialog('#auth-dialog');
      return;
    }
    primeWhenFields();
    openDialog('#report-dialog');
  });

  $('#pick-on-map').addEventListener('click', () => { $('#report-dialog').close(); startPicking(); });

  $('#find-address').addEventListener('click', async () => {
    const q = $('#scam-address').value.trim();
    if (!q) { toast(t('toast.typeStreet')); return; }
    try {
      const hits = await searchPlaces(q, 1);
      if (!hits.length) { toast(t('toast.needAddress'), { error: true }); return; }
      const place = hits[0];
      await setPin({ lat: place.lat, lng: place.lng });
      map.flyTo({ center: [place.lng, place.lat], zoom: PRECISE_ZOOM });
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  const details = $('#scam-details');
  details.addEventListener('input', () => { $('#char-now').textContent = details.value.length; });

  $('#report-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!state.pin) { toast(t('toast.needPlaceFirst'), { error: true }); return; }

    const when = whenChosen();
    if (!when) { toast(t('toast.needWhen'), { error: true }); return; }
    const now = Date.now();
    // A few minutes of slack: phone clocks drift, and somebody filing this on
    // the spot should not be told their own "now" is in the future.
    if (when.getTime() > now + 5 * 60000) {
      toast(t('toast.whenFuture'), { error: true });
      return;
    }
    if (when.getTime() < now - REPORT_WINDOW_DAYS * 86400000) {
      toast(t('toast.whenTooOld', { days: REPORT_WINDOW_DAYS }), { error: true });
      return;
    }

    const impacts = [...document.querySelectorAll('input[name="impact"]:checked')]
      .map(box => box.value);

    const btn = $('#submit-report');
    btn.disabled = true; btn.textContent = t('report.posting');
    try {
      if (state.pinPending) await state.pinPending;   // let the address land first
      // That wait is where a pin in the sea is thrown out, so the pin has to
      // be checked again rather than trusted from before the await.
      if (!state.pin) { toast(t('toast.needPlaceFirst'), { error: true }); return; }
      await submitReport({
        category: $('#scam-category').value,
        impacts,
        headline: $('#scam-headline').value,
        description: details.value,
        lat: state.pin.lat, lng: state.pin.lng,
        address: state.pin.address, city: state.pin.city, countryCode: state.pin.countryCode,
        happenedAt: when.toISOString(),
      });
      $('#report-dialog').close();
      e.target.reset();
      $('#char-now').textContent = '0';
      state.pin = null;
      state.pinPending = null;
      $('#pin-status').textContent = t('report.noPin');
      $('#pin-status').classList.remove('is-set');
      toast(t('toast.posted'));
      await refresh();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false; btn.textContent = t('report.post');
    }
  });

  // Escape cancels map-picking mode.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.picking) { stopPicking(); openDialog('#report-dialog'); }
  });
}

// Exposed for quick console poking during development, and for the tests to
// drive the parts a mouse would otherwise have to reach.
window.__ssr = { state, map, supabase, setPin };

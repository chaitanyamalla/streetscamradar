// ---------------------------------------------------------------------------
// StreetScamRadar — app wiring.
//
// The map drives everything: whenever it settles on a new view we ask the
// database what this viewer is allowed to see there, and redraw. What comes
// back differs for members and visitors, but that decision is the database's,
// not this file's.
// ---------------------------------------------------------------------------
import { isConfigured, missingConfig, PLACE_ZOOM, PRECISE_ZOOM, REPORT_WINDOW_DAYS,
         REPORT_MOVE_WINDOW_HOURS, SAFETY_MIN_ZOOM, EMERGENCY_MIN_ZOOM } from './js/config.js';
import { getCategories, fetchForBounds, submitReport, withdrawReport,
         mySupports, addSupport, removeSupport, flagReport, fetchSafetyPlaces,
         myReports, myConfirmationCount, myConfirmedReports, editMyReport,
         deleteMyAccount, getProfile, saveDisplayName, supabase } from './js/data.js';
import { initAuth, onAuthChange, sendMagicLink, signInWithPassword, signUpWithPassword,
         signInWithGoogle, signOut, enabledProviders, changePassword } from './js/auth.js';
import { searchPlaces, describePoint, locateMe } from './js/geo.js';
import { emergencyFor } from './js/emergency.js';
import { createMap, addLayers, setReports, setDensity, boundsOf, flyToPlace,
         registerCategoryIcons, registerSafetyIcons, setSafetyPlaces, setSafetyVisible,
         maplibregl } from './js/map.js';
import { esc, toast, renderCategoryFilters, renderReportList, popupHTML, safetyPopupHTML,
         setGateNote, renderProfileReports, renderProfileStats, STAT_TITLES } from './js/ui.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  categories: [],
  activeCategories: new Set(),
  lastFetch: { mode: 'summary', reports: [], cells: [], hiddenCount: 0 },
  supported: new Set(),
  picking: false,
  safetyOn: true,
  safetyPlaces: [],   // what the safety layer last loaded, for the country lookup
  pin: null,          // { lat, lng, address, city, countryCode }
  pinPending: null,   // in-flight reverse geocode for that pin
  placeLabel: 'Anywhere in the world',
};

const signedIn = () => Boolean(state.user);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const map = createMap('city-map');
let layersReady = false;
let openPopup = null;   // only one info window at a time

map.on('load', () => {
  addLayers(map);
  layersReady = true;
  if (state.categories.length) registerCategoryIcons(map, state.categories);
  registerSafetyIcons(map);
  setSafetyVisible(map, state.safetyOn);

  // A pin that opens something should look like it.
  for (const layer of ['report-point', 'report-icon', 'clusters', 'safety-icon']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => {
      map.getCanvas().style.cursor = state.picking ? 'crosshair' : '';
    });
  }

  refresh();
  refreshSafety();
});
map.on('moveend', () => scheduleRefresh());
map.on('click', onMapClick);

if (!isConfigured()) {
  $('#setup-detail').innerHTML = missingConfig() === 'key'
    ? 'Paste the <b>anon / public</b> key from Supabase → Project Settings → API into <code>js/config.js</code>, and run <code>supabase/schema.sql</code> in the SQL editor.'
    : 'Add your Supabase URL and anon key to <code>js/config.js</code>. Steps are in <code>README.md</code>.';
  $('#setup-banner').hidden = false;
}

init().catch(err => {
  console.error(err);
  toast('Something went wrong starting up. Check the browser console.', { error: true });
});

async function init() {
  await initAuth();
  onAuthChange(user => {
    state.user = user;
    paintAuthState();
    refresh();
  });

  if (isConfigured()) {
    try {
      state.categories = await getCategories();
      state.activeCategories = new Set(state.categories.map(c => c.slug));
      if (layersReady) registerCategoryIcons(map, state.categories);
      renderCategoryFilters($('#category-filters'), state.categories, state.activeCategories);
      fillCategorySelect();
    } catch (err) {
      console.error(err);
      $('#category-filters').innerHTML =
        '<p class="muted-note">Could not load categories — is schema.sql applied?</p>';
    }
  } else {
    $('#category-filters').innerHTML = '<p class="muted-note">Connect Supabase to load categories.</p>';
  }

  wireUI();
  await paintProviders();
}

/** Only show the Google button if the provider is actually switched on. */
async function paintProviders() {
  const { google } = await enabledProviders();
  $('#google-signin').hidden = !google;
}

function paintAuthState() {
  const btn = $('#auth-button');
  btn.textContent = signedIn() ? 'Sign out' : 'Sign in';
  btn.setAttribute('title', signedIn() ? state.user.email ?? 'Signed in' : 'Sign in or create an account');
  $('#profile-button').hidden = !signedIn();
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
// somewhere else closes it quietly — without that flag, the close handler
// below would treat it as the user going back and pop an entry we are relying
// on.
let historySyncing = false;

function closeQuietly(dialog) {
  if (!dialog?.open) return;
  historySyncing = true;
  try { dialog.close(); } finally { historySyncing = false; }
}

function openDialog(selector) {
  const dialog = $(selector);
  if (!dialog || dialog.open) return;
  document.querySelectorAll('dialog[open]').forEach(closeQuietly);
  dialog.showModal();
  history.pushState({ dialog: selector }, '');
}

/** Leave the dialog for the page behind it, keeping the dialog in history so
 *  back returns to it rather than to whatever you were browsing before. */
function leaveDialogForPage(selector) {
  history.pushState({ dialog: null }, '');
  closeQuietly($(selector));
}

// The X, Escape, or a button that closes: all of them mean "back".
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => {
    if (historySyncing) return;
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
const profile = { reports: [], confirmed: null, stats: null, filter: 'filed' };

async function openProfile() {
  $('#profile-email').textContent = state.user?.email ?? 'Signed in';
  $('#profile-reports').innerHTML = '<p class="empty-note">Loading…</p>';
  $('#profile-stats').innerHTML = '';
  profile.filter = 'filed';
  openDialog('#profile-dialog');
  await loadProfile();
}

async function loadProfile() {
  try {
    const [reports, given, saved] = await Promise.all([
      myReports(), myConfirmationCount(), getProfile(),
    ]);
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

    $('#profile-name').value = saved?.display_name ?? '';
    const since = saved?.created_at ?? state.user?.created_at;
    $('#profile-since').textContent = since
      ? `Member since ${new Date(since).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`
      : '';
  } catch (err) {
    console.error(err);
    $('#profile-reports').innerHTML =
      '<p class="empty-note">Could not load your reports right now.</p>';
  }
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
  $('#reports-heading').textContent = STAT_TITLES[profile.filter];
  $('#stat-back').hidden = profile.filter === 'filed';
  renderProfileReports($('#profile-reports'), reportsForFilter(),
    state.categories, REPORT_WINDOW_DAYS,
    { mine: profile.filter !== 'given', moveWindowHours: REPORT_MOVE_WINDOW_HOURS });
}

async function showStat(key) {
  profile.filter = key;
  if (key === 'given' && profile.confirmed === null) {
    $('#profile-reports').innerHTML = '<p class="empty-note">Loading…</p>';
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
  openPopup?.remove();
  openPopup = new maplibregl.Popup({ offset: 16, closeButton: true, maxWidth: '300px', className: 'report-popup' })
    .setLngLat([report.lng, report.lat])
    .setHTML(popupHTML(report, state.categories))
    .addTo(map);
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
    const result = await fetchForBounds(boundsOf(map), { signedIn: signedIn() });
    if (ticket !== inFlight) return;         // a newer request already won
    state.lastFetch = result;

    if (signedIn() && result.reports.length) {
      state.supported = await mySupports(result.reports.map(r => r.id));
      if (ticket !== inFlight) return;
    }
    draw();
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not load reports for this area.', { error: true });
  }
}

const passesFilter = (r) =>
  state.activeCategories.size === 0 || state.activeCategories.has(r.category);

// Police and hospitals are not gated by sign-in or the report window — they
// are public OSM data, the same for everyone, refreshed independently of the
// report fetch above.
let safetyInFlight = 0;
async function refreshSafety() {
  if (!layersReady || !isConfigured()) return;
  const status = $('#safety-status');

  // Forget the last view's places before fetching this one's. They also name
  // the country for the emergency numbers, and a stale set will happily name
  // the country you just panned away from.
  state.safetyPlaces = [];

  if (!state.safetyOn) { status.textContent = 'Turned off'; return; }
  if (map.getZoom() < SAFETY_MIN_ZOOM) {
    status.textContent = 'Zoom in to see police and hospitals';
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
      ? `${places.length} nearby`
      : 'None recorded in this area yet';
  } catch (err) {
    if (ticket !== safetyInFlight) return;
    console.error(err);
    status.textContent = 'Could not load these right now';
    status.classList.add('is-warning');
  }
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

let emergencyTicket = 0;
async function refreshEmergency() {
  const bar = $('#emergency-bar');

  // Zoomed out across several countries, one country's numbers would be a lie.
  if (map.getZoom() < EMERGENCY_MIN_ZOOM) { bar.hidden = true; return; }

  const ticket = ++emergencyTicket;
  const code = countryFromView() ?? await countryAtCentre();
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

function draw() {
  const { mode, reports, cells, hiddenCount } = state.lastFetch;
  const visible = reports.filter(passesFilter);

  setReports(map, visible);
  setDensity(map, mode === 'summary' ? cells : []);

  const totalCells = cells.reduce((sum, c) => sum + Number(c.total), 0);
  $('#reports-count').textContent = mode === 'summary' ? totalCells : visible.length;
  $('#reports-title').textContent = mode === 'summary' ? 'Reports in this region' : 'Reports here';
  $('#reports-scope').textContent = mode === 'member'
    ? `Last ${REPORT_WINDOW_DAYS} days · every report in view`
    : `Last ${REPORT_WINDOW_DAYS} days · public view`;

  renderReportList($('#report-list'), visible, {
    categories: state.categories, mode, supported: state.supported, signedIn: signedIn(),
  });
  setGateNote($('#gate-note'), { mode, shown: visible.length, hiddenCount, signedIn: signedIn() });

  // After the fetch, not alongside it: run in parallel and this reads the
  // previous view's reports, finds no country in them, and asks the geocoder
  // for something the answer already contained.
  refreshEmergency();
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
  const layers = ['report-icon', 'report-point', 'clusters', 'safety-icon']
    .filter(id => map.getLayer(id));
  const hits = layersReady ? map.queryRenderedFeatures(box, { layers }) : [];
  if (!hits.length) return;

  const hit = hits[0];
  if (hit.properties.cluster) {
    map.easeTo({ center: hit.geometry.coordinates, zoom: map.getZoom() + 2 });
    return;
  }

  const html = hit.layer?.id === 'safety-icon'
    ? safetyPopupHTML(hit.properties)
    : popupHTML(hit.properties, state.categories);

  openPopup?.remove();
  openPopup = new maplibregl.Popup({ offset: 16, closeButton: true, maxWidth: '300px', className: 'report-popup' })
    .setLngLat(hit.geometry.coordinates)
    .setHTML(html)
    .addTo(map);
}

function startPicking() {
  state.picking = true;
  document.getElementById('city-map').classList.add('is-picking');
  toast('Tap the exact spot on the map.');
}
function stopPicking() {
  state.picking = false;
  document.getElementById('city-map').classList.remove('is-picking');
}

function setPin({ lat, lng, label }) {
  state.pin = { lat, lng, address: null, city: null, countryCode: null };
  const status = $('#pin-status');
  status.classList.add('is-set');
  status.textContent = label ?? `Pinned at ${lat.toFixed(4)}, ${lng.toFixed(4)} — looking up the address…`;

  // Naming the place is a second network call. Keep the promise so that
  // submitting quickly waits for it rather than posting without a city.
  state.pinPending = describePoint(lat, lng).then(place => {
    if (state.pin?.lat !== lat || state.pin?.lng !== lng) return;   // pin moved on
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
  box.innerHTML = '<p class="muted-note" style="padding:12px 13px">Searching…</p>';
  try {
    const hits = await searchPlaces(query);
    if (!hits.length) {
      box.innerHTML = '<p class="muted-note" style="padding:12px 13px">No place found. Try a city, postcode or street.</p>';
      return;
    }
    box.innerHTML = hits.map((h, i) => `
      <button type="button" class="search-hit" data-hit="${i}">
        <b>${esc(h.label)}</b><span>${esc(h.detail)}</span>
      </button>`).join('');
    box.__hits = hits;
  } catch (err) {
    box.innerHTML = `<p class="muted-note" style="padding:12px 13px">${esc(err.message)}</p>`;
  }
}

function goToPlace(place) {
  flyToPlace(map, place, PLACE_ZOOM);
  state.placeLabel = place.label;
  $('#place-label').textContent = place.label;
  $('#search-results').hidden = true;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function fillCategorySelect() {
  const sel = $('#scam-category');
  sel.innerHTML = state.categories
    .map(c => `<option value="${esc(c.slug)}">${esc(c.glyph)} ${esc(c.label)}</option>`).join('');
}

function wireUI() {
  // --- search
  $('#place-form').addEventListener('submit', e => { e.preventDefault(); runSearch($('#place-search').value); });
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
      const here = await locateMe();
      map.flyTo({ center: [here.lng, here.lat], zoom: PLACE_ZOOM, duration: 900 });
      const place = await describePoint(here.lat, here.lng);
      state.placeLabel = place.label ?? 'Where you are now';
      $('#place-label').textContent = state.placeLabel;
      toast('Showing what has been reported around you.');
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  $('#place-chip').addEventListener('click', () => $('#place-search').focus());

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
  // The filter panel is a <details>: collapsed on a phone so the map gets the
  // room, always open on a wider screen where there is space for both.
  const filterPanel = $('#filter-panel');
  const roomForFilters = window.matchMedia('(min-width: 901px)');
  const syncFilterPanel = () => { filterPanel.open = roomForFilters.matches; };
  syncFilterPanel();
  roomForFilters.addEventListener('change', syncFilterPanel);

  $('#safety-toggle').addEventListener('change', e => {
    state.safetyOn = e.target.checked;
    setSafetyVisible(map, state.safetyOn);
    refreshSafety();
  });

  $('#reset-filters').addEventListener('click', () => {
    state.activeCategories = new Set(state.categories.map(c => c.slug));
    renderCategoryFilters($('#category-filters'), state.categories, state.activeCategories);
    draw();
  });

  // --- report list actions
  $('#report-list').addEventListener('click', async e => {
    const entry = e.target.closest('.report-entry');
    if (entry && !e.target.closest('.chip-action')) {
      const report = state.lastFetch.reports.find(x => String(x.id) === entry.dataset.report);
      if (report) {
        map.flyTo({ center: [report.lng, report.lat], zoom: Math.max(map.getZoom(), 15), duration: 700 });
        openPopup?.remove();
        openPopup = new maplibregl.Popup({ offset: 16, closeButton: true, maxWidth: '300px', className: 'report-popup' })
          .setLngLat([report.lng, report.lat])
          .setHTML(popupHTML(report, state.categories))
          .addTo(map);
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
        toast('Flagged for review. Thank you.');
      } else if (withdraw) {
        if (!confirm('Remove your report from the map? This cannot be undone.')) return;
        await withdrawReport(withdraw.dataset.withdraw);
        toast('Your report has been withdrawn.');
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
    if (signedIn()) { await signOut(); toast('Signed out.'); }
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
    deleteButton.disabled = true; deleteButton.textContent = 'Closing…';
    try {
      await deleteMyAccount();
      $('#profile-dialog').close();
      await signOut();
      toast('Your account and reports have been removed.');
      await refresh();
    } catch (err) {
      deleteButton.textContent = 'Close my account permanently';
      syncDeleteButton();
      toast(err.message, { error: true });
    }
  });

  $('#profile-signout').addEventListener('click', async () => {
    $('#profile-dialog').close();
    await signOut();
    toast('Signed out.');
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
        toast('Your report has been withdrawn.');
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
        toast('Confirmation removed.');
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
      if (!query) { toast('Type an address first.', { error: true }); return; }
      status.textContent = 'Looking…';
      try {
        const [place] = await searchPlaces(query, 1);
        if (!place) { status.textContent = 'Could not find that address.'; return; }
        const detail = await describePoint(place.lat, place.lng);
        form.dataset.lat = place.lat;
        form.dataset.lng = place.lng;
        form.dataset.city = detail.city ?? '';
        form.dataset.country = detail.countryCode ?? '';
        form.dataset.label = detail.address ?? place.label ?? query;
        status.textContent = `Will move to ${form.dataset.label}`;
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
      if (Number.isNaN(when.getTime())) { toast('That is not a time.', { error: true }); return; }
      if (when.getTime() > Date.now() + 5 * 60000) {
        toast('That is in the future.', { error: true }); return;
      }
      if (when.getTime() < Date.now() - REPORT_WINDOW_DAYS * 86400000) {
        toast(`Reports drop off the map after ${REPORT_WINDOW_DAYS} days.`, { error: true }); return;
      }
      happenedAt = when.toISOString();
    }

    // Only moves if you ticked the box and actually found somewhere.
    let place = null;
    if (data.get('remove')) {
      if (!form.dataset.lat) {
        toast('Press Find to choose the new place first.', { error: true });
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
    button.disabled = true; button.textContent = 'Saving…';
    try {
      await editMyReport(id, {
        headline: data.get('headline'),
        description: data.get('description'),
        happenedAt,
        place,
      });
      toast('Report updated.');
      await Promise.all([loadProfile(), refresh()]);
    } catch (err) {
      button.disabled = false; button.textContent = 'Save changes';
      toast(err.message, { error: true });
    }
  });

  $('#name-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await saveDisplayName($('#profile-name').value.trim());
      toast('Name saved.');
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  // Not '#password-form': the sign-in dialog already owns that id, and
  // querySelector would hand back its form instead of this one.
  $('#profile-password-form').addEventListener('submit', async e => {
    e.preventDefault();
    const first = $('#new-password').value;
    const again = $('#new-password-again').value;
    if (first !== again) { toast('Those two do not match.', { error: true }); return; }

    const button = $('#save-password');
    button.disabled = true; button.textContent = 'Saving…';
    try {
      await changePassword(first);
      $('#new-password').value = '';
      $('#new-password-again').value = '';
      toast('Password changed. It works from your next sign-in.');
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      button.disabled = false; button.textContent = 'Change password';
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
    if (!email || !password) { toast('Enter an email and a password first.', { error: true }); return; }
    const original = button.textContent;
    button.disabled = true; button.textContent = label;
    try {
      const result = await fn(email, password);
      if (result?.needsConfirmation) {
        toast('Account created — check your email to confirm it before signing in.');
      } else {
        toast('Signed in.');
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
    runAuth($('#password-signin'), 'Signing in…', signInWithPassword);
  });
  $('#password-signup').addEventListener('click', () =>
    runAuth($('#password-signup'), 'Creating…', signUpWithPassword));

  $('#magic-link').addEventListener('click', async () => {
    const email = $('#auth-email').value.trim();
    if (!email) { toast('Enter your email address first.', { error: true }); return; }
    const btn = $('#magic-link');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await sendMagicLink(email);
      toast('Check your email for the sign-in link.');
      $('#auth-dialog').close();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false; btn.textContent = 'Email me a sign-in link instead';
    }
  });

  $('#google-signin').addEventListener('click', async () => {
    try { await signInWithGoogle(); }
    catch (err) { toast(err.message, { error: true }); }
  });

  // --- report form
  $('#open-report').addEventListener('click', () => {
    if (!signedIn()) {
      toast('Join the community to add a report — it takes one email.');
      openDialog('#auth-dialog');
      return;
    }
    primeWhenFields();
    openDialog('#report-dialog');
  });

  $('#pick-on-map').addEventListener('click', () => { $('#report-dialog').close(); startPicking(); });

  $('#find-address').addEventListener('click', async () => {
    const q = $('#scam-address').value.trim();
    if (!q) { toast('Type a street, landmark or postcode first.'); return; }
    try {
      const hits = await searchPlaces(q, 1);
      if (!hits.length) { toast('Could not find that address.', { error: true }); return; }
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
    if (!state.pin) { toast('Choose where it happened first.', { error: true }); return; }

    const when = whenChosen();
    if (!when) { toast('Tell us when it happened.', { error: true }); return; }
    const now = Date.now();
    // A few minutes of slack: phone clocks drift, and somebody filing this on
    // the spot should not be told their own "now" is in the future.
    if (when.getTime() > now + 5 * 60000) {
      toast('That is in the future. Pick when it actually happened.', { error: true });
      return;
    }
    if (when.getTime() < now - REPORT_WINDOW_DAYS * 86400000) {
      toast(`Reports drop off the map after ${REPORT_WINDOW_DAYS} days, so this one would not show.`,
            { error: true });
      return;
    }

    const impacts = [...document.querySelectorAll('input[name="impact"]:checked')]
      .map(box => box.value);

    const btn = $('#submit-report');
    btn.disabled = true; btn.textContent = 'Posting…';
    try {
      if (state.pinPending) await state.pinPending;   // let the address land first
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
      $('#pin-status').textContent = 'No location chosen yet.';
      $('#pin-status').classList.remove('is-set');
      toast('Posted. Thank you — someone will avoid this because of you.');
      await refresh();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false; btn.textContent = 'Post to the map';
    }
  });

  // Escape cancels map-picking mode.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.picking) { stopPicking(); openDialog('#report-dialog'); }
  });
}

// Exposed for quick console poking during development.
window.__ssr = { state, map, supabase };

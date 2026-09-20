// ---------------------------------------------------------------------------
// StreetScamRadar — app wiring.
//
// The map drives everything: whenever it settles on a new view we ask the
// database what this viewer is allowed to see there, and redraw. What comes
// back differs for members and visitors, but that decision is the database's,
// not this file's.
// ---------------------------------------------------------------------------
import { isConfigured, missingConfig, PLACE_ZOOM, PRECISE_ZOOM, REPORT_WINDOW_DAYS, SAFETY_MIN_ZOOM } from './js/config.js';
import { getCategories, fetchForBounds, submitReport, withdrawReport,
         mySupports, addSupport, removeSupport, flagReport, supabase } from './js/data.js';
import { initAuth, onAuthChange, sendMagicLink, signInWithPassword, signUpWithPassword,
         signInWithGoogle, signOut, enabledProviders } from './js/auth.js';
import { searchPlaces, describePoint, locateMe } from './js/geo.js';
import { fetchSafetyPlaces, lastSafetyError } from './js/safety.js';
import { createMap, addLayers, setReports, setDensity, boundsOf, flyToPlace,
         registerCategoryIcons, registerSafetyIcons, setSafetyPlaces, setSafetyVisible,
         maplibregl } from './js/map.js';
import { esc, toast, renderCategoryFilters, renderReportList, popupHTML, safetyPopupHTML, setGateNote } from './js/ui.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  categories: [],
  activeCategories: new Set(),
  lastFetch: { mode: 'summary', reports: [], cells: [], hiddenCount: 0 },
  supported: new Set(),
  picking: false,
  safetyOn: true,
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
  if (!layersReady) return;
  const status = $('#safety-status');

  if (!state.safetyOn) { status.textContent = 'Turned off'; return; }
  if (map.getZoom() < SAFETY_MIN_ZOOM) {
    status.textContent = 'Zoom into a city to see these';
    return;
  }

  const ticket = ++safetyInFlight;
  status.textContent = 'Looking for nearby help…';
  const places = await fetchSafetyPlaces(boundsOf(map));
  if (ticket !== safetyInFlight) return;         // a newer request already won

  setSafetyPlaces(map, places);

  // Distinguish "nothing here" from "could not ask" — silently showing
  // nothing for both is what made this impossible to diagnose.
  const failure = lastSafetyError();
  status.textContent = failure
    ? 'OpenStreetMap did not answer — try again shortly'
    : places.length
      ? `${places.length} nearby, from OpenStreetMap`
      : 'None mapped in this area';
  status.classList.toggle('is-warning', Boolean(failure));
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
}

// ---------------------------------------------------------------------------
// Map interaction
// ---------------------------------------------------------------------------
function onMapClick(e) {
  if (state.picking) {
    setPin({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    stopPicking();
    $('#report-dialog').showModal();
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
    if (e.target.closest('[data-open-auth]')) $('#auth-dialog').showModal();
  });

  $('#auth-button').addEventListener('click', async () => {
    if (signedIn()) { await signOut(); toast('Signed out.'); }
    else $('#auth-dialog').showModal();
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
      $('#auth-dialog').showModal();
      return;
    }
    $('#report-dialog').showModal();
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

    const btn = $('#submit-report');
    btn.disabled = true; btn.textContent = 'Posting…';
    const hoursAgo = Number($('#scam-when').value);
    try {
      if (state.pinPending) await state.pinPending;   // let the address land first
      await submitReport({
        category: $('#scam-category').value,
        severity: document.querySelector('input[name="severity"]:checked').value,
        headline: $('#scam-headline').value,
        description: details.value,
        lat: state.pin.lat, lng: state.pin.lng,
        address: state.pin.address, city: state.pin.city, countryCode: state.pin.countryCode,
        happenedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
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
    if (e.key === 'Escape' && state.picking) { stopPicking(); $('#report-dialog').showModal(); }
  });
}

// Exposed for quick console poking during development.
window.__ssr = { state, map, supabase };

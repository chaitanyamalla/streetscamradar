// ---------------------------------------------------------------------------
// StreetScamRadar — configuration.
//
// Both values below are safe to commit: the publishable key is a *public* key,
// meant to be visible in the page. What protects your data is Row Level
// Security in supabase/schema.sql, not secrecy here.
//
// NEVER put the secret key (sb_secret_... or service_role) or the database
// password in this file. They bypass every security rule, and this repo is
// public.
//
// Find these at: Supabase dashboard -> Project Settings -> API
// ---------------------------------------------------------------------------
export const SUPABASE_URL = 'https://navjxkozsikggyxlebrd.supabase.co';

// Dashboard -> Project Settings -> API. This project uses Supabase's newer key
// system, so it is the "publishable" key rather than the older anon JWT; both
// sit in the same place and both map to the anon Postgres role.
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_jHEzRBn-7aLJvvstU45RVw_teiR7jKi';

// Is the backend wired up yet? The app still loads without it, showing a
// banner, rather than a blank page.
export const isConfigured = () =>
  Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY && SUPABASE_URL.startsWith('https://'));

/** Which piece is still missing, for the banner at the top of the page. */
export const missingConfig = () => {
  if (!SUPABASE_URL) return 'url';
  if (!SUPABASE_PUBLISHABLE_KEY) return 'key';
  return null;
};

// --- Map -------------------------------------------------------------------
// Two basemaps, one per theme. Positron over dark markers, Dark Matter under
// them — the same CARTO cartography either way, so a street is in the same
// place and the labels read the same. Anything else would be a different map.
export const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
export const MAP_STYLE_DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
export const mapStyleFor = (theme) => (theme === 'dark' ? MAP_STYLE_DARK : MAP_STYLE);

// Where the map opens before we know anything about the visitor: a wide world
// view rather than any one city, because this is a worldwide map.
export const WORLD_VIEW = { center: [10, 30], zoom: 1.6 };
export const PLACE_ZOOM = 13;   // after searching a city or town
export const PRECISE_ZOOM = 16; // after picking an exact address

// --- What signed-out visitors may see --------------------------------------
// Mirrors app_settings in the database. The database is the real gate; these
// values only decide which query the page bothers to make.
export const PUBLIC_DETAIL_MAX_SPAN = 0.35; // degrees; wider than this = counts only
export const PUBLIC_SAMPLE_LIMIT = 5;

// --- Reports ---------------------------------------------------------------
// A rolling seven days, counted back from right now — not a calendar week.
// Mirrors app_settings.report_window_days, which is the real gate; this copy
// only keeps the report form from offering a date the database would reject
// or that would never appear on the map.
export const REPORT_WINDOW_DAYS = 7;

// How far back the slider above the report list can look is the window itself,
// a whole day at a time — see the comment on it in index.html. It needs no
// constant of its own: min is one day and max is REPORT_WINDOW_DAYS.

// How long after filing a report its author may still move it. Mirrors
// app_settings.report_move_window_hours. Somebody who mis-tapped the map
// should be able to fix it; a report still movable a week later, after people
// had confirmed it, would let a confirmed warning be relocated to somewhere
// nobody ever confirmed.
export const REPORT_MOVE_WINDOW_HOURS = 24;

// Every report pin is the same colour. What differs is size: a report several
// people confirmed is drawn larger, because that is the one signal here that
// more than one person met the same thing in the same place. The form no
// longer asks for a low/medium/high rating — see map.js CONFIRM_BOOST.
export const PIN_COLOR = '#e0713c';
export const CLUSTER_COLOR = '#0f5f5a';

export const SEVERITY = {
  high:   { label: 'High',   color: '#c8322b', blurb: 'Money lost, force, or impersonated officials' },
  medium: { label: 'Medium', color: '#dd8018', blurb: 'Clear attempt, some loss or pressure' },
  low:    { label: 'Low',    color: '#3a76c4', blurb: 'Nuisance or attempted, nothing lost' },
};

// --- Geocoding -------------------------------------------------------------
// Nominatim is OpenStreetMap's free geocoder: worldwide, no API key, covers
// cities, towns, streets and postcodes. Its usage policy allows roughly one
// request per second and forbids per-keystroke autocomplete, so we only ever
// search when someone presses Enter or the button. If this site gets busy,
// swap in a paid geocoder here — that is the only place it is referenced.
export const GEOCODER = {
  search:  'https://nominatim.openstreetmap.org/search',
  reverse: 'https://nominatim.openstreetmap.org/reverse',
  minIntervalMs: 1100,
};

// Suggestions while somebody types come from Photon, not from Nominatim.
//
// Nominatim's policy says it plainly — "sending a query on every keystroke is
// not acceptable" — and we already lean on it for search and for naming the
// point behind a dropped pin. Photon is Komoot's search-as-you-type service
// built on the same OpenStreetMap data, sends Access-Control-Allow-Origin: *,
// and caches for an hour, which is what makes this possible from a page at
// all. Measured before it was wired up: half-typed queries come back in about
// a second with what people mean — "10115 berl" finds the Berlin postcode,
// "khao san" finds the road in Bangkok.
//
// SUGGEST_MIN_CHARS and SUGGEST_DEBOUNCE_MS exist to keep that a fair use of
// somebody else's free service: nothing is asked until you have typed enough
// to mean something, and not until you pause.
export const SUGGEST = {
  url: 'https://photon.komoot.io/api/',
  limit: 6,
};
export const SUGGEST_MIN_CHARS = 3;
export const SUGGEST_DEBOUNCE_MS = 280;

// --- Where the weather warnings come from --------------------------------
// Two networks, and the page has to be able to say where it is being told
// nothing. Without these lists a traveller looking at Mexico would read "no
// warnings" where the honest answer is "nobody is telling us" — a silence that
// means something very different.
//
// Kept in step with COUNTRIES in supabase/ops/fetch_weather.py by
// parity-test.mjs, which fails if the two ever drift apart.
//
// MeteoAlarm, and only MeteoAlarm. NOAA's National Weather Service was added
// for the United States and then removed: its feed is mostly marine advisories
// and county-by-county flood warnings, which on a world travel map came out as
// a United States buried under flood signs linking to a weather.gov home page.
// MeteoAlarm's own orange-and-red grading is already the filter a traveller
// needs, and one source we understand beats two we half-show.
export const METEOALARM_COUNTRIES = new Set([
  'AT', 'BA', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE',
  'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR',
  'HU', 'IE', 'IL', 'IS', 'IT', 'LT', 'LU', 'LV',
  'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT',
  'RO', 'RS', 'SE', 'SI', 'SK', 'UA'
]);

// What the page has weather for. Everything else gets "nobody is telling us"
// rather than "nothing is happening" — a silence that means something very
// different, and the panel says which.
export const WEATHER_COUNTRIES = METEOALARM_COUNTRIES;

// --- Where a report can be -----------------------------------------------
// Two rules, and they do different jobs.
//
// This band is the crude one, checked in the browser before anything is asked
// of a geocoder and again by a check constraint in the database, which is the
// one that actually holds. 60°S is the Antarctic Treaty line — the southernmost
// town on Earth, Puerto Williams, is at 55°S, and everything below 60° is
// research stations and ice. 84°N is past the northern tip of Greenland, so
// Svalbard, Tromsø and Murmansk — real places people visit — stay inside it.
//
// The precise rule is the geocoder's: a point it cannot name is open sea, and
// a point it names as a river or a bay is water. See describePoint.
export const REPORT_BOUNDS = { minLat: -60, maxLat: 84 };

// --- Safety & support --------------------------------------------------------
// Hospitals live in our own safety_places table, refreshed
// from OpenStreetMap by .github/workflows/safety-data.yml. They were once read
// live from Overpass on every pan, which tied the feature to a free, shared,
// frequently congested service; it hung more often than it answered. Nothing
// in the browser calls Overpass now.
//
// The zoom gate is only about clutter: safety pins appear at the same zoom as
// scam report icons, where the map has room for detail. SAFETY_MAX_SPAN is a
// backstop against pulling half a continent in one query — zoom is the real
// gate, and this must stay above the widest span that zoom can produce
// (1.243 deg on a 2560px screen at zoom 11.5) or the layer silently shows
// nothing on wide monitors. safety-zoom-test.js asserts exactly that, and has
// now caught this pairing going wrong twice.
// Emergency numbers appear once the view is inside one country. Lower than
// the safety pins on purpose: knowing what to dial is useful as soon as you
// are looking at a country, not only once you are down to a neighbourhood.
// Below this a single view spans several countries and one country's numbers
// would be a lie.
export const EMERGENCY_MIN_ZOOM = 5;

export const SAFETY_MIN_ZOOM = 11.5;
export const SAFETY_MAX_SPAN = 1.5;

// How many places one viewport may return. This was 400, which was invisible
// while coverage was a handful of cities and would start cutting places off
// now that whole countries are loaded: a dense city fills a zoom-11.5 viewport
// with a few hundred, and a truncated answer looks exactly like the missing
// hospitals we just finished fixing. The query has no meaningful ordering, so
// whatever it drops, it drops arbitrarily — the headroom is the point.
export const SAFETY_MAX_PLACES = 1000;

// Used by the popup glyph tint in styles.css, which mirrors this value.
// The map pins themselves are the bare emoji, with no coloured ring.
export const HOSPITAL_COLOR = '#c5382c';

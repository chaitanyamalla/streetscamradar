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
export const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

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

// --- Safety & support --------------------------------------------------------
// Police stations and hospitals live in our own safety_places table, refreshed
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

// Used by the popup glyph tints in styles.css, which mirror these values.
// The map pins themselves are the bare emoji, with no coloured ring.
export const POLICE_COLOR = '#2f5fa8';
export const HOSPITAL_COLOR = '#c5382c';

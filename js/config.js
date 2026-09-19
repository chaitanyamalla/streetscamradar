// ---------------------------------------------------------------------------
// StreetScamRadar — configuration.
//
// Paste your Supabase project values below. Both are safe to commit: the anon
// key is a *public* key and is meant to be visible in the page. What protects
// your data is Row Level Security in supabase/schema.sql, not secrecy here.
//
// NEVER put the service_role key in this file. It bypasses every security
// rule in the database, and anything in this repo is public.
//
// Find these at: Supabase dashboard -> Project Settings -> API
// ---------------------------------------------------------------------------
export const SUPABASE_URL = 'https://navjxkozsikggyxlebrd.supabase.co';

// Dashboard -> Project Settings -> API -> "anon / public" (newer projects call
// this the "publishable" key and it starts sb_publishable_). Either works.
export const SUPABASE_ANON_KEY = '';

// Is the backend wired up yet? The app still loads without it, showing a
// banner, rather than a blank page.
export const isConfigured = () =>
  Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_URL.startsWith('https://'));

/** Which piece is still missing, for the banner at the top of the page. */
export const missingConfig = () => {
  if (!SUPABASE_URL) return 'url';
  if (!SUPABASE_ANON_KEY) return 'key';
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
export const REPORT_WINDOW_DAYS = 7;

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

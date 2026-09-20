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
export const REPORT_WINDOW_DAYS = 7;

// Every report pin is the same colour. Severity is still collected on the form
// and stored, but it is self-declared, so showing it as a risk grading would
// imply an assessment nobody has made. Bring it back when there is a real
// signal to grade with — the data will be waiting.
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
// Police stations and hospitals are not our data — they are fetched live from
// OpenStreetMap's Overpass API for whatever the map is currently showing,
// never stored. No table, no sync job: an edit on OSM shows up on the next
// pan, and there is nothing here to keep current.
export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

// The layer only switches on once zoomed into a place. A country-wide query
// would be huge and slow, and "hospitals near here" only means something at
// city scale anyway — this matches the zoom where report icons take over.
export const SAFETY_MIN_ZOOM = 12;
export const SAFETY_MAX_SPAN = 0.45;        // degrees; skip the query above this
export const SAFETY_MIN_INTERVAL_MS = 1500; // be polite to the shared public instance

export const POLICE_COLOR = '#2f5fa8';
export const HOSPITAL_COLOR = '#c5382c';

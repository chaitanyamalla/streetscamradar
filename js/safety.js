// ---------------------------------------------------------------------------
// Police stations and hospitals, live from OpenStreetMap via the Overpass
// API. Nothing here is stored in our database — every call asks for exactly
// what the map is showing right now, and OSM edits show up on the next pan.
//
// The public Overpass instance is shared, so calls are throttled to a
// sensible rate, results are cached by a coarse bounding box so a small pan
// does not re-fetch, and the query is skipped outright once the visible area
// is wider than SAFETY_MAX_SPAN. This layer is a bonus, not core to the site,
// so a failure here returns an empty list rather than throwing — it should
// never be the reason a page breaks.
// ---------------------------------------------------------------------------
import { OVERPASS_MIRRORS, SAFETY_MAX_SPAN, SAFETY_MIN_INTERVAL_MS,
         SAFETY_REQUEST_TIMEOUT_MS } from './config.js';

let lastCallAt = 0;
let lastError = null;
const cache = new Map(); // coarse bbox key -> Promise<place[]>

/**
 * Why the last fetch came back empty, or null if it was fine. The layer
 * failing quietly is indistinguishable from "nothing nearby", which makes it
 * impossible to tell a broken layer from an empty one — so the page asks.
 */
export const lastSafetyError = () => lastError;

// Round to ~1km so panning a few streets over reuses the same query.
const cacheKey = (b) => [b.minLat, b.minLng, b.maxLat, b.maxLng].map(n => n.toFixed(2)).join(',');

function overpassQuery({ minLat, minLng, maxLat, maxLng }) {
  const bbox = `${minLat},${minLng},${maxLat},${maxLng}`;
  // One nwr statement with an alternation beats four separate node/way
  // statements: Overpass walks the index once instead of four times, which is
  // most of the wait on a busy public instance. `out center` still gives ways
  // and relations a single point, so a hospital mapped as a building outline
  // lands on the map like any other.
  return `[out:json][timeout:10];`
    + `nwr["amenity"~"^(hospital|police)$"](${bbox});`
    + `out center 200;`;
}

function toPlace(el) {
  const tags = el.tags ?? {};
  const lat = el.type === 'node' ? el.lat : el.center?.lat;
  const lng = el.type === 'node' ? el.lon : el.center?.lon;
  if (lat == null || lng == null) return null;
  const kind = tags.amenity === 'hospital' ? 'hospital' : 'police';
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  return {
    id: `${el.type}/${el.id}`,
    kind,
    name: tags.name || (kind === 'hospital' ? 'Hospital' : 'Police station'),
    address: street || null,
    lat, lng,
  };
}

/**
 * Fetch police stations and hospitals inside `bounds`. Always resolves —
 * an oversized area, a network error, or Overpass being briefly down all
 * just mean an empty list, never a thrown error.
 */
export async function fetchSafetyPlaces(bounds) {
  const span = Math.max(bounds.maxLat - bounds.minLat, bounds.maxLng - bounds.minLng);
  if (span > SAFETY_MAX_SPAN) return [];

  const key = cacheKey(bounds);
  if (cache.has(key)) return cache.get(key);

  const promise = (async () => {
    const wait = Math.max(0, SAFETY_MIN_INTERVAL_MS - (Date.now() - lastCallAt));
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();

    const body = 'data=' + encodeURIComponent(overpassQuery(bounds));
    let failure = null;

    for (const endpoint of OVERPASS_MIRRORS) {
      // Without this, a busy Overpass simply queues the request and never
      // answers: no error is thrown, the promise never settles, the status
      // sits on "Looking…" forever, and the mirror below is never reached.
      // A hang has to be turned into a failure for failover to mean anything.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SAFETY_REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: abort.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        lastError = null;
        return (json.elements ?? []).map(toPlace).filter(Boolean);
      } catch (err) {
        failure = err.name === 'AbortError'
          ? new Error(`timed out after ${SAFETY_REQUEST_TIMEOUT_MS / 1000}s`)
          : err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw failure ?? new Error('No Overpass mirror answered');
  })();

  cache.set(key, promise);
  // A genuinely empty area (nothing nearby) is a fact worth caching; a failed
  // request is not — clear it so the next pan into the same area retries.
  promise.catch(() => cache.delete(key));
  return promise.catch(err => {
    lastError = err.message;
    console.warn('Safety layer unavailable:', err.message);
    return [];
  });
}

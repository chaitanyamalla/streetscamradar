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
import { OVERPASS_ENDPOINT, SAFETY_MAX_SPAN, SAFETY_MIN_INTERVAL_MS } from './config.js';

let lastCallAt = 0;
const cache = new Map(); // coarse bbox key -> Promise<place[]>

// Round to ~1km so panning a few streets over reuses the same query.
const cacheKey = (b) => [b.minLat, b.minLng, b.maxLat, b.maxLng].map(n => n.toFixed(2)).join(',');

function overpassQuery({ minLat, minLng, maxLat, maxLng }) {
  const bbox = `${minLat},${minLng},${maxLat},${maxLng}`;
  return `[out:json][timeout:15];(
    node["amenity"="hospital"](${bbox});
    way["amenity"="hospital"](${bbox});
    node["amenity"="police"](${bbox});
    way["amenity"="police"](${bbox});
  );out center 200;`;
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

    const res = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(overpassQuery(bounds)),
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    const json = await res.json();
    return (json.elements ?? []).map(toPlace).filter(Boolean);
  })();

  cache.set(key, promise);
  // A genuinely empty area (nothing nearby) is a fact worth caching; a failed
  // request is not — clear it so the next pan into the same area retries.
  promise.catch(() => cache.delete(key));
  return promise.catch(err => {
    console.warn('Safety layer unavailable:', err.message);
    return [];
  });
}

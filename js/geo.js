// ---------------------------------------------------------------------------
// Turning what someone types into a place on Earth, and back again.
//
// Covers cities, towns, streets, postcodes and countries worldwide via
// Nominatim (OpenStreetMap). Its usage policy allows about one request per
// second and forbids per-keystroke autocomplete, so every call here is
// throttled and only ever fires on an explicit action.
// ---------------------------------------------------------------------------
import { GEOCODER } from './config.js';

let lastCall = 0;

async function throttled(url) {
  const wait = Math.max(0, GEOCODER.minIntervalMs - (Date.now() - lastCall));
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search is unavailable right now (${res.status}).`);
  return res.json();
}

const pickName = (p) => {
  const a = p.address ?? {};
  const local = a.city || a.town || a.village || a.municipality || a.suburb || a.county;
  const parts = [local, a.state, a.country].filter(Boolean);
  return parts.length ? parts.join(', ') : (p.display_name ?? 'Unknown place');
};

/** Search anywhere in the world. Returns up to `limit` candidate places. */
export async function searchPlaces(query, limit = 6) {
  const q = query.trim();
  if (q.length < 2) return [];
  const url = `${GEOCODER.search}?q=${encodeURIComponent(q)}&format=jsonv2`
            + `&addressdetails=1&limit=${limit}`;
  const rows = await throttled(url);
  return (rows ?? []).map(p => ({
    label: pickName(p),
    detail: p.display_name,
    lat: parseFloat(p.lat),
    lng: parseFloat(p.lon),
    countryCode: (p.address?.country_code ?? '').toUpperCase().slice(0, 2) || null,
    city: p.address?.city || p.address?.town || p.address?.village || null,
    // A whole country needs a wide view; a house number needs a tight one.
    boundingbox: p.boundingbox ? p.boundingbox.map(Number) : null,
    kind: p.addresstype || p.type || 'place',
  }));
}

/** What is at this point? Used to label a pin dropped on the map. */
export async function describePoint(lat, lng) {
  try {
    const url = `${GEOCODER.reverse}?lat=${lat}&lon=${lng}&format=jsonv2&addressdetails=1&zoom=18`;
    const p = await throttled(url);
    const a = p.address ?? {};
    const street = [a.road, a.house_number].filter(Boolean).join(' ');
    return {
      address: street || p.display_name?.split(',').slice(0, 2).join(',') || null,
      city: a.city || a.town || a.village || a.municipality || null,
      countryCode: (a.country_code ?? '').toUpperCase().slice(0, 2) || null,
      label: pickName(p),
    };
  } catch {
    // Never block a report because the geocoder is having a bad day.
    return { address: null, city: null, countryCode: null, label: null };
  }
}

/**
 * Ask the browser where the visitor is. Only ever called from an explicit
 * button press — never on page load, which would fire a permission prompt at
 * someone who has not asked for anything.
 */
export function locateMe({ timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser cannot share a location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => reject(new Error(
        err.code === err.PERMISSION_DENIED
          ? 'Location access was declined. You can still search for a place by name.'
          : 'Could not work out where you are. Try searching instead.')),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 },
    );
  });
}

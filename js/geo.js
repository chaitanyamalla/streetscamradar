// ---------------------------------------------------------------------------
// Turning what someone types into a place on Earth, and back again.
//
// Two services, for two different jobs.
//
// Nominatim (OpenStreetMap) does the searching and the reverse geocoding: it
// covers cities, towns, streets, postcodes and countries worldwide. Its usage
// policy allows about one request per second and forbids per-keystroke
// autocomplete, so every call to it here is throttled and only ever fires on
// an explicit action — a pressed button, a dropped pin.
//
// Photon (Komoot, same OpenStreetMap data) does the suggestions while someone
// types, because that is what it is built for and Nominatim asks us not to.
// ---------------------------------------------------------------------------
import { GEOCODER, SUGGEST } from './config.js';
import { t, currentLanguage } from './i18n.js';

let lastCall = 0;

async function throttled(url) {
  const wait = Math.max(0, GEOCODER.minIntervalMs - (Date.now() - lastCall));
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(t('error.searchUnavailable', { status: res.status }));
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
    // What goes back into the search box once this one is chosen. For a
    // Nominatim hit the label already names the city, region and country;
    // `detail` here is the full display_name, which is far too long to put in
    // an input somebody may want to edit.
    fullName: pickName(p),
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

/**
 * Suggestions while somebody is still typing, from Photon.
 *
 * A different service from the search above, on purpose: see SUGGEST in
 * config.js. The shapes differ too — Photon answers GeoJSON with the place
 * name and its parts in `properties`, and an `extent` of
 * [west, north, east, south] where Nominatim gives [south, north, west, east].
 * Converted here, at the edge, rather than anywhere a reader would have to
 * remember which is which.
 *
 * `signal` aborts the request when the next keystroke makes it pointless,
 * which also stops a slow answer arriving after a faster, newer one and
 * overwriting it.
 */
export async function suggestPlaces(query, { near = null, signal } = {}) {
  const q = query.trim();
  if (!q) return [];

  const params = new URLSearchParams({
    q, limit: String(SUGGEST.limit),
    // Photon returns names in the language it is asked for where it has them.
    lang: suggestLanguage(),
  });
  // Bias towards where the map already is: "haupt" should find the station in
  // the city on screen before one four countries away.
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng)) {
    params.set('lat', near.lat.toFixed(4));
    params.set('lon', near.lng.toFixed(4));
  }

  const response = await fetch(`${SUGGEST.url}?${params}`,
    { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(t('error.searchUnavailable', { status: response.status }));
  const payload = await response.json();

  const seen = new Set();
  const places = [];
  for (const feature of payload?.features ?? []) {
    const props = feature?.properties ?? {};
    const point = feature?.geometry?.coordinates;
    if (!Array.isArray(point) || point.length < 2) continue;

    const name = String(props.name ?? '').trim();
    const where = [props.city || props.district || props.county, props.state, props.country]
      .filter(Boolean).filter(part => part !== name);
    const label = name || where[0] || '';
    if (!label) continue;

    // Photon often answers with the same place twice — a node and the way
    // around it. One line each is what a list of suggestions is for.
    const key = `${label}|${where.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const extent = Array.isArray(props.extent) && props.extent.length === 4
      ? props.extent.map(Number) : null;
    places.push({
      label,
      // Photon splits the name from where it is, so the box gets both.
      fullName: [label, ...new Set(where)].join(', '),
      detail: [...new Set(where)].join(', '),
      lat: Number(point[1]),
      lng: Number(point[0]),
      countryCode: String(props.countrycode ?? '').toUpperCase().slice(0, 2) || null,
      city: props.city || props.district || null,
      // [west, north, east, south] -> [south, north, west, east]
      boundingbox: extent ? [extent[3], extent[1], extent[0], extent[2]] : null,
      kind: props.osm_value || props.type || 'place',
    });
  }
  return places;
}

/** Photon takes a two-letter language and only knows a handful; anything else
 *  it answers in the local name, which is a reasonable thing to show anyway. */
const suggestLanguage = () => {
  const code = String(currentLanguage() ?? 'en').slice(0, 2);
  return ['de', 'en', 'fr', 'it'].includes(code) ? code : 'en';
};

/**
 * The kinds of place a scam cannot be reported at, as OpenStreetMap classifies
 * them. Nothing here is a judgement about water: a pier, a bridge, a ferry
 * terminal and a harbour wall are all man-made or highway features and stay
 * perfectly reportable. This is the open water itself.
 */
const WATER = {
  natural: ['water', 'bay', 'strait', 'sea', 'ocean', 'shoal', 'reef'],
  waterway: ['river', 'stream', 'canal', 'riverbank', 'ditch', 'drain'],
  place: ['sea', 'ocean'],
};

const looksLikeWater = (p) => {
  const kind = String(p?.category ?? p?.class ?? '').toLowerCase();
  const type = String(p?.type ?? '').toLowerCase();
  return (WATER[kind] ?? []).includes(type);
};

/**
 * What is at this point? Used to label a pin dropped on the map, and to tell
 * whether a pin can be there at all.
 *
 * `onWater` is answered from what the geocoder says is there, not from a
 * coastline of ours. Nominatim covers every piece of land on Earth, so a point
 * it cannot name at all is open sea — that is what its "Unable to geocode"
 * means — and a point it names as a river or a bay is a river or a bay.
 *
 * `known` says whether the lookup worked. It matters: a geocoder having a bad
 * day must not be read as "you are in the ocean" and stop somebody filing a
 * real report.
 */
export async function describePoint(lat, lng) {
  const nowhere = { address: null, city: null, countryCode: null, label: null };
  try {
    const url = `${GEOCODER.reverse}?lat=${lat}&lon=${lng}&format=jsonv2&addressdetails=1&zoom=18`;
    const p = await throttled(url);

    // Nominatim answers 200 with an error body for a point with nothing on it.
    if (!p || p.error || !p.address) return { ...nowhere, known: true, onWater: true };

    const a = p.address;
    const street = [a.road, a.house_number].filter(Boolean).join(' ');
    const countryCode = (a.country_code ?? '').toUpperCase().slice(0, 2) || null;
    return {
      address: street || p.display_name?.split(',').slice(0, 2).join(',') || null,
      city: a.city || a.town || a.village || a.municipality || null,
      countryCode,
      label: pickName(p),
      known: true,
      // No country at all is international water; the rest is the feature
      // itself being water.
      onWater: !countryCode || looksLikeWater(p),
    };
  } catch {
    // Never block a report because the geocoder is having a bad day.
    return { ...nowhere, known: false, onWater: false };
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
      reject(new Error(t('error.noGeolocation')));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => reject(new Error(
        t(err.code === err.PERMISSION_DENIED
          ? 'error.locationDenied' : 'error.locationUnknown'))),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 },
    );
  });
}

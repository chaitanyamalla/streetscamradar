// ---------------------------------------------------------------------------
// Earthquakes, from USGS.
//
// This is a trip-planning signal, not an alerting service, and the difference
// runs through every decision here. It answers "is anything major happening
// where I am going", which is a question you ask before you book. It is not
// somewhere to look when a siren goes off — for that, the official source is
// linked on every hazard and the emergency numbers are already on the map.
//
// Fetched here rather than mirrored, unlike everything else on this map. USGS
// serves these with Access-Control-Allow-Origin: * and a 60-second cache —
// built to be read from a page — so there is no table of ours to go stale and
// no job to silently stop. What a reader sees is what USGS published.
//
// Only earthquakes. The other hazards come from GDACS, which gives a whole
// flood or cyclone one centroid point: "Flood in Guinea" sits at the country's
// geographic centre, not on the flooded ground, so drawing it here would put a
// marker hundreds of kilometres from the water. Those are matched by country
// instead and live in public.disaster_alerts.
// ---------------------------------------------------------------------------
import { t } from './i18n.js';

const USGS_FEEDS = [
  // Significant enough to matter anywhere on Earth, over a week.
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson',
  // Smaller, but today, and a M3 under a city is felt and talked about.
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
];
/**
 * How long an earthquake stays interesting.
 *
 * Not a safety window — the shaking is long over. It is how long "there was a
 * big earthquake here" is still something you would want to know before
 * arriving, which is roughly while the aftershocks and the disruption last.
 */
const QUAKE_DAYS = 7;

const iso = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * USGS `time` is epoch milliseconds; GDACS sends ISO strings. Two units in one
 * feature set is exactly what put every travel advisory in January 1970, so
 * each source's unit is converted at its own edge and never guessed at.
 */
const fromEpochMillis = (millis) => iso(Number(millis));

async function getJSON(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/** Earthquakes, newest first, deduped across the two feeds by USGS id. */
export function quakesFrom(payloads) {
  const byId = new Map();
  const oldest = Date.now() - QUAKE_DAYS * 86400000;

  for (const payload of payloads) {
    for (const feature of payload?.features ?? []) {
      const props = feature?.properties ?? {};
      const point = feature?.geometry?.coordinates;
      const id = feature?.id;
      if (!id || !Array.isArray(point) || point.length < 2) continue;

      const lng = Number(point[0]);
      const lat = Number(point[1]);
      const magnitude = Number(props.mag);
      const when = Number(props.time);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (!Number.isFinite(magnitude) || !Number.isFinite(when)) continue;
      if (when < oldest) continue;

      // The same event reaches both feeds; keep it once.
      if (!byId.has(id)) {
        byId.set(id, {
          id, lat, lng, kind: 'earthquake',
          magnitude: Math.round(magnitude * 10) / 10,
          // The source's own words for where it was. Not translated: it is a
          // place description from an agency, not a label of ours.
          place: String(props.place ?? '').trim(),
          at: fromEpochMillis(when),
          tsunami: props.tsunami === 1 || props.tsunami === '1',
          url: typeof props.url === 'string' ? props.url : null,
        });
      }
    }
  }
  return [...byId.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

/**
 * Earthquakes, fetched straight from USGS.
 *
 * One feed failing is a feed that is missing, not an error: the week's
 * significant quakes are worth showing even if today's smaller ones did not
 * arrive, and neither is a reason to interrupt somebody reading a scam map.
 *
 * `known` is said plainly so the UI can tell "nothing happened" apart from "we
 * could not find out", which are very different things to show a traveller.
 */
export async function fetchQuakes() {
  const results = await Promise.allSettled(USGS_FEEDS.map(getJSON));
  for (const result of results) {
    if (result.status === 'rejected') console.warn('USGS feed unavailable:', result.reason);
  }
  const payloads = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  return { quakes: payloads.length ? quakesFrom(payloads) : [], known: payloads.length > 0 };
}

/** The quakes inside a map view. */
export const quakesIn = (quakes, bounds) => quakes.filter(q =>
  q.lat >= bounds.minLat && q.lat <= bounds.maxLat
  && q.lng >= bounds.minLng && q.lng <= bounds.maxLng);

/** How loudly to draw an earthquake. Magnitude is logarithmic, and a reader
 *  scanning a map needs the difference between "felt it" and "it made the
 *  news" faster than they need a decimal. */
export const quakeTone = (magnitude) =>
  (magnitude >= 6 ? 'severe' : magnitude >= 4.5 ? 'notice' : 'minor');

/** "M 5.2 — 43 km N of Chase, Alaska" */
export const quakeTitle = (quake) =>
  [t('hazard.magnitude', { m: quake.magnitude.toFixed(1) }), quake.place]
    .filter(Boolean).join(' — ');

export const hazardLabel = (kind) => t(`hazard.kind.${kind}`);

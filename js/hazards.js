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

/**
 * Which earthquakes are worth a traveller's attention.
 *
 * The ground moves constantly — USGS records thousands of quakes a week — and
 * a map that shows all of them teaches people to ignore it. So this asks for
 * two narrow feeds rather than everything:
 *
 *   significant_month  USGS's own judgement of what mattered: magnitude
 *                      weighted by how many people felt it and what it did.
 *                      A quake that made the news stays for a month, because
 *                      the damage and the aftershocks outlast the shaking.
 *
 *   4.5_week           the ordinary threshold for "felt widely, sometimes
 *                      damaging". Below M4.5 an earthquake is a local event
 *                      that a visitor would not notice, and there are hundreds
 *                      of them a day.
 *
 * The M2.5 daily feed used to be here. It was dropped for exactly the reason
 * above: it is the background hum of a working planet, not trip-planning
 * information.
 */
const USGS_FEEDS = [
  { url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson',
    days: 30 },
  { url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson',
    days: 7 },
];

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

/**
 * Earthquakes, newest first, deduped across the two feeds by USGS id.
 *
 * Each feed carries its own window: `{ payload, days }`. A significant quake
 * is worth knowing about for a month; an ordinary M4.5 is not, and mixing the
 * two windows would either drop the big ones early or keep the small ones for
 * weeks.
 */
export function quakesFrom(feeds) {
  const byId = new Map();

  for (const { payload, days } of feeds) {
    const oldest = Date.now() - days * 86400000;
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
  const results = await Promise.allSettled(USGS_FEEDS.map(feed => getJSON(feed.url)));
  const feeds = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') feeds.push({ payload: result.value, days: USGS_FEEDS[i].days });
    else console.warn('USGS feed unavailable:', result.reason);
  });
  return { quakes: feeds.length ? quakesFrom(feeds) : [], known: feeds.length > 0 };
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

/** Earthquakes older than this are dropped whatever feed they came from. */
export const QUAKE_MAX_DAYS = Math.max(...USGS_FEEDS.map(f => f.days));

/** "M 5.2 — 43 km N of Chase, Alaska" */
export const quakeTitle = (quake) =>
  [t('hazard.magnitude', { m: quake.magnitude.toFixed(1) }), quake.place]
    .filter(Boolean).join(' — ');

export const hazardLabel = (kind) => t(`hazard.kind.${kind}`);

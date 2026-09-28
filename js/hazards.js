// ---------------------------------------------------------------------------
// Natural hazards: earthquakes from USGS, everything else from GDACS.
//
// This is a trip-planning signal, not an alerting service, and the difference
// runs through every decision here. It answers "is anything major happening
// where I am going", which is a question you ask before you book. It is not
// somewhere to look when a siren goes off — for that, the official source is
// linked on every hazard and the emergency numbers are already on the map.
//
// Nothing is mirrored
// -------------------
// Both sources send Access-Control-Allow-Origin: *, so the page fetches them
// itself. That is worth more than it sounds: there is no table to go stale, no
// job to silently stop, and no window in which we are showing yesterday's
// earthquakes as though they were today's. What you see is what the agency
// published, at the moment you looked.
//
// Two sources because they are two different shapes
// -------------------------------------------------
// USGS gives an earthquake a real position, so it is drawn where it happened.
//
// GDACS gives a whole event — a flood, a cyclone, a drought — a single
// "Point_Centroid". "Flood in Guinea" sits at Guinea's geographic centre, not
// on the flooded ground. Drawing that as a pin would be quietly wrong: someone
// looking at Conakry during that flood would see an empty map, because the
// marker is hundreds of kilometres inland. So GDACS is matched by country
// instead, the same way the emergency numbers and the travel advisory are, and
// reported as a line rather than a pin.
// ---------------------------------------------------------------------------
import { t } from './i18n.js';

const USGS_FEEDS = [
  // Significant enough to matter anywhere on Earth, over a week.
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson',
  // Smaller, but today, and a M3 under a city is felt and talked about.
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
];
const GDACS_FEED = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP';

/** GDACS event types, as its `eventtype` field spells them. */
const GDACS_KINDS = {
  EQ: 'earthquake', TC: 'cyclone', FL: 'flood',
  VO: 'volcano', DR: 'drought', WF: 'wildfire',
};

/** GDACS grades its own events. Red and Orange are worth a traveller's
 *  attention; Green is the routine background of a working planet and would
 *  make every second country look eventful. */
const WORTH_SHOWING = new Set(['Red', 'Orange']);

export const SEVERITY = { Red: 'severe', Orange: 'notice' };

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
 * GDACS events worth mentioning, keyed by the country codes they affect.
 *
 * An event can name several countries — a cyclone crossing a coast, a river
 * flooding two states — so it is indexed under each of them rather than only
 * under the one GDACS happens to call primary.
 */
export function alertsFrom(payload) {
  const byCountry = new Map();

  for (const feature of payload?.features ?? []) {
    const props = feature?.properties ?? {};
    const level = String(props.alertlevel ?? '').trim();
    if (!WORTH_SHOWING.has(level)) continue;
    if (String(props.iscurrent ?? 'true').toLowerCase() === 'false') continue;

    const kind = GDACS_KINDS[String(props.eventtype ?? '').toUpperCase()];
    if (!kind) continue;

    const alert = {
      id: `${props.eventtype}-${props.eventid}-${props.episodeid ?? 0}`,
      kind,
      severity: SEVERITY[level] ?? 'notice',
      // GDACS writes these in English; they are the source's description of
      // the event, not a label of ours, so they are shown as sent.
      name: String(props.name || props.description || '').trim(),
      country: String(props.country ?? '').trim(),
      from: iso(props.fromdate),
      to: iso(props.todate),
      url: typeof props.url === 'object' ? (props.url?.report ?? null)
        : (typeof props.url === 'string' ? props.url : null),
    };
    if (!alert.name) continue;

    for (const code of countriesOf(props)) {
      const list = byCountry.get(code) ?? [];
      // One event, one entry per country, whatever GDACS repeats.
      if (!list.some(a => a.id === alert.id)) list.push(alert);
      byCountry.set(code, list);
    }
  }
  return byCountry;
}

/** Every two-letter country code a GDACS event touches. */
function countriesOf(props) {
  const codes = new Set();
  let affected = props.affectedcountries;
  if (typeof affected === 'string') {
    try { affected = JSON.parse(affected.replace(/'/g, '"')); } catch { affected = null; }
  }
  for (const entry of Array.isArray(affected) ? affected : []) {
    const code = String(entry?.iso2 ?? '').trim().toUpperCase();
    if (code.length === 2) codes.add(code);
  }
  return codes;
}

/**
 * Everything, fetched straight from the agencies.
 *
 * A source that fails is a source that is missing, not an error: an earthquake
 * feed being down is no reason to withhold the flood warnings, and neither is
 * a reason to interrupt somebody reading a scam map.
 */
export async function fetchHazards() {
  const [quakeResults, gdacsResult] = await Promise.all([
    Promise.allSettled(USGS_FEEDS.map(getJSON)),
    Promise.allSettled([getJSON(GDACS_FEED)]),
  ]);

  const quakePayloads = quakeResults
    .filter(r => r.status === 'fulfilled').map(r => r.value);
  const gdacsPayload = gdacsResult[0].status === 'fulfilled' ? gdacsResult[0].value : null;

  for (const result of [...quakeResults, ...gdacsResult]) {
    if (result.status === 'rejected') console.warn('hazard source unavailable:', result.reason);
  }

  return {
    quakes: quakePayloads.length ? quakesFrom(quakePayloads) : [],
    alerts: gdacsPayload ? alertsFrom(gdacsPayload) : new Map(),
    // Said plainly so the UI can tell "nothing is happening" apart from
    // "we could not find out", which are very different things to show.
    quakesKnown: quakePayloads.length > 0,
    alertsKnown: gdacsPayload !== null,
  };
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

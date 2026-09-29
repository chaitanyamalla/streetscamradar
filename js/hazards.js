// ---------------------------------------------------------------------------
// Earthquakes.
//
// This is a trip-planning signal, not an alerting service, and the difference
// runs through every decision here. It answers "is anything major happening
// where I am going", which is a question you ask before you book. It is not
// somewhere to look when a siren goes off — for that, the official source is
// linked on every hazard and the emergency numbers are already on the map.
//
// The rows come from public.quake_events, our own mirror of USGS, refreshed
// twice a day. The page used to read the two USGS feeds directly — they carry
// permissive CORS and a 60-second cache and are built for it — which made
// earthquakes the one hazard with a different shape from every other, and the
// only one where a reader's browser talked to an outside service. What that
// change costs is freshness, up to twelve hours of it, and the reasoning is
// written out in supabase/ops/fetch_quakes.py rather than left implied.
//
// So this file no longer fetches or parses anything: USGS's GeoJSON is turned
// into rows once, in the refresh job, instead of in every visitor's browser.
// What is left is what the map does with those rows.
// ---------------------------------------------------------------------------
import { t } from './i18n.js';

/**
 * The oldest earthquake the map will show.
 *
 * The refresh drops anything past its feed's window already — a month for the
 * significant ones, a week for ordinary M4.5s — so this is a second fence
 * rather than the first: if the job ever stops, the map goes quiet by itself
 * instead of showing last season's earthquakes as though they were news.
 */
export const QUAKE_MAX_DAYS = 30;

/** Earthquakes too old to be worth showing, dropped whatever the table says. */
export const freshQuakes = (quakes, now = Date.now()) => {
  const oldest = now - QUAKE_MAX_DAYS * 86400000;
  return (quakes ?? []).filter(q => {
    const at = Date.parse(q.at);
    return Number.isFinite(at) && at >= oldest;
  });
};

/** Whatever sits inside a map view. Used for both the earthquakes and the
 *  GDACS events, which is why it takes anything with a lat and a lng. */
export const inBounds = (rows, bounds) => rows.filter(r =>
  r.lat >= bounds.minLat && r.lat <= bounds.maxLat
  && r.lng >= bounds.minLng && r.lng <= bounds.maxLng);

/** The quakes inside a map view. */
export const quakesIn = (quakes, bounds) => inBounds(quakes, bounds);

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

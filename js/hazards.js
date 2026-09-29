// ---------------------------------------------------------------------------
// Earthquakes.
//
// This is a trip-planning signal, not an alerting service, and the difference
// runs through every decision here. It answers "is anything major happening
// where I am going", which is a question you ask before you book. It is not
// somewhere to look when a siren goes off — for that, the official source is
// linked on every hazard and the emergency numbers are already on the map.
//
// The rows come from GDACS, in public.disaster_alerts with every other
// hazard. They used to come from USGS, read by the page on every visit; GDACS
// carries earthquakes with a magnitude, a depth, a position and its own
// impact grading, so one source does what two did.
//
// And only the ones worth a traveller's attention are stored: GDACS grades it
// Orange or Red, or it is magnitude 6 and above. The nineteen green
// magnitude-fives a hundred kilometres down that GDACS lists on an ordinary
// day are the ones nobody felt. That filtering happens once, in the refresh —
// see supabase/ops/fetch_disasters.py.
//
// So this file no longer fetches or parses anything. What is left is what the
// map does with the rows.
// ---------------------------------------------------------------------------
import { t } from './i18n.js';

/**
 * Is this hazard recent enough to draw?
 *
 * Judged on when it STARTED, because that is the age a reader sees: the popup
 * says "11 days ago", and a map whose reports stop at a week should not carry
 * a fortnight-old fire beside them.
 *
 * The cost is real and worth stating: a cyclone GDACS has tracked for fifteen
 * days and updated an hour ago leaves the map on its eighth, even though it is
 * still a storm. One window across the whole site was judged worth more than
 * the handful of long-running events that lose — and the table keeps them, so
 * this is a decision about what is drawn, not about what is known.
 *
 * A hazard with no start date is kept: that is the source telling us nothing,
 * which is not the same as telling us it is old.
 */
export const startedWithin = (row, days, now = Date.now()) => {
  const started = Date.parse(row?.from_date ?? '');
  return !Number.isFinite(started) || started >= now - days * 86400000;
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

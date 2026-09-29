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
 * Is this hazard worth drawing?
 *
 * Not "is it new" — "is it still happening". GDACS carries an event's end date
 * forward for as long as it is going, so `to_date` is the last moment the
 * agency vouched for it being live. A fire on its eleventh day has a to_date
 * from this morning; a fire that went out a fortnight ago does not.
 *
 * That is the question worth asking. An earlier version of this judged events
 * on when they STARTED, to match the seven-day window the reports use, and it
 * was wrong in the way that matters: a cyclone tracked for fifteen days and
 * updated an hour ago left the map on its eighth day while still being a
 * cyclone. A fire burning for eleven days is more relevant to somebody
 * deciding where to go than one that started yesterday, not less.
 *
 * So: still being carried forward, or new enough not to have needed it yet.
 * Dates the source did not send are not evidence of age — if GDACS tells us
 * nothing, that is not the same as telling us the thing is over.
 */
export const isLive = (row, days, now = Date.now()) => {
  const cutoff = now - days * 86400000;
  const lastKnown = Date.parse(row?.to_date ?? '');
  if (Number.isFinite(lastKnown)) return lastKnown >= cutoff;
  const started = Date.parse(row?.from_date ?? '');
  if (Number.isFinite(started)) return started >= cutoff;
  return true;
};

/**
 * Has this been going long enough that "2 days ago" would misread as stale?
 *
 * A popup saying "11 days ago" about a fire still burning tells a reader the
 * opposite of the truth. Past a day, the popup says "Ongoing since …" instead.
 */
export const runningDays = (row) => {
  const from = Date.parse(row?.from_date ?? '');
  const to = Date.parse(row?.to_date ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, (to - from) / 86400000);
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

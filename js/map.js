// ---------------------------------------------------------------------------
// The map.
//
// Reports are drawn as a clustered GeoJSON source rather than DOM markers, so
// a busy city stays readable and the browser stays fast. Size means how many
// people confirmed a report; the category is shown as a glyph in the list and
// popup, never on the pin — map label fonts have no emoji coverage.
// ---------------------------------------------------------------------------
import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm';
import { paintHazardSign } from './hazard-signs.js';
import { mapStyleFor, WORLD_VIEW, PIN_COLOR, CLUSTER_COLOR,
         SAFETY_MIN_ZOOM } from './config.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

// How much bigger a confirmed report is drawn. Confirmations are the only
// signal the site has that more than one person met the same thing in the same
// place, so they are what earns a pin size — it used to be the reporter's own
// low/medium/high guess, which nobody standing in a station can answer.
// Capped: a much-confirmed report should stand out, not swallow the street.
const CONFIRM_BOOST = ['interpolate', ['linear'],
  ['coalesce', ['get', 'support_count'], 0],
  0, 1, 1, 1.15, 3, 1.35, 10, 1.6];

/**
 * Size by zoom, multiplied by the confirmation boost at every stop.
 *
 * The obvious spelling — ['*', <zoom interpolate>, CONFIRM_BOOST] — is invalid:
 * a "zoom" expression may only be the input to the OUTERMOST step or
 * interpolate. MapLibre does not throw on that, it fires an error event and
 * silently declines to add the layer, so writing it that way left the map with
 * no report pins at all while everything else carried on working. The zoom
 * interpolate therefore stays outermost and the boost multiplies each stop.
 */
const byZoomAndConfirmations = (...pairs) => {
  const expr = ['interpolate', ['linear'], ['zoom']];
  for (let i = 0; i < pairs.length; i += 2) {
    expr.push(pairs[i], ['*', pairs[i + 1], CONFIRM_BOOST]);
  }
  return expr;
};

// Below this the map shows dots; at and above it, category icons.
export const ICON_ZOOM = 11.5;
const FALLBACK_ICON = 'scam-icon-fallback';
const HOSPITAL_ICON = 'safety-icon-hospital';
const VOLCANO_ICON = 'hazard-icon-volcano';
// Glued onto an image name for anything that has ENDED. It used to mean
// "graded Green"; Green is not carried at all now, and grey says the thing is
// over rather than that it was mild.
const DULL_SUFFIX = '-dull';

const DISASTER_ICONS = {
  flood: 'hazard-icon-flood', cyclone: 'hazard-icon-cyclone',
  wildfire: 'hazard-icon-wildfire',
  // GDACS could publish a kind we have not drawn. Better a sign that says
  // "something here" than a marker that silently fails to appear.
  unknown: 'hazard-icon-unknown',
};

// The twelve kinds a met service can warn of, in the order the database's check
// constraint lists them. Every one has a sign in js/hazard-signs.js; `flood`
// shares its sign with GDACS's floods, which is right — the same thing is
// being warned of, by a different kind of authority.
export const WEATHER_KINDS = [
  'wind', 'snow-ice', 'thunderstorm', 'fog', 'high-temperature',
  'low-temperature', 'coastal-event', 'forest-fire', 'avalanche',
  'rain', 'flood', 'rain-flood',
];
const weatherIcon = (kind) => `hazard-icon-${kind}`;

// How much bigger a hazard is drawn for the grade GDACS gave it. Only two
// grades reach the map, and a Red is the one you want to see first from across
// a continent. The fallback is the Orange size: an unrecognised grade should
// look like the ordinary case, not shrink into the background.
const GRADE_SIZE = ['match', ['get', 'severity'],
  'severe', 1.3, 1.1];

// Earthquakes are drawn in a colour used nowhere else here, so the mark cannot
// be mistaken for a scam report. See the layer for why that matters.
const QUAKE_COLOR = '#5c2d91';
const QUAKE_RING = ['case', ['get', 'ended'], '#8d949a', QUAKE_COLOR];

export function createMap(container, theme = 'light') {
  const map = new maplibregl.Map({
    container,
    style: mapStyleFor(theme),
    center: WORLD_VIEW.center,
    zoom: WORLD_VIEW.zoom,
    attributionControl: false,
    // One finger pans the map. The alternative — requiring two fingers so a
    // swipe scrolls the page — makes the map feel broken to anyone who does
    // not know the convention, and the map now takes most of the phone screen
    // with little left to scroll past. Page scrolling still works from the
    // header, the panels and everything below the map.
    cooperativeGestures: false,
  });

  if (window.ResizeObserver) {
    new ResizeObserver(() => map.resize()).observe(
      typeof container === 'string' ? document.getElementById(container) : container);
  }
  return map;
}

/**
 * Swap the basemap for the other theme, keeping where you are.
 *
 * setStyle throws away every source, layer and image on the map — they belong
 * to the style, not to the map — so the caller has to build them all again.
 * That is what `rebuild` is for, and why this is one function rather than a
 * setter: forgetting the second half leaves a basemap with nothing drawn on
 * it, which looks exactly like a map that has no reports.
 *
 * The camera survives: setStyle changes the style, not the view.
 */
export function setMapTheme(map, theme, rebuild) {
  map.setStyle(mapStyleFor(theme));
  map.once('styledata', () => rebuild?.());
}

export function addLayers(map) {
  // Clustering stops at 13 rather than 15, and groups a little less eagerly.
  //
  // A cluster sits at the mean of its members, so every time one splits the
  // circle you were looking at vanishes and two appear somewhere else. Holding
  // clusters together until zoom 15 meant that kept happening almost until the
  // last zoom step — reports appeared to jump around all the way in. Letting
  // them break apart at 13 gets to fixed, individual pins sooner, which is
  // where a reader actually wants to be.
  map.addSource('reports', { type: 'geojson', data: EMPTY, cluster: true, clusterRadius: 38, clusterMaxZoom: 13 });
  map.addSource('density', { type: 'geojson', data: EMPTY });
  map.addSource('safety', { type: 'geojson', data: EMPTY });
  map.addSource('hazards', { type: 'geojson', data: EMPTY });
  map.addSource('disasters', { type: 'geojson', data: EMPTY });
  map.addSource('weather', { type: 'geojson', data: EMPTY });

  // --- Signed-out density view: one soft circle per grid cell --------------
  map.addLayer({
    id: 'density-blob', type: 'circle', source: 'density',
    paint: {
      'circle-color': PIN_COLOR,
      'circle-opacity': 0.20,
      'circle-radius': ['interpolate', ['linear'], ['get', 'total'], 1, 14, 5, 24, 20, 38, 100, 54],
      'circle-stroke-width': 1,
      'circle-stroke-color': PIN_COLOR,
      'circle-stroke-opacity': 0.45,
    },
  });
  map.addLayer({
    id: 'density-count', type: 'symbol', source: 'density',
    layout: { 'text-field': ['to-string', ['get', 'total']], 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': '#8a3a17', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
  });

  // --- Clusters -----------------------------------------------------------
  map.addLayer({
    id: 'clusters', type: 'circle', source: 'reports', filter: ['has', 'point_count'],
    paint: {
      'circle-color': CLUSTER_COLOR,
      'circle-opacity': 0.9,
      'circle-radius': ['step', ['get', 'point_count'], 17, 10, 23, 30, 30],
      'circle-stroke-width': 3,
      'circle-stroke-color': '#ffffff',
    },
  });
  map.addLayer({
    id: 'cluster-count', type: 'symbol', source: 'reports', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': '#ffffff' },
  });

  // --- Individual reports ------------------------------------------------
  // Dots while the view is wide; category icons once you have zoomed into a
  // place, where there is room for them to mean something.
  map.addLayer({
    id: 'report-point', type: 'circle', source: 'reports',
    filter: ['!', ['has', 'point_count']], maxzoom: ICON_ZOOM,
    paint: {
      'circle-color': PIN_COLOR,
      'circle-radius': byZoomAndConfirmations(8, 6, 14, 10, 18, 14),
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#ffffff',
    },
  });

  // A soft ring under every pin, so single reports still read at low zoom.
  map.addLayer({
    id: 'report-halo', type: 'circle', source: 'reports',
    filter: ['!', ['has', 'point_count']], maxzoom: ICON_ZOOM,
    paint: {
      'circle-color': PIN_COLOR, 'circle-opacity': 0.14,
      'circle-radius': byZoomAndConfirmations(8, 12, 14, 20, 18, 28),
    },
  }, 'report-point');

  // Icons take over from ICON_ZOOM. icon-image is a placeholder until the
  // categories arrive — see registerCategoryIcons.
  map.addLayer({
    id: 'report-icon', type: 'symbol', source: 'reports',
    filter: ['!', ['has', 'point_count']], minzoom: ICON_ZOOM,
    layout: {
      'icon-image': FALLBACK_ICON,
      'icon-size': byZoomAndConfirmations(ICON_ZOOM, 0.62, 16, 0.85, 19, 1),
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  // --- Hospitals -----------------------------------------------------------
  // Only appears once zoomed into a place; registerSafetyIcons fills in the
  // real badge once the map is ready, same placeholder trick as reports.
  //
  // Police stations used to be here too. They were dropped: police come to you
  // when you call the emergency number the map already shows, while a hospital
  // is somewhere you go under your own steam for something that does not need
  // an ambulance.
  // --- Earthquakes --------------------------------------------------------
  //
  // An empty ring with a dot at its centre: the epicentre, and how far out it
  // was felt. Not a pin — nothing is there to visit — and deliberately not the
  // shape or the colour of a scam report.
  //
  // The colour is the reason this was redrawn. A filled orange-to-red circle
  // is exactly what a scam pin is, so at a glance the two were the same thing.
  // Violet appears nowhere else on this map, so a violet ring can only be an
  // earthquake, and the ring being hollow keeps the street under it readable.
  //
  // No minzoom: a M7 matters from a continent away, which is exactly the zoom
  // at which somebody is choosing where to go.
  map.addLayer({
    id: 'hazard-ring', type: 'circle', source: 'hazards',
    paint: {
      // Magnitude is logarithmic, so the radius is too, loosely. The feeds
      // start at M4.5, so the scale is drawn for the range that arrives.
      'circle-radius': ['interpolate', ['linear'], ['get', 'magnitude'],
        4, 7, 5, 11, 6, 16, 7.5, 24],
      // Grey once it is over, for the same reason the symbols are.
      'circle-color': QUAKE_RING,
      'circle-opacity': 0.09,
      'circle-stroke-width': 2.2,
      'circle-stroke-color': QUAKE_RING,
      'circle-stroke-opacity': 0.9,
    },
  });

  // The epicentre itself. Without it a big ring looks like an area rather than
  // a point, and two overlapping rings become unreadable.
  map.addLayer({
    id: 'hazard-core', type: 'circle', source: 'hazards',
    paint: {
      'circle-radius': 2.6,
      'circle-color': QUAKE_RING,
      'circle-stroke-width': 1.2,
      'circle-stroke-color': '#ffffff',
    },
  });

  // --- What the met services are warning of ---------------------------------
  //
  // A chip above the map says which country is being warned and of what, and
  // that is still the main way these are read: a warning covers counties or
  // provinces at a time, so the honest unit is a region, not a point.
  //
  // But where the feed gave a shape, its middle is drawn too. NOAA sends a
  // polygon with about a third of its alerts, and a thunderstorm sign over
  // central Texas answers "where" in a way a country chip cannot. MeteoAlarm
  // sends no shapes at all, so Europe stays chip-only until it does — the rows
  // are identical either way, and a row with no position simply is not here.
  //
  // Drawn UNDER the GDACS signs on purpose. A red cyclone and an orange wind
  // warning can sit on the same coast, and the cyclone is the one you need to
  // see first.
  map.addLayer({
    id: 'weather-icon', type: 'symbol', source: 'weather',
    layout: {
      'icon-image': ['match', ['get', 'kind'],
        ...WEATHER_KINDS.flatMap(kind => [kind, weatherIcon(kind)]),
        DISASTER_ICONS.unknown],
      // Smaller than a GDACS sign at every zoom, and visibly so. A warning is
      // about the next few hours over a county; a disaster is a disaster.
      //
      // The grade multiplies each zoom stop rather than the whole expression:
      // MapLibre only allows `zoom` as the direct input of a top-level step or
      // interpolate, so ['*', interpolate(zoom), grade] is rejected outright.
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        3, ['*', 0.30, GRADE_SIZE], 8, ['*', 0.42, GRADE_SIZE],
        14, ['*', 0.52, GRADE_SIZE]],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      // Not yet in force, so not drawn at full strength. Faded rather than
      // greyed: grey already means "this is over" everywhere else on this map,
      // and a warning that starts on Friday is the opposite of over. The popup
      // says which it is in words, because opacity is a hint, not a label.
      'icon-opacity': ['case', ['get', 'upcoming'], 0.55, 1],
    },
  });

  // --- What GDACS is tracking ----------------------------------------------
  //
  // Drawn where GDACS puts it, as a warning sign per kind. What that point MEANS
  // differs by kind, and the popup says so rather than letting the marker
  // imply more than it knows: a volcano and a wildfire are where they are, a
  // cyclone is where the storm was last placed, and a flood is
  // the centre of the area affected — which can sit well away from the water,
  // and is a region rather than a street.
  //
  // Volcanoes keep a layer of their own so they keep a switch of their own;
  // both read from the same source.
  //
  // Earthquakes are deliberately absent from this layer: they are the rings
  // above, sized by magnitude, which a symbol cannot be.
  map.addLayer({
    id: 'disaster-icon', type: 'symbol', source: 'disasters',
    filter: ['!=', ['get', 'kind'], 'volcano'],
    layout: {
      // Two images per kind: its own colour, and a grey one for anything GDACS
      // ended. The suffix is glued on rather than a second match, so a
      // kind added later cannot get one variant and forget the other.
      'icon-image': ['concat',
        ['match', ['get', 'kind'],
          'flood', DISASTER_ICONS.flood,
          'cyclone', DISASTER_ICONS.cyclone,
          'wildfire', DISASTER_ICONS.wildfire,
          DISASTER_ICONS.unknown],
        ['case', ['get', 'ended'], DULL_SUFFIX, '']],
      // Size carries how GDACS graded it, because colour is already carrying
      // which kind it is. Most of what GDACS publishes is Green — seventy-two
      // wildfires on an ordinary day — and the one Red cyclone among them has
      // to be findable without reading every popup.
      //
      // The grade multiplies each zoom stop rather than the whole expression:
      // MapLibre only allows `zoom` as the direct input of a top-level step or
      // interpolate, so ['*', interpolate(zoom), grade] is rejected outright.
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        3, ['*', 0.42, GRADE_SIZE], 8, ['*', 0.55, GRADE_SIZE], 14, ['*', 0.66, GRADE_SIZE]],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  map.addLayer({
    id: 'volcano-icon', type: 'symbol', source: 'disasters',
    filter: ['==', ['get', 'kind'], 'volcano'],
    layout: {
      'icon-image': ['concat', VOLCANO_ICON,
        ['case', ['get', 'ended'], DULL_SUFFIX, '']],
      // Size carries how GDACS graded it, because colour is already carrying
      // which kind it is. Most of what GDACS publishes is Green — seventy-two
      // wildfires on an ordinary day — and the one Red cyclone among them has
      // to be findable without reading every popup.
      //
      // The grade multiplies each zoom stop rather than the whole expression:
      // MapLibre only allows `zoom` as the direct input of a top-level step or
      // interpolate, so ['*', interpolate(zoom), grade] is rejected outright.
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        3, ['*', 0.42, GRADE_SIZE], 8, ['*', 0.55, GRADE_SIZE], 14, ['*', 0.66, GRADE_SIZE]],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  map.addLayer({
    id: 'safety-icon', type: 'symbol', source: 'safety', minzoom: SAFETY_MIN_ZOOM,
    layout: {
      'icon-image': HOSPITAL_ICON,
      // Deliberately smaller than a scam pin at every zoom. These are context,
      // not the point of the map, and at 0.8 they were the largest thing on it.
      'icon-size': ['interpolate', ['linear'], ['zoom'], SAFETY_MIN_ZOOM, 0.42, 16, 0.52, 19, 0.6],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      visibility: 'visible',
    },
  });
}

export const toFeatures = (reports) => ({
  type: 'FeatureCollection',
  features: reports.map(r => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
    properties: { ...r },
  })),
});

export const toDensity = (cells) => ({
  type: 'FeatureCollection',
  features: cells.map(c => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
    properties: { total: Number(c.total), confirmed: Number(c.confirmed ?? 0) },
  })),
});

export function setReports(map, reports) {
  map.getSource('reports')?.setData(toFeatures(reports));
}

export function setDensity(map, cells) {
  map.getSource('density')?.setData(toDensity(cells));
}

export const toSafetyFeatures = (places) => ({
  type: 'FeatureCollection',
  features: places.map(p => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    properties: { ...p },
  })),
});

export function setSafetyPlaces(map, places) {
  map.getSource('safety')?.setData(toSafetyFeatures(places));
}

export const toHazardFeatures = (quakes) => ({
  type: 'FeatureCollection',
  features: quakes.map(q => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [q.lng, q.lat] },
    properties: {
      id: q.id, kind: q.kind, magnitude: q.magnitude, tone: q.tone,
      place: q.place, at: q.at, url: q.url ?? '', tsunami: q.tsunami ? 'true' : 'false',
      severity: q.severity ?? 'notice', ended: Boolean(q.ended),
      depth_km: q.depth_km ?? '',
    },
  })),
});

export function setHazards(map, quakes) {
  map.getSource('hazards')?.setData(toHazardFeatures(quakes));
}

export const toDisasterFeatures = (rows) => ({
  type: 'FeatureCollection',
  features: rows.map(d => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [d.lng, d.lat] },
    properties: {
      id: d.event_id, kind: d.kind, name: d.name, severity: d.severity,
      // Worked out once, here, rather than in a layer expression: "has it
      // ended" needs the clock and a per-kind window, and neither is something
      // a style expression can be given.
      ended: Boolean(d.ended),
      country_code: d.country_code, from_date: d.from_date ?? '',
      to_date: d.to_date ?? '', url: d.url ?? '',
      magnitude: d.magnitude ?? '', depth_km: d.depth_km ?? '',
    },
  })),
});

export function setDisasters(map, rows) {
  map.getSource('disasters')?.setData(toDisasterFeatures(rows));
}

export const toWeatherFeatures = (rows) => ({
  type: 'FeatureCollection',
  features: rows
    // A warning with no position is not a broken row and not an error: it is
    // the normal case. It belongs to the chip, and dropping it here is how it
    // stays out of the map without being lost.
    .filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lng))
    .map(w => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [w.lng, w.lat] },
      properties: {
        id: w.warning_id, kind: w.kind, severity: w.severity,
        areas: w.areas ?? '', country_code: w.country_code,
        from_date: w.from_date ?? '', to_date: w.to_date ?? '',
        source: w.source ?? '', url: w.url ?? '',
        // Worked out here rather than in a style expression, for the same
        // reason `ended` is on the disasters: comparing a date to now needs a
        // clock, and a layer expression has none.
        upcoming: Boolean(w.upcoming),
      },
    })),
});

export function setWeather(map, rows) {
  map.getSource('weather')?.setData(toWeatherFeatures(rows));
}

// The hazard layers have no visibility switches of their own: every one of
// them draws whatever is in its source, and the panel decides what goes in.
// Two ways to hide the same marker is one way too many.

export function setSafetyVisible(map, visible) {
  if (map.getLayer?.('safety-icon')) {
    map.setLayoutProperty('safety-icon', 'visibility', visible ? 'visible' : 'none');
  }
}

export function boundsOf(map) {
  const b = map.getBounds();
  return {
    minLat: b.getSouth(), maxLat: b.getNorth(),
    minLng: b.getWest(),  maxLng: b.getEast(),
  };
}

/** Zoom to a geocoder result, using its bounding box when it has one. */
// How wide a view to fall back to when a place's own box is no use, by what
// kind of place it is. Half-spans in degrees: latitude, then longitude.
const FALLBACK_VIEW = {
  country: [7, 9.5],
  state: [3, 4], region: [3, 4], province: [3, 4], county: [3, 4],
};
const DEFAULT_VIEW = [0.3, 0.45];      // about a city

// When a box stops being a picture of the place. Both were read off what the
// geocoders actually send, not guessed — see tools/probe_search.py.
//
//   span: a box taller than 50° or wider than 150° is not one view of
//   anything. Only the wrapped ones reach it — France, the United States,
//   Russia and New Zealand all come back spanning ~360° of longitude because
//   they own something on the far side of the antimeridian. Canada (88.7°),
//   Australia (96°) and Brazil (45.4°) stay under it and keep their boxes.
//
//   off-centre: the geocoder also gives a point, and for a country that point
//   is its mainland. If the point sits outside the middle 70% of the box, the
//   box is around something the point is not in the middle of. That is what
//   catches the Netherlands (point at 96% of the way across a box drawn round
//   the Caribbean too), Chile with Easter Island, Portugal with the Azores and
//   Norway with Bouvet Island, while Canada, Brazil, Japan and India — big,
//   but in one piece — pass.
const MAX_SPAN = { lat: 50, lng: 150 };
const OFF_CENTRE = 0.7;

// A box of no width is not a broken box, it is a point — a street corner has
// one — and fitBounds already handles that by zooming to its own maximum. So
// only the span and the offset decide, and a zero span passes both as long as
// the point is where the box is.
const axisIsUseless = (low, high, point, maxSpan) => {
  const span = high - low;
  if (!Number.isFinite(span) || span < 0 || span > maxSpan) return true;
  return Math.abs(point - (low + high) / 2) > (span / 2) * OFF_CENTRE;
};

/**
 * Put a searched place on screen.
 *
 * Normally that means fitting its bounding box, which is right for a city, a
 * street or a country in one piece. But a country is not only its mainland:
 * searching France fitted a box drawn round Guadeloupe, Réunion and French
 * Polynesia as well, which is 350° of longitude, and landed the map on the
 * Gulf of Guinea. Each axis is checked on its own and replaced only if it is
 * useless, so Chile keeps its full north-south extent while losing Easter
 * Island, and Russia keeps its latitude while losing the Aleutians.
 *
 * What a giant gets is the middle of itself at a country-sized view. That is
 * the honest limit here: nothing in the answer says which part of the box is
 * the mainland, only that the point is in it.
 */
export function flyToPlace(map, place, fallbackZoom) {
  const box = place.boundingbox;
  if (!box || box.length !== 4 || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) {
    if (box && box.length === 4) {
      const [south, north, west, east] = box;
      map.fitBounds([[west, south], [east, north]], { padding: 48, maxZoom: 17, duration: 900 });
      return;
    }
    map.flyTo({ center: [place.lng, place.lat], zoom: fallbackZoom, duration: 900 });
    return;
  }

  let [south, north, west, east] = box;
  const [latHalf, lngHalf] = FALLBACK_VIEW[place.kind] ?? DEFAULT_VIEW;

  if (axisIsUseless(south, north, place.lat, MAX_SPAN.lat)) {
    south = place.lat - latHalf;
    north = place.lat + latHalf;
  }
  if (axisIsUseless(west, east, place.lng, MAX_SPAN.lng)) {
    west = place.lng - lngHalf;
    east = place.lng + lngHalf;
  }

  map.fitBounds([[west, south], [east, north]], { padding: 48, maxZoom: 17, duration: 900 });
}

export { maplibregl };

/**
 * MapLibre can only place an icon it already holds, and the glyph fonts in a
 * vector style carry no emoji, so every badge — scam category, hospital — is
 * drawn once to a canvas and handed to the map as an image.
 * Same white disc and glyph for all of them; only the ring colour differs,
 * which is what tells a report pin from a safety pin at a glance.
 */
function drawBadge(glyph, borderColor, { disc = true } = {}) {
  const size = 46, ratio = 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * ratio;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(ratio, ratio);

  const r = size / 2;
  if (disc) {
    ctx.beginPath();
    ctx.arc(r, r, r - 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = borderColor;
    ctx.stroke();
  }

  ctx.font = `${Math.round(size * (disc ? 0.46 : 0.62))}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Without the disc behind it, a glyph needs its own edge to stay legible
  // over streets and parks.
  if (!disc) {
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineJoin = 'round';
    ctx.strokeText(glyph || '\u26A0', r, r + 1);
  }

  ctx.fillText(glyph || '\u26A0', r, r + 1);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Called after the categories load. A match expression maps each slug to its
 * image with a fallback, so a category added later cannot leave a blank pin.
 */
export function registerCategoryIcons(map, categories) {
  const add = (id, glyph, color = PIN_COLOR) => {
    if (map.hasImage?.(id)) return;
    const image = drawBadge(glyph, color);
    if (image) map.addImage(id, image, { pixelRatio: 2 });
  };

  // A pin, not a warning triangle: the triangle now means a natural hazard
  // from an official feed, and a category we have no glyph for is still just
  // somebody's report.
  add(FALLBACK_ICON, '\uD83D\uDCCD');   // 📍
  categories.forEach(c => add(`scam-icon-${c.slug}`, c.glyph));

  // ['match', category, slug, image, ..., fallback]
  const expression = ['match', ['get', 'category']];
  categories.forEach(c => expression.push(c.slug, `scam-icon-${c.slug}`));
  expression.push(FALLBACK_ICON);

  if (map.getLayer?.('report-icon')) {
    map.setLayoutProperty('report-icon', 'icon-image', expression);
  }
}

/**
 * The hospital pin: the glyph on its own, no disc. A ringed circle read as a
 * heavy marker competing with the scam pins, when this is meant to sit quietly
 * in the background as context. Scam pins keep their ring, so the two kinds
 * still read apart at a glance.
 */
export function registerSafetyIcons(map) {
  const add = (id, glyph) => {
    if (map.hasImage?.(id)) return;
    const image = drawBadge(glyph, null, { disc: false });
    if (image) map.addImage(id, image, { pixelRatio: 2 });
  };
  add(HOSPITAL_ICON, '\uD83C\uDFE5');   // 🏥

  // Every hazard is a warning sign instead — see js/hazard-signs.js for why a
  // triangle and not the emoji that used to be here.
  const sign = (id, kind, dull = false) => {
    if (map.hasImage?.(id)) return;
    const image = drawSign(kind, dull);
    if (image) map.addImage(id, image, { pixelRatio: 2 });
  };
  for (const [id, kind] of [[VOLCANO_ICON, 'volcano'],
                           [DISASTER_ICONS.flood, 'flood'],
                           [DISASTER_ICONS.cyclone, 'cyclone'],
                           [DISASTER_ICONS.wildfire, 'wildfire'],
                           [DISASTER_ICONS.unknown, 'unknown']]) {
    sign(id, kind);
    sign(id + DULL_SUFFIX, kind, true);
  }

  // And the weather kinds, for the warnings that came with a position. No dull
  // variant: a weather warning is never shown as over — it is deleted when it
  // expires — and an upcoming one is faded by the layer, not greyed.
  for (const kind of WEATHER_KINDS) sign(weatherIcon(kind), kind);
}

/** A hazard sign at the size MapLibre wants it: 46px drawn at 2×. */
function drawSign(kind, dull = false) {
  const size = 46, ratio = 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * ratio;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(ratio, ratio);
  paintHazardSign(ctx, kind, size, dull);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// ---------------------------------------------------------------------------
// The map.
//
// Reports are drawn as a clustered GeoJSON source rather than DOM markers, so
// a busy city stays readable and the browser stays fast. Size means how many
// people confirmed a report; the category is shown as a glyph in the list and
// popup, never on the pin — map label fonts have no emoji coverage.
// ---------------------------------------------------------------------------
import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm';
import { MAP_STYLE, WORLD_VIEW, PIN_COLOR, CLUSTER_COLOR,
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

export function createMap(container) {
  const map = new maplibregl.Map({
    container,
    style: MAP_STYLE,
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

export function addLayers(map) {
  map.addSource('reports', { type: 'geojson', data: EMPTY, cluster: true, clusterRadius: 46, clusterMaxZoom: 15 });
  map.addSource('density', { type: 'geojson', data: EMPTY });
  map.addSource('safety', { type: 'geojson', data: EMPTY });

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
export function flyToPlace(map, place, fallbackZoom) {
  if (place.boundingbox && place.boundingbox.length === 4) {
    const [south, north, west, east] = place.boundingbox;
    map.fitBounds([[west, south], [east, north]], { padding: 48, maxZoom: 17, duration: 900 });
  } else {
    map.flyTo({ center: [place.lng, place.lat], zoom: fallbackZoom, duration: 900 });
  }
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

  add(FALLBACK_ICON, '\u26A0');
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
}

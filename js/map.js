// ---------------------------------------------------------------------------
// The map.
//
// Reports are drawn as a clustered GeoJSON source rather than DOM markers, so
// a busy city stays readable and the browser stays fast. Colour always means
// severity; the category is shown as a glyph in the list and popup, never on
// the pin — map label fonts have no emoji coverage.
// ---------------------------------------------------------------------------
import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm';
import { MAP_STYLE, WORLD_VIEW, PIN_COLOR, CLUSTER_COLOR,
         SAFETY_MIN_ZOOM, POLICE_COLOR, HOSPITAL_COLOR } from './config.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

// Below this the map shows dots; at and above it, category icons.
export const ICON_ZOOM = 11.5;
const FALLBACK_ICON = 'scam-icon-fallback';
const POLICE_ICON = 'safety-icon-police';
const HOSPITAL_ICON = 'safety-icon-hospital';
const compact = () => window.matchMedia('(max-width: 900px)').matches;

export function createMap(container) {
  const map = new maplibregl.Map({
    container,
    style: MAP_STYLE,
    center: WORLD_VIEW.center,
    zoom: WORLD_VIEW.zoom,
    attributionControl: false,
    // One finger scrolls the page, two fingers pan. Without this a map this
    // tall swallows every vertical swipe on a phone.
    cooperativeGestures: compact(),
  });

  const breakpoint = window.matchMedia('(max-width: 900px)');
  breakpoint.addEventListener('change', () => {
    const h = map.cooperativeGestures;
    if (h) breakpoint.matches ? h.enable() : h.disable();
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
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 10, 18, 14],
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
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 12, 14, 20, 18, 28],
    },
  }, 'report-point');

  // Icons take over from ICON_ZOOM. icon-image is a placeholder until the
  // categories arrive — see registerCategoryIcons.
  map.addLayer({
    id: 'report-icon', type: 'symbol', source: 'reports',
    filter: ['!', ['has', 'point_count']], minzoom: ICON_ZOOM,
    layout: {
      'icon-image': FALLBACK_ICON,
      'icon-size': ['interpolate', ['linear'], ['zoom'], ICON_ZOOM, 0.62, 16, 0.85, 19, 1],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  // --- Police & hospitals --------------------------------------------------
  // Only appears once zoomed into a place; registerSafetyIcons fills in the
  // real badges once the map is ready, same placeholder trick as reports.
  map.addLayer({
    id: 'safety-icon', type: 'symbol', source: 'safety', minzoom: SAFETY_MIN_ZOOM,
    layout: {
      'icon-image': ['match', ['get', 'kind'], 'hospital', HOSPITAL_ICON, POLICE_ICON],
      'icon-size': 0.8,
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
    properties: { total: Number(c.total), high: Number(c.high) },
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
 * vector style carry no emoji, so every badge — scam category, police,
 * hospital — is drawn once to a canvas and handed to the map as an image.
 * Same white disc and glyph for all of them; only the ring colour differs,
 * which is what tells a report pin from a safety pin at a glance.
 */
function drawBadge(glyph, borderColor) {
  const size = 46, ratio = 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * ratio;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(ratio, ratio);

  const r = size / 2;
  ctx.beginPath();
  ctx.arc(r, r, r - 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = borderColor;
  ctx.stroke();

  ctx.font = `${Math.round(size * 0.46)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
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

/** Police and hospital badges — same drawing technique, their own colours. */
export function registerSafetyIcons(map) {
  const add = (id, glyph, color) => {
    if (map.hasImage?.(id)) return;
    const image = drawBadge(glyph, color);
    if (image) map.addImage(id, image, { pixelRatio: 2 });
  };
  add(POLICE_ICON, '\uD83D\uDE93', POLICE_COLOR);     // 🚓
  add(HOSPITAL_ICON, '\uD83C\uDFE5', HOSPITAL_COLOR); // 🏥
}

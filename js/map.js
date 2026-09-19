// ---------------------------------------------------------------------------
// The map.
//
// Reports are drawn as a clustered GeoJSON source rather than DOM markers, so
// a busy city stays readable and the browser stays fast. Colour always means
// severity; the category is shown as a glyph in the list and popup, never on
// the pin — map label fonts have no emoji coverage.
// ---------------------------------------------------------------------------
import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm';
import { MAP_STYLE, WORLD_VIEW, SEVERITY } from './config.js';

const EMPTY = { type: 'FeatureCollection', features: [] };
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

  // --- Signed-out density view: one soft circle per grid cell --------------
  map.addLayer({
    id: 'density-blob', type: 'circle', source: 'density',
    paint: {
      'circle-color': ['case', ['>', ['get', 'high'], 0], SEVERITY.high.color, SEVERITY.medium.color],
      'circle-opacity': 0.22,
      'circle-radius': ['interpolate', ['linear'], ['get', 'total'], 1, 14, 5, 24, 20, 38, 100, 54],
      'circle-stroke-width': 1,
      'circle-stroke-color': ['case', ['>', ['get', 'high'], 0], SEVERITY.high.color, SEVERITY.medium.color],
      'circle-stroke-opacity': 0.45,
    },
  });
  map.addLayer({
    id: 'density-count', type: 'symbol', source: 'density',
    layout: { 'text-field': ['to-string', ['get', 'total']], 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': '#5c2018', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
  });

  // --- Clusters -----------------------------------------------------------
  map.addLayer({
    id: 'clusters', type: 'circle', source: 'reports', filter: ['has', 'point_count'],
    paint: {
      'circle-color': '#12494f',
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

  // --- Individual reports, coloured by severity ---------------------------
  map.addLayer({
    id: 'report-point', type: 'circle', source: 'reports', filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': [
        'match', ['get', 'severity'],
        'high', SEVERITY.high.color,
        'medium', SEVERITY.medium.color,
        SEVERITY.low.color,
      ],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 10, 18, 14],
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#ffffff',
    },
  });

  // A pulse ring on high-severity reports, so the eye lands there first.
  map.addLayer({
    id: 'report-halo', type: 'circle', source: 'reports',
    filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'severity'], 'high']],
    paint: {
      'circle-color': SEVERITY.high.color, 'circle-opacity': 0.16,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 13, 14, 22, 18, 30],
    },
  }, 'report-point');
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

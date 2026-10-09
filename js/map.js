// ---------------------------------------------------------------------------
// The map.
//
// Reports are drawn as a clustered GeoJSON source rather than DOM markers, so
// a busy city stays readable and the browser stays fast. Size means how many
// people confirmed a report; the category is shown as a glyph in the list and
// popup, never on the pin — map label fonts have no emoji coverage.
// ---------------------------------------------------------------------------
import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm';
import { paintHazardSign, hazardColor } from './hazard-signs.js';
import { mapStyleFor, WORLD_VIEW, PIN_COLOR, CLUSTER_COLOR,
         SAFETY_MIN_ZOOM, WHEEL_ZOOM_RATE, PINCH_ZOOM_RATE,
         DISPUTED_BORDER_COLOR, DISPUTED_BORDER_DASH, BASEMAP_SOURCE,
         BASEMAP_BOUNDARY_LAYER, BASEMAP_COUNTRY_LAYERS } from './config.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

// Our one added basemap layer, and the clause that keeps the agreed-border
// grey from drawing under its dashes. See markDisputedBorders.
const DISPUTED_LAYER = 'disputed-border';
const NOT_DISPUTED = ['!=', 'disputed', 1];

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
// A SEPARATE image id from the GDACS signs, not the same one reused. They
// collided — weatherIcon('flood') and DISASTER_ICONS.flood both resolved to
// 'hazard-icon-flood' — so a county flood warning and a continental flood
// disaster were drawn pixel-identical, and a reader clicking one reasonably
// expected the other. A warning and a disaster are different claims from
// different kinds of agency and must not share a mark.
const weatherIcon = (kind) => `weather-icon-${kind}`;

// How much bigger a hazard is drawn for the grade GDACS gave it. Only two
// grades reach the map, and a Red is the one you want to see first from across
// a continent. The fallback is the Orange size: an unrecognised grade should
// look like the ordinary case, not shrink into the background.
const GRADE_SIZE = ['match', ['get', 'severity'],
  'severe', 1.3, 1.1];

// The breathing ring around a red alert: how far it grows, and in what.
//
// The colour is the danger red the rest of the page uses for "severe", because
// a reader has already learnt it on the chips and in the popups; a new colour
// here would be a new thing to learn in the one place there is no time to.
const PULSE_MIN = 13;
const PULSE_MAX = 30;
const PULSE_MS = 2000;
const PULSE_COLOR = '#c5382c';

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

  // A wheel notch moves 1/450 of a zoom level out of the box, and a world map
  // is sixteen levels deep from a continent to a street. See WHEEL_ZOOM_RATE.
  // Guarded because the handler is absent on a map built without interaction,
  // which is what every test harness builds.
  map.scrollZoom?.setWheelZoomRate?.(WHEEL_ZOOM_RATE);
  map.scrollZoom?.setZoomRate?.(PINCH_ZOOM_RATE);

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

/**
 * Draw the basemap's disputed country borders as disputed: red and dashed.
 *
 * Why this exists. CARTO's tiles are built from OpenStreetMap, which draws a
 * disputed boundary in the same grey as an agreed one. Around Jammu & Kashmir
 * that means the Line of Control reads as a settled frontier, so the map
 * appeared to say the territory beyond it is Pakistan. It is disputed — India,
 * Pakistan and China each map it differently, and no single depiction is
 * correct everywhere.
 *
 * Why marking rather than redrawing. We cannot draw any country's claim line
 * from this basemap: across twelve points around the territory at three zooms,
 * `claimed_by` appeared on thirteen boundary features, every one of them a
 * China-India line, and `adm0_l`/`adm0_r` were empty throughout. Nothing
 * traces India's claim around Gilgit-Baltistan, so that geometry simply is not
 * in the data (tools/probe_boundaries.py reads this live and prints it). What
 * every boundary feature does carry is `disputed`. Hiding the line instead was
 * the other candidate and was rejected: there is no field saying which dispute
 * a line belongs to, so hiding would have erased Western Sahara, Crimea and
 * the Gaza and West Bank lines along with it.
 *
 * So this is worldwide and takes nobody's side. A traveller is better served
 * by a map that says "not agreed" wherever that is true than by one that
 * picks a winner or quietly drops the line.
 *
 * Country level only. Disputed state and district lines stay in the basemap's
 * own grey; inside Kashmir there are several, and reddening them all would
 * paint the region rather than mark its frontier.
 */
export function markDisputedBorders(map) {
  // Absent when the basemap has not loaded, or if CARTO renames its source.
  // Nothing to restyle then, and a thrown error here would take the whole map
  // down over cosmetics.
  if (!map.getSource?.(BASEMAP_SOURCE)) return false;
  if (map.getLayer?.(DISPUTED_LAYER)) return true;   // a rebuild, already done

  // Stop the agreed-border grey drawing underneath, so the dash reads as a
  // dash rather than as a dotted line on a solid one. Their own filters are
  // read back rather than restated: CARTO owns them, and a copy here would go
  // stale silently.
  for (const id of BASEMAP_COUNTRY_LAYERS) {
    if (!map.getLayer?.(id)) continue;
    const existing = map.getFilter?.(id);
    map.setFilter(id, existing ? ['all', existing, NOT_DISPUTED] : NOT_DISPUTED);
  }

  // Placed in the basemap's own boundary band, below its labels, which is
  // where CARTO draws its borders. Appending instead would put the dashes on
  // top of every street name on the map. Our data layers are added after this
  // one and so still sit above it.
  const labels = map.getStyle?.()?.layers?.find(layer => layer.type === 'symbol');

  map.addLayer({
    id: DISPUTED_LAYER,
    type: 'line',
    source: BASEMAP_SOURCE,
    'source-layer': BASEMAP_BOUNDARY_LAYER,
    filter: ['all', ['==', 'admin_level', 2], ['==', 'disputed', 1], ['==', 'maritime', 0]],
    paint: {
      'line-color': DISPUTED_BORDER_COLOR,
      'line-dasharray': DISPUTED_BORDER_DASH,
      // Thin at a world view, where these are hairlines among many, and clear
      // by the time a country fills the screen.
      'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.8, 6, 1.4, 10, 2.2],
      'line-opacity': 0.9,
    },
  }, labels?.id);
  return true;
}

export function addLayers(map) {
  markDisputedBorders(map);

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

  // --- Counted circles: one per grid cell, for anybody looking at a wide view
  //
  // Signed-out at any width past a city, signed-in past a region — see
  // MEMBER_DETAIL_MAX_SPAN. Read-only: they were clickable for one commit and
  // a thumb set them off by accident, so on a pointer they explain themselves
  // on hover and on a touch screen they do nothing at all.
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

  // --- The red ones, ringed ------------------------------------------------
  //
  // A red alert is the one mark on this map somebody has to find before they
  // find anything else, and size alone was not doing it: a red cyclone among
  // forty orange wind warnings is 30% bigger than its neighbours and that is
  // all. So the red ones get a ring that breathes — it grows out of the marker
  // and fades, about once every two seconds.
  //
  // Why a pulse and not a blink. A blink is either on or off, so for half of
  // every cycle the thing you are trying to draw attention to is MISSING, and
  // on a map somebody is reading that is worse than no emphasis at all. A ring
  // that grows and fades never takes the marker away.
  //
  // Only what is RED and HAPPENING. An ended disaster and a warning that starts
  // on Friday are both drawn quietly on purpose, and a ring around either would
  // undo that. Under the markers, never over them, so nothing is ever obscured
  // by its own emphasis.
  //
  // It stops entirely for a reader who has asked for less motion — see
  // startPulse, where that is checked rather than assumed.
  for (const [id, source, extra] of [
    ['disaster-pulse', 'disasters', ['!', ['get', 'ended']]],
    ['weather-pulse', 'weather', ['!', ['get', 'upcoming']]],
  ]) {
    map.addLayer({
      id, type: 'circle', source,
      filter: ['all', ['==', ['get', 'severity'], 'severe'], extra],
      paint: {
        'circle-radius': PULSE_MIN,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 2.4,
        'circle-stroke-color': PULSE_COLOR,
        'circle-stroke-opacity': 0.75,
      },
    });
  }

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
      // The fallback is a weather tile as well. Reaching for the GDACS
      // "unknown" sign here would reintroduce exactly the mix-up this
      // separation exists to prevent.
      'icon-image': ['match', ['get', 'kind'],
        ...WEATHER_KINDS.flatMap(kind => [kind, weatherIcon(kind)]),
        weatherIcon('wind')],
      // Smaller than a GDACS sign at every zoom, and visibly so. A warning is
      // about the next few hours over a county; a disaster is a disaster.
      //
      // The grade multiplies each zoom stop rather than the whole expression:
      // MapLibre only allows `zoom` as the direct input of a top-level step or
      // interpolate, so ['*', interpolate(zoom), grade] is rejected outright.
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        3, ['*', 0.34, GRADE_SIZE], 8, ['*', 0.48, GRADE_SIZE],
        14, ['*', 0.60, GRADE_SIZE]],
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

/**
 * Run the ring around the red alerts.
 *
 * MapLibre animates nothing on its own, so the radius and the fade are set on
 * every frame. That sounds expensive and is not: two paint properties on two
 * layers, and the layers are empty unless something red is actually happening,
 * which on most days is nothing at all.
 *
 * REDUCED MOTION IS HONOURED, and honoured properly — the ring becomes a plain
 * static circle rather than disappearing. Somebody who has asked their machine
 * for less movement has not asked to be told less, and the emphasis is the
 * point; only the movement is negotiable. The preference is re-read when it
 * changes, so turning it on stops the animation without a reload.
 *
 * It also runs ONLY while something red is on the map, which on most days is
 * never. A requestAnimationFrame loop that wakes sixty times a second to animate
 * nothing is a flat battery on a phone in somebody's pocket, and the page knows
 * perfectly well whether it drew anything red — so it says so.
 *
 * Returns { stop, setActive }: stop for the theme rebuild, which throws the
 * layers away and would leave a loop writing to nothing, and setActive for the
 * painters, which know what they just drew.
 */
export function startPulse(map) {
  const calmer = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let frame = null;
  let stopped = false;
  let anyRed = false;

  const paint = (radius, opacity) => {
    for (const id of ['disaster-pulse', 'weather-pulse']) {
      if (!map.getLayer?.(id)) continue;
      map.setPaintProperty(id, 'circle-radius', radius);
      map.setPaintProperty(id, 'circle-stroke-opacity', opacity);
    }
  };

  const tick = (now) => {
    if (stopped || !anyRed) { frame = null; return; }
    // Sawtooth: grow from PULSE_MIN to PULSE_MAX while fading out, then start
    // again. Eased so it leaves quickly and arrives slowly, which reads as a
    // pulse rather than as something sliding.
    const phase = (now % PULSE_MS) / PULSE_MS;
    const eased = 1 - (1 - phase) ** 2;
    paint(PULSE_MIN + (PULSE_MAX - PULSE_MIN) * eased, 0.75 * (1 - phase));
    frame = requestAnimationFrame(tick);
  };

  const settle = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    if (stopped) return;
    if (calmer?.matches) {
      // Still ringed, just not moving.
      paint(PULSE_MIN + 4, 0.8);
    } else if (anyRed) {
      frame = requestAnimationFrame(tick);
    }
  };

  settle();
  calmer?.addEventListener?.('change', settle);

  return {
    stop() {
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      frame = null;
      calmer?.removeEventListener?.('change', settle);
    },
    // Called by whoever just drew the markers. Idempotent, and cheap enough to
    // call on every pan: it only does anything when the answer changes.
    setActive(on) {
      if (anyRed === Boolean(on)) return;
      anyRed = Boolean(on);
      settle();
    },
  };
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
      // GDACS's own measurement, in its own words. The one line in the popup
      // that is a fact about the event rather than a sentence about the map.
      measure: d.measure ?? '',
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
        // Whether the point is the area or only the country it is in. The popup
        // says which, and without this it cannot: a style expression has no use
        // for it, but the popup is the whole reason it exists.
        place_kind: w.place_kind ?? '',
        // How many more warnings of this kind share this exact point. Several
        // do whenever the point is a country's middle, which is most of them.
        also: Number(w.also ?? 0),
        // Moved a little off its point so the others sharing it can be seen and
        // clicked. The popup says so; nothing should read the exact spot.
        fanned: Boolean(w.fanned),
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

  // And the weather kinds, for the warnings that came with a position. Drawn as
  // tiles rather than bare signs, under their own image ids, so a weather
  // warning can never again be mistaken for a GDACS disaster.
  //
  // No dull variant: a weather warning is never shown as over — it is deleted
  // when it expires — and one that has not started yet is faded by the layer
  // rather than greyed, because grey means "over" everywhere else here.
  for (const kind of WEATHER_KINDS) {
    const id = weatherIcon(kind);
    if (map.hasImage?.(id)) continue;
    const image = drawWeatherSign(kind);
    if (image) map.addImage(id, image, { pixelRatio: 2 });
  }
}

/**
 * A weather warning's marker: the glyph on a small rounded tile.
 *
 * Deliberately a different FAMILY of mark from the GDACS signs, which stand on
 * the map bare. The two were identical and that was the bug: a flood warning for
 * one county and a flood disaster across a country looked the same and said
 * different things. A tile is also what a forecast looks like everywhere else a
 * reader has seen one, so it carries "this is the weather" without a word.
 *
 * The plate takes its colours from the page's own tokens, so it is light on the
 * light basemap and dark on the dark one without this file knowing which is up —
 * the images are re-registered on every style rebuild anyway.
 */
function drawWeatherSign(kind) {
  const size = 40, ratio = 2, pad = 2, r = 9;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * ratio;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(ratio, ratio);

  const box = size - pad * 2;
  ctx.beginPath();
  ctx.moveTo(pad + r, pad);
  ctx.arcTo(pad + box, pad, pad + box, pad + box, r);
  ctx.arcTo(pad + box, pad + box, pad, pad + box, r);
  ctx.arcTo(pad, pad + box, pad, pad, r);
  ctx.arcTo(pad, pad, pad + box, pad, r);
  ctx.closePath();
  ctx.fillStyle = cssToken('--surface', '#ffffff');
  ctx.fill();
  // The border is the kind's own colour, which is how the tile still says WHICH
  // weather at a glance once it is too small to read the glyph.
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = hazardColor(kind);
  ctx.stroke();

  // The glyph, inset. Same paths as the key in the legend and the popup, so a
  // reader who learns one has learned all three.
  const inner = box - 7;
  ctx.save();
  ctx.translate(pad + 3.5, pad + 3.5);
  ctx.scale(inner / 24, inner / 24);
  paintHazardSign(ctx, kind, 24, false);
  ctx.restore();

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** A colour from the page's own tokens, so a marker matches the theme it is
 *  drawn into. Falls back rather than throwing where there is no document. */
function cssToken(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
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

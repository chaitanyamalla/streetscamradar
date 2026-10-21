// A MapLibre stand-in, with the surface this site actually uses.
//
// Derived from the source rather than from memory: every method here is one
// app.js or js/map.js calls. Twenty methods, two classes, no tiles, no WebGL —
// a headless Chromium cannot draw a map and does not need to for any question
// these tests ask.
//
// THE RULE THIS STUB LIVES BY: where the real one is awkward, be awkward the
// same way. A stub that is easier than reality hides exactly the bug you are
// looking for, and every comment below marked "modelled because" records a bug
// that got through a version of this file that was more convenient.
const BASEMAP_SOURCE = 'carto';

// The basemap's own layers, as probe_boundaries.py read them off the live
// CARTO style: ids, source-layer and filters verbatim.
//
// Modelled because: a stub that started with an empty style made any code that
// restyles the basemap a no-op in every test while working in the browser.
const CARTO_LAYERS = () => ([
  { id:'boundary_county',          type:'line', source:BASEMAP_SOURCE, 'source-layer':'boundary',
    filter:['all',['==','admin_level',6],['==','maritime',0]], minzoom:9 },
  { id:'boundary_state',           type:'line', source:BASEMAP_SOURCE, 'source-layer':'boundary',
    filter:['all',['==','admin_level',4],['==','maritime',0]], minzoom:4 },
  { id:'boundary_country_outline', type:'line', source:BASEMAP_SOURCE, 'source-layer':'boundary',
    filter:['all',['==','admin_level',2],['==','maritime',0]], minzoom:6 },
  { id:'boundary_country_inner',   type:'line', source:BASEMAP_SOURCE, 'source-layer':'boundary',
    filter:['all',['==','admin_level',2],['==','maritime',0]], minzoom:0 },
  // Labels, AFTER the lines, which is the order the real style has them in.
  // Modelled because: without a symbol layer, nothing can tell whether a layer
  // was inserted into the boundary band or dumped on top of the place names.
  { id:'place_country_2', type:'symbol', source:BASEMAP_SOURCE, 'source-layer':'place',
    filter:['all',['==','class','country'],['>=','rank',3],['has','iso_a2']], minzoom:3, maxzoom:10 },
  { id:'place_country_1', type:'symbol', source:BASEMAP_SOURCE, 'source-layer':'place',
    filter:['all',['==','class','country'],['<=','rank',2]], minzoom:2, maxzoom:7 },
]);

class LngLatBounds {
  constructor(sw, ne) { this._sw = sw; this._ne = ne; }
  getSouth() { return this._sw[1]; }
  getNorth() { return this._ne[1]; }
  getWest()  { return this._sw[0]; }
  getEast()  { return this._ne[0]; }
}

export class Popup {
  constructor(o = {}) { this.o = o; this._el = null; }
  setLngLat(ll) { this.ll = ll; return this; }
  setHTML(html) { this.html = html; return this; }
  addTo(map) {
    map.__popups.push(this);
    const wrap = document.createElement('div');
    // The real one puts `className` on the container beside its own classes.
    //
    // Modelled because: dropping it made a popup the app had NAMED —
    // .report-popup, .cell-tip — unfindable by that name, so an assertion
    // looking for one could only ever pass by being vacuous.
    wrap.className = ['maplibregl-popup', this.o.className].filter(Boolean).join(' ');
    const content = document.createElement('div');
    content.className = 'maplibregl-popup-content';
    // The real one applies maxWidth to the CONTENT element, not the container.
    if (this.o.maxWidth) content.style.maxWidth = this.o.maxWidth;
    content.innerHTML = this.html ?? '';
    wrap.appendChild(content);
    (map._el ?? document.body).appendChild(wrap);
    this._el = wrap;
    return this;
  }
  remove() { this._el?.remove(); this._el = null; return this; }
  isOpen() { return Boolean(this._el?.isConnected); }
}

export class Map {
  constructor(o = {}) {
    this.__o = o;
    this.__sources = {};
    this.__layers = [];
    this.__images = {};
    this.__popups = [];
    this.__handlers = {};
    this.__flights = [];
    this.__zoomRates = {};
    this._center = { lng: o.center?.[0] ?? 0, lat: o.center?.[1] ?? 0 };
    this._zoom = o.zoom ?? 2;
    this._bounds = new LngLatBounds([-180, -85], [180, 85]);
    this._el = typeof o.container === 'string'
      ? document.getElementById(o.container) : o.container;
    this._el.classList.add('maplibregl-map');
    const canvas = document.createElement('canvas');
    canvas.className = 'maplibregl-canvas';
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#e6ebe9';
    this._el.appendChild(canvas);
    this._canvas = canvas;
    this.cooperativeGestures = {
      _on: Boolean(o.cooperativeGestures),
      enable() { this._on = true; }, disable() { this._on = false; },
      isEnabled() { return this._on; },
    };
    // Only present on an interactive map, which is why the app guards it.
    this.scrollZoom = {
      setWheelZoomRate: (r) => { this.__zoomRates.wheel = r; },
      setZoomRate: (r) => { this.__zoomRates.pinch = r; },
    };
    this.__loadBasemap();
    setTimeout(() => this.__fire('load', {}), 0);
  }

  __loadBasemap() {
    this.__sources[BASEMAP_SOURCE] = { type: 'vector', _data: null };
    for (const l of CARTO_LAYERS()) {
      this.__layers.push({ ...l, filter: JSON.parse(JSON.stringify(l.filter)) });
    }
  }

  // --- events -------------------------------------------------------------
  // The real on() takes (type, fn) OR (type, layerId, fn).
  //
  // Modelled because: a two-argument-only version stored the LAYER NAME where
  // the handler belonged and threw the handler away. Nothing fired, so nothing
  // noticed, until a tooltip bound that way never appeared in the browser.
  on(type, layerOrFn, maybeFn) {
    const layer = typeof layerOrFn === 'string' ? layerOrFn : null;
    const fn = typeof layerOrFn === 'function' ? layerOrFn : maybeFn;
    (this.__handlers[type] ??= []).push({ layer, fn });
    return this;
  }
  off(type, layerOrFn, maybeFn) {
    const fn = typeof layerOrFn === 'function' ? layerOrFn : maybeFn;
    this.__handlers[type] = (this.__handlers[type] ?? []).filter(h => h.fn !== fn);
    return this;
  }
  once(type, layerOrFn, maybeFn) {
    const layer = typeof layerOrFn === 'string' ? layerOrFn : null;
    const fn = typeof layerOrFn === 'function' ? layerOrFn : maybeFn;
    const wrapper = (e) => { this.off(type, wrapper); fn(e); };
    return layer ? this.on(type, layer, wrapper) : this.on(type, wrapper);
  }
  __fire(type, event, layer = null) {
    for (const h of [...(this.__handlers[type] ?? [])]) {
      if (h.layer && h.layer !== layer) continue;
      h.fn(event);
    }
  }

  // --- style --------------------------------------------------------------
  // setStyle throws away sources, layers and images exactly as the real one
  // does — that is why the app has to rebuild them — and then LOADS the new
  // style, which brings the basemap's own layers straight back.
  //
  // Modelled because: a version that kept them hid the rebuild bug, and a
  // version that cleared without reloading left the stub with no basemap at
  // all, which no real map ever has.
  setStyle(url) {
    this.__style = url;
    this.__sources = {};
    this.__layers = [];
    this.__images = {};
    this.__loadBasemap();
    setTimeout(() => this.__fire('styledata', {}), 0);
    return this;
  }
  getStyleUrl() { return this.__style ?? this.__o.style; }
  getStyle() { return { layers: this.__layers.map(l => ({ ...l })) }; }

  addSource(id, def) { this.__sources[id] = { ...def, _data: def.data }; }
  getSource(id) {
    const s = this.__sources[id];
    return s ? { setData: (d) => { s._data = d; }, _get: () => s._data } : undefined;
  }
  // beforeId is honoured, because WHERE a layer goes decides what draws over
  // what. A version that always appended let a border land on top of the
  // street labels and called it fine.
  addLayer(def, beforeId) {
    const at = beforeId ? this.__layers.findIndex(l => l.id === beforeId) : -1;
    if (at >= 0) this.__layers.splice(at, 0, def); else this.__layers.push(def);
  }
  getLayer(id) { return this.__layers.find(l => l.id === id); }
  setPaintProperty(id, key, val) {
    const l = this.getLayer(id); if (l) { l.paint ??= {}; l.paint[key] = val; }
  }
  setLayoutProperty(id, key, val) {
    const l = this.getLayer(id); if (l) { l.layout ??= {}; l.layout[key] = val; }
  }
  // Read back as well as written: code that appends to CARTO's own filter
  // rather than restating it needs to be able to read it, and a stub that
  // could not return one would have the app silently replace it.
  getFilter(id) { return this.getLayer(id)?.filter; }
  setFilter(id, filter) { const l = this.getLayer(id); if (l) l.filter = filter; }

  addImage(id, img, opts) { this.__images[id] = { img, opts }; }
  hasImage(id) { return Object.hasOwn(this.__images, id); }
  listImages() { return Object.keys(this.__images); }

  // --- where we are -------------------------------------------------------
  getCanvas() { return this._canvas; }
  getZoom() { return this._zoom; }
  getCenter() { return { ...this._center }; }
  getBounds() { return this._bounds; }
  resize() { return this; }
  addControl() { return this; }

  easeTo(o = {}) { return this.__move(o, 'easeTo'); }
  flyTo(o = {}) { return this.__move(o, 'flyTo'); }
  zoomTo(z, o = {}) { return this.__move({ ...o, zoom: z }, 'zoomTo'); }
  fitBounds(bounds, o = {}) {
    this.__flights.push({ how: 'fitBounds', bounds, ...o });
    // The real one derives a zoom from the span. Rough, but a test asking
    // "did it end up close in or far out" gets a usable answer, where a stub
    // that left the zoom alone answers every such question wrongly.
    const [[w, s], [e, n]] = bounds;
    const span = Math.max(Math.abs(n - s), Math.abs(e - w)) || 0.01;
    this._zoom = Math.max(1, Math.min(18, Math.log2(360 / span)));
    this.__setBounds(s, w, n, e, { programmatic: true });
    return this;
  }
  __move(o, how) {
    this.__flights.push({ how, ...o });
    if (o.center) {
      this._center = Array.isArray(o.center)
        ? { lng: o.center[0], lat: o.center[1] } : { ...o.center };
    }
    if (typeof o.zoom === 'number') this._zoom = o.zoom;
    setTimeout(() => { this.__fire('moveend', {}); }, 0);
    return this;
  }

  queryRenderedFeatures(geometry, opts = {}) {
    const wanted = opts.layers ?? null;
    // Honours {layers}, because the app asks for a NAMED set and a stub that
    // returned everything let a click answer from a layer the app had
    // deliberately left out of the question.
    return (this.__features ?? []).filter(f =>
      !wanted || wanted.includes(f.layer?.id ?? f.__layer));
  }

  // --- what a test drives -------------------------------------------------
  /** Put the view somewhere, as a pan or as a programmatic flight. */
  __setBounds(south, west, north, east, { programmatic = false, zoom } = {}) {
    this._bounds = new LngLatBounds([west, south], [east, north]);
    this._center = { lng: (west + east) / 2, lat: (south + north) / 2 };
    // The zoom follows the box, as it does on a real map.
    //
    // Modelled because: leaving it alone meant a test that put the view on one
    // city still read as zoomed out to the whole world, so every feature that
    // waits for "the view is one country" — the advisory chip, the emergency
    // numbers, the notice band — stayed silent and the tests looked like
    // product bugs.
    if (typeof zoom === 'number') {
      this._zoom = zoom;
    } else {
      const span = Math.max(Math.abs(north - south), Math.abs(east - west)) || 0.01;
      this._zoom = Math.max(1, Math.min(18, Math.log2(360 / span)));
    }
    // movestart carries originalEvent for a gesture and NOT for a flight the
    // code started itself, which is how the app tells one from the other.
    this.__fire('movestart', programmatic ? {} : { originalEvent: { type: 'mousemove' } });
    this.__fire('move', {});
    this.__fire('moveend', {});
  }
  __setFeatures(features) {
    this.__features = features.map(f => ({ ...f, layer: f.layer ?? { id: f.__layer } }));
  }
  __clickFeature(feature, layerId = 'report-icon') {
    this.__fire('click', { features: [feature], lngLat: { lng: 0, lat: 0 } }, layerId);
  }
  __hoverFeature(feature, layerId) {
    this.__fire('mouseenter', { features: [feature], lngLat: { lng: 0, lat: 0 } }, layerId);
  }
  __leaveFeature(layerId) { this.__fire('mouseleave', {}, layerId); }
}

export default { Map, Popup };

/**
 * The hazard signs: one drawing per kind of hazard, in one place.
 *
 * Why not emoji, which is what this used to be. An emoji is whatever the
 * reader's device decides it is — 🏜 is a lone dune on one phone and a beach
 * with a palm tree on another, which on a map about where to go is a holiday
 * rather than a drought, and a device with no colour emoji font draws a blank
 * box. The glyph carried the meaning and we did not control the glyph.
 *
 * Each one is the thing itself, standing on the map on its own — no plate, no
 * badge, no warning triangle around it. They were tried inside a triangle and
 * it was worse: the container took two thirds of the room and left the
 * drawing a smudge in the middle, and every hazard looked like every other
 * hazard until you were close enough to read the small part.
 *
 * The COLOUR says which hazard. Water is blue, fire is red, the ground is
 * violet, and a storm is the blue of every forecast ever printed. Seventeen
 * kinds cannot be told apart by shape alone at 20 pixels, and the reader
 * already knows these colours before they arrive. (The rule at the top of
 * styles.css — colour means severity, never category — is about REPORTS,
 * where twelve categories share one meaning and only severity differs. These
 * are seventeen different things from six different agencies, and the popup
 * still carries the severity in words.)
 *
 * What a bare drawing loses is the plate that separated it from a scam pin,
 * so it is carried by the white edge every glyph is cut out with, and by the
 * fact that a report is a round pin and none of these is round.
 *
 * Every glyph is a list of parts: a path to fill, a path to stroke at a width,
 * `on` to paint in white (the way a window is left out of a building), or
 * `accent` for the one warm detail — lava, lightning.
 *
 * Geometry lives in a 24×24 box so the same paths draw the marker on the map
 * (canvas, via Path2D), the key in the hazard panel, the glyph in a popup and
 * the row in the weather list. A key redrawn by hand stops matching the map
 * the first time either changes.
 */

const WHITE = '#ffffff';
const ACCENT = '#f5a623';          // lightning, lava — the one warm detail

// The white edge each glyph is cut out with. Not decoration: without it a
// blue flood over a river, or a grey fog over a road, has no outline at all.
const HALO = 'rgba(255,255,255,.96)';
const HALO_WIDTH = 2.0;

// The glyphs were drawn to sit inside a triangle, in a box around (12, 14.2)
// about 11 wide. With the triangle gone they are scaled up about the same
// point to fill the square they are given, rather than every path being
// redrawn by hand.
const SPREAD = 'translate(12 12) scale(1.85) translate(-12 -14.2)';

const circle = (cx, cy, r) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;

// A cloud, shared by everything that falls out of one: three discs and a slab,
// drawn as one white shape because overlapping fills union for free.
const CLOUD = [
  { d: circle(10.2, 12.3, 2.0) },
  { d: circle(13.8, 12.4, 2.2) },
  { d: circle(11.9, 11.2, 2.5) },
  { d: 'M8.2 12.3h7.8v2.1H8.2z' },
];

// A thermometer, shared by the two temperature warnings, which differ by the
// mark beside them and by their colour — the reader is told which in words.
const THERMOMETER = [
  { d: 'M12 10.0v5.6', stroke: 2.6 },
  { d: circle(12, 17.0, 2.4) },
];

/**
 * Colour, then parts. Anything not listed falls back to `unknown`, so a kind
 * an agency invents tomorrow gets a sign that says "something here" rather
 * than a marker that silently fails to appear.
 */
const SIGNS = {
  // --- what GDACS publishes ------------------------------------------------

  // A building standing in water. Waves alone say water; a flood is water
  // where the buildings are, and that is the whole difference. The roof is
  // flat on purpose — a gable is a triangle inside a triangle.
  flood: { color: '#0e7490', parts: [
    { d: 'M8.9 9.8h6.2v6.8H8.9z' },
    { d: 'M10.2 11.2h1.35v1.35h-1.35zM12.75 11.2h1.35v1.35h-1.35z'
       + 'M10.2 13.7h1.35v1.35h-1.35zM12.75 13.7h1.35v1.35h-1.35z', on: true },
    { d: 'M6.8 16.8q1.3-.95 2.6 0t2.6 0t2.6 0t2.6 0', stroke: 1.45 },
    { d: 'M6.8 18.5q1.3-.95 2.6 0t2.6 0t2.6 0t2.6 0', stroke: 1.45 },
  ] },

  // A spiral wound in twice, which is what a storm looks like from above and
  // what every forecast prints. Two arms around an eye turned to a blob at
  // the size this is actually used.
  cyclone: { color: '#1f4fa8', parts: [
    { d: 'M16.2 14.7a4.2 4.2 0 0 1-8.4 0a3.3 3.3 0 0 1 6.6 0a2.3 2.3 0 0 1-4.6 0',
      stroke: 1.65 },
  ] },

  // A flame, not a droplet: the tip leans, the left shoulder dips, and the
  // inner tongue is cut out of it. A symmetrical teardrop is water.
  wildfire: { color: '#c6371f', parts: [
    { d: 'M13.9 10.4c.15 1.45-.55 2.3-1.5 3.25-1.1 1.1-1.4 2.05-.9 3.0'
       + 'c-.9-.3-1.5-1.05-1.7-2.05-.9 1.0-1.4 2.15-1.4 3.2'
       + 'a4.1 4.1 0 0 0 8.2 0c0-2.2-1.15-3.5-2.05-4.5-.85-.95-1.5-1.8-.65-2.9z' },
  ] },

  // A sun, and nothing under it. Cracked ground is the textbook drawing and
  // it was tried four ways: thin cracks in a solid block come out looking
  // like letters, and one version read as "RU" at every size.
  drought: { color: '#b5730d', parts: [
    { d: circle(12, 14.4, 2.4) },
    { d: 'M12 9.2v1.6M12 18.0v1.6M7.2 14.4h1.6M15.2 14.4h1.6'
       + 'M8.75 11.15l1.1 1.1M14.15 16.55l1.1 1.1M15.25 11.15l-1.1 1.1'
       + 'M9.85 16.55l-1.1 1.1', stroke: 1.45 },
  ] },

  // A squat cone with a wide crater. The eruption is three sparks, thrown off
  // to one side: set symmetrically they were two eyes and a nose.
  volcano: { color: '#7d2f1b', parts: [
    { d: 'M6.9 18.9l2.8-4.7h4.6l2.8 4.7z' },
    { d: circle(11.4, 11.6, .95), accent: true },
    { d: circle(13.7, 10.3, .7), accent: true },
    { d: circle(9.9, 9.6, .52), accent: true },
  ] },

  // The trace a seismograph draws. A cracked building was the other option
  // and it is the flood sign with a different crack — this is nothing else.
  earthquake: { color: '#5c2d91', parts: [
    { d: 'M6.9 14.8h1.9l1.3-3.6 1.9 7.0 1.6-4.8 1.0 1.4h2.5', stroke: 1.7 },
  ] },

  // --- what national met services publish through MeteoAlarm ---------------

  rain: { color: '#3b82c4', parts: [...CLOUD,
    { d: 'M9.9 15.6l-.8 2.2M12.0 15.6l-.8 2.2M14.1 15.6l-.8 2.2', stroke: 1.3 },
  ] },

  'rain-flood': { color: '#1c6f8b', parts: [...CLOUD,
    { d: 'M7.4 17.2q1.15-.85 2.3 0t2.3 0t2.3 0t2.3 0', stroke: 1.35 },
    { d: 'M7.4 18.9q1.15-.85 2.3 0t2.3 0t2.3 0t2.3 0', stroke: 1.35 },
  ] },

  thunderstorm: { color: '#3f4c6b', parts: [...CLOUD,
    { d: 'M12.7 14.8l-3.0 3.6h2.0l-.7 2.0 3.1-3.6h-2.1z', accent: true },
  ] },

  // Three lines of moving air, two of them curling back on themselves. The
  // hooks are clean three-quarter loops; drawn as lopsided arcs they read as
  // a squiggle rather than wind.
  wind: { color: '#2f8f8a', parts: [
    { d: 'M7.0 11.8h4.8a1.6 1.6 0 1 0-1.6-1.6', stroke: 1.6 },
    { d: 'M7.0 14.8h6.2a1.8 1.8 0 1 1-1.8 1.8', stroke: 1.6 },
    { d: 'M7.0 17.8h4.2', stroke: 1.6 },
  ] },

  'snow-ice': { color: '#5aa3d6', parts: [
    { d: 'M12 10.0v8.4M8.36 12.1l7.28 4.2M8.36 16.3l7.28-4.2', stroke: 1.5 },
  ] },

  // Banks of mist: four bands of different lengths, barely undulating. Drawn
  // dead straight they were a hamburger menu; drawn as proper waves they were
  // water.
  fog: { color: '#71818c', parts: [
    { d: 'M8.3 11.8q1.25-.7 2.5 0t2.5 0t2.5 0', stroke: 1.5 },
    { d: 'M7.2 14.3q1.225-.7 2.45 0t2.45 0t2.45 0t2.45 0', stroke: 1.5 },
    { d: 'M8.8 16.7q1.1-.7 2.2 0t2.2 0t2.2 0', stroke: 1.5 },
    { d: 'M7.4 18.7q1.15-.6 2.3 0t2.3 0t2.3 0t2.3 0', stroke: 1.5 },
  ] },

  'high-temperature': { color: '#cc5a15', parts: [...THERMOMETER,
    { d: 'M15.0 11.2h1.3M15.0 13.4h1.3', stroke: 1.2 },
  ] },

  'low-temperature': { color: '#2f6fb5', parts: [...THERMOMETER,
    { d: 'M15.6 11.5v2.2M14.65 12.05l1.9 1.1M14.65 13.15l1.9-1.1', stroke: 1.0 },
  ] },

  // Swell, with no building in it: this is the sea coming up the shore, not a
  // river through a town.
  'coastal-event': { color: '#0b6e8f', parts: [
    { d: 'M6.9 13.4q1.7-1.8 3.4 0t3.4 0t3.4 0', stroke: 1.8 },
    { d: 'M6.9 16.4q1.7-1.8 3.4 0t3.4 0t3.4 0', stroke: 1.8 },
    { d: 'M6.9 19.0q1.7-1.5 3.4 0t3.4 0t3.4 0', stroke: 1.6 },
  ] },

  // MeteoAlarm's forest fire and GDACS's wildfire are the same event seen by
  // two agencies, so they are the same sign. Two reds for one thing would
  // only ask the reader to find a difference that is not there.
  'forest-fire': null,   // filled in below

  // A slope with the snow already coming off it — a wedge, not a peak, since
  // a peak is one more triangle inside the triangle.
  avalanche: { color: '#6b7f92', parts: [
    { d: 'M6.8 18.9L15.6 11.4v7.5z' },
    { d: circle(11.0, 16.4, 1.0), on: true },
    { d: circle(13.2, 17.6, 1.1), on: true },
    { d: circle(9.0, 18.0, .8), on: true },
  ] },

  // Anything an agency starts publishing that we have not drawn yet. A sign
  // with no glyph looks broken; a sign saying "something" is the truth.
  // The one that keeps a triangle, because a triangle IS the drawing here:
  // an exclamation mark on its own is not a warning about anything. Amber,
  // like every unspecific warning sign ever printed.
  unknown: { color: '#c8901a', parts: [
    { d: 'M13.0 9.0L19.1 18.9Q19.9 20.2 18.3 20.2L5.7 20.2'
       + 'Q4.1 20.2 4.9 18.9L11.0 9.0Q12 7.4 13.0 9.0Z', stroke: 1.5 },
    { d: 'M12 12.2v3.6', stroke: 1.7 },
    { d: circle(12, 17.9, .95) },
  ] },
};

SIGNS['forest-fire'] = SIGNS.wildfire;

/** The kinds drawn on the map, which is GDACS minus the earthquake (USGS). */
export const HAZARD_SIGN_KINDS = ['flood', 'cyclone', 'wildfire', 'drought', 'volcano'];

/** Every kind that has a sign at all, map or list. */
export const ALL_SIGN_KINDS = Object.keys(SIGNS).filter(k => k !== 'unknown');

export const hazardSign = (kind) => SIGNS[kind] ?? SIGNS.unknown;

/** The colour a kind is drawn in, for a swatch or a border that must match. */
export const hazardColor = (kind) => hazardSign(kind).color;

const paintOf = (part, color) =>
  part.on ? WHITE : part.accent ? ACCENT : color;

/**
 * The sign as an inline SVG, for a panel key, a popup or a list row.
 * Decorative by default: the row beside it already says what it is in words,
 * and a screen reader does not need to hear "warning triangle" twice.
 */
export function hazardSignSVG(kind, { size = 18, label = '' } = {}) {
  const { color, parts } = hazardSign(kind);
  const ends = ' stroke-linecap="round" stroke-linejoin="round"';

  // Two passes: every edge first, then every glyph. One pass and each part's
  // white edge would rub out the part drawn before it.
  const edges = parts.filter(p => !p.on).map(p =>
    `<path d="${p.d}" fill="${p.stroke ? 'none' : HALO}" stroke="${HALO}"`
    + ` stroke-width="${(p.stroke ?? 0) + HALO_WIDTH}"${ends}/>`).join('');

  const drawn = parts.map(p => p.stroke
    ? `<path d="${p.d}" fill="none" stroke="${paintOf(p, color)}"`
      + ` stroke-width="${p.stroke}"${ends}/>`
    : `<path d="${p.d}" fill="${paintOf(p, color)}"/>`).join('');

  return `<svg class="hazard-sign" viewBox="0 0 24 24" width="${size}" height="${size}"`
    + (label ? ` role="img" aria-label="${label}">` : ' aria-hidden="true" focusable="false">')
    + `<g transform="${SPREAD}">${edges}${drawn}</g></svg>`;
}

/**
 * The same sign onto a canvas, which is the only thing MapLibre can place.
 * The white edge underneath is not decoration: without it a dark sign over a
 * dark park, or a blue one over water, loses its outline.
 */
export function paintHazardSign(ctx, kind, box = 24) {
  const { color, parts } = hazardSign(kind);
  ctx.save();
  ctx.scale(box / 24, box / 24);
  ctx.translate(12, 12);
  ctx.scale(1.85, 1.85);
  ctx.translate(-12, -14.2);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Every edge first, then every glyph — see the SVG above for why.
  ctx.strokeStyle = HALO;
  ctx.fillStyle = HALO;
  for (const part of parts) {
    if (part.on) continue;
    const path = new Path2D(part.d);
    ctx.lineWidth = (part.stroke ?? 0) + HALO_WIDTH;
    ctx.stroke(path);
    if (!part.stroke) ctx.fill(path);
  }

  for (const part of parts) {
    const path = new Path2D(part.d);
    const paint = paintOf(part, color);
    if (part.stroke) {
      ctx.lineWidth = part.stroke;
      ctx.strokeStyle = paint;
      ctx.stroke(path);
    } else {
      ctx.fillStyle = paint;
      ctx.fill(path);
    }
  }
  ctx.restore();
}

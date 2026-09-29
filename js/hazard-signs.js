/**
 * The hazard signs: one drawing per kind of disaster, in one place.
 *
 * Why not emoji, which is what this used to be. Two reasons, and the second
 * is the one that matters.
 *
 * An emoji is whatever the reader's device decides it is. 🏜 is a lone dune on
 * one phone and a beach with a palm tree on another — which, on a map about
 * where to go, is a holiday rather than a drought. A device with no colour
 * emoji font draws a blank box. The glyph carried the meaning and we did not
 * control the glyph.
 *
 * And a round emoji badge is the same silhouette as a scam pin. A hazard is a
 * different KIND of thing from a report somebody filed, so it should not need
 * a second look to tell apart. A triangle does that before colour or detail is
 * read at all — it is the shape every road sign on earth uses for "take care
 * here", and it survives being 20 pixels wide, printed grey, or seen by
 * someone who cannot separate orange from red.
 *
 * Geometry lives in a 24×24 box so the same paths draw the marker on the map
 * (canvas, via Path2D), the key in the hazard panel, and the glyph in the
 * popup. A key that is redrawn by hand stops matching the map the first time
 * either changes.
 */

// Amber, black glyph: the hazard-sign convention, and nothing else on this map
// is that colour — reports are orange discs, earthquakes violet rings.
export const SIGN_FILL = '#f2b01c';
export const SIGN_INK = '#1d1607';

// Rounded triangle. Corners trimmed 2.6 along each edge so it reads as a sign
// rather than a shard at the size it is actually drawn.
const TRIANGLE = 'M13.25 4.88L20.55 18.12Q21.8 20.4 19.2 20.4L4.8 20.4'
               + 'Q2.2 20.4 3.45 18.12L10.75 4.88Q12 2.6 13.25 4.88Z';

const circle = (cx, cy, r) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;

/**
 * Each glyph is a list of parts: a path to fill, or a path to stroke at a
 * width. Everything sits inside x 7–17, y 9.5–18.8 — the part of a triangle
 * that is actually wide enough to hold a drawing.
 */
const GLYPHS = {
  // Water, not a house half under it: two strokes stay readable at 20px where
  // a roofline turns to mud.
  flood: [
    { d: 'M8.6 14.0q1.15-1.5 2.3 0t2.3 0t2.3 0', stroke: 1.95 },
    { d: 'M7.4 17.6q1.15-1.5 2.3 0t2.3 0t2.3 0t2.3 0', stroke: 1.95 },
  ],
  // A spiral wound in twice, which is what a storm looks like from above and
  // what every forecast prints. Two arms around an eye turned to a blob the
  // moment it was drawn at the size it is actually used.
  cyclone: [
    { d: 'M16.2 14.7a4.2 4.2 0 0 1-8.4 0a3.3 3.3 0 0 1 6.6 0a2.3 2.3 0 0 1-4.6 0',
      stroke: 1.65 },
  ],
  // A flame, not a droplet: the tip leans, the left shoulder dips, and the
  // inner tongue is cut out of it. A symmetrical teardrop is water.
  wildfire: [
    { d: 'M13.4 9.2c.5 1.6-.1 2.6-1.0 3.6-1.1 1.2-1.4 2.2-.9 3.2'
       + 'c-.9-.3-1.5-1.1-1.7-2.2-.9 1.1-1.4 2.3-1.4 3.4'
       + 'a4.1 4.1 0 0 0 8.2 0c0-2.3-1.2-3.7-2.1-4.8-.8-1.0-1.4-2.0-1.1-3.2z' },
  ],
  // A sun, and nothing under it. Cracked ground is the textbook drawing for
  // drought and it was tried twice: with the sun above it the pair reads as a
  // seated figure at 20 pixels, and 20 pixels is the size this is used at. A
  // sun in a warning triangle already says heat and dryness, and the popup
  // says the word.
  drought: [
    { d: circle(12, 14.4, 2.4) },
    { d: 'M12 9.2v1.6M12 18.0v1.6M7.2 14.4h1.6M15.2 14.4h1.6'
       + 'M8.75 11.15l1.1 1.1M14.15 16.55l1.1 1.1M15.25 11.15l-1.1 1.1'
       + 'M9.85 16.55l-1.1 1.1', stroke: 1.45 },
  ],
  volcano: [
    { d: 'M7.2 18.8l3.3-5.6h3l3.3 5.6z' },
    { d: circle(12, 11.3, .95) },
    { d: circle(9.9, 10.0, .7) },
    { d: circle(14.1, 10.1, .7) },
  ],
  // Anything GDACS starts publishing that we have not drawn yet. A sign with
  // no glyph would look broken; a sign saying "something" is the truth.
  unknown: [
    { d: 'M12 10.8v5.1', stroke: 2.3 },
    { d: circle(12, 18.2, 1.2) },
  ],
};

export const HAZARD_SIGN_KINDS = Object.keys(GLYPHS).filter(k => k !== 'unknown');

export const hazardGlyph = (kind) => GLYPHS[kind] ?? GLYPHS.unknown;

/**
 * The same sign as an inline SVG, for the hazard panel's key and the popup.
 * Decorative by default: the row next to it already says what it is in words,
 * and a screen reader does not need to hear "warning triangle" twice.
 */
export function hazardSignSVG(kind, { size = 18, label = '' } = {}) {
  const parts = hazardGlyph(kind).map(p => p.stroke
    ? `<path d="${p.d}" fill="none" stroke="${SIGN_INK}" stroke-width="${p.stroke}"`
      + ' stroke-linecap="round" stroke-linejoin="round"/>'
    : `<path d="${p.d}" fill="${SIGN_INK}"/>`).join('');

  return `<svg class="hazard-sign" viewBox="0 0 24 24" width="${size}" height="${size}"`
    + (label ? ` role="img" aria-label="${label}">` : ' aria-hidden="true" focusable="false">')
    + `<path d="${TRIANGLE}" fill="${SIGN_FILL}" stroke="${SIGN_INK}" stroke-width="1.5"`
    + ' stroke-linejoin="round"/>' + parts + '</svg>';
}

/**
 * The same sign onto a canvas, which is the only thing MapLibre can place.
 * The white edge underneath is not decoration: without it an amber sign over
 * a sand-coloured map or a dark park loses its outline.
 */
export function paintHazardSign(ctx, kind, box = 24) {
  const scale = box / 24;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const sign = new Path2D(TRIANGLE);
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = 'rgba(255,255,255,.95)';
  ctx.stroke(sign);
  ctx.fillStyle = SIGN_FILL;
  ctx.fill(sign);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = SIGN_INK;
  ctx.stroke(sign);

  for (const part of hazardGlyph(kind)) {
    const path = new Path2D(part.d);
    if (part.stroke) {
      ctx.lineWidth = part.stroke;
      ctx.strokeStyle = SIGN_INK;
      ctx.stroke(path);
    } else {
      ctx.fillStyle = SIGN_INK;
      ctx.fill(path);
    }
  }
  ctx.restore();
}

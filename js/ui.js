// ---------------------------------------------------------------------------
// Rendering helpers. Everything a member typed passes through esc() before it
// reaches innerHTML — report text is untrusted input from strangers.
// ---------------------------------------------------------------------------
import { PIN_COLOR } from './config.js';

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

export function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

let toastTimer;
export function toast(message, { error = false } = {}) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.toggle('is-error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 6000 : 4000);
}

export function renderCategoryFilters(host, categories, activeSet) {
  if (!categories.length) {
    host.innerHTML = '<p class="muted-note">No categories loaded.</p>';
    return;
  }
  host.innerHTML = categories.map(c => `
    <button type="button" class="cat-chip" data-category="${esc(c.slug)}"
            aria-pressed="${activeSet.has(c.slug)}" title="${esc(c.blurb ?? '')}">
      <span class="glyph" aria-hidden="true">${esc(c.glyph)}</span>${esc(c.label)}
    </button>`).join('');
}

export function renderReportList(host, reports, { categories, mode, supported, signedIn }) {
  const byslug = new Map(categories.map(c => [c.slug, c]));

  if (!reports.length) {
    host.innerHTML = `<p class="empty-note">${
      mode === 'summary'
        ? 'Zoom into a town or neighbourhood to see individual reports.'
        : 'No reports here in the last 7 days. That is good news — or nobody has told us yet.'
    }</p>`;
    return;
  }

  host.innerHTML = reports.map(r => {
    const cat = byslug.get(r.category);
    const isOn = supported.has(r.id);
    const place = r.city ? `${esc(r.city)} · ` : '';
    const actions = signedIn ? `
      <div class="report-actions">
        <button class="chip-action" data-support="${esc(r.id)}" aria-pressed="${isOn}">
          ${isOn ? '✓ Confirmed' : 'I saw this too'}${r.support_count ? ` · ${r.support_count}` : ''}
        </button>
        ${r.is_mine
          ? `<button class="chip-action" data-withdraw="${esc(r.id)}">Withdraw</button>`
          : `<button class="chip-action" data-flag="${esc(r.id)}">Flag</button>`}
      </div>` : '';

    return `
      <article class="report-entry" data-report="${esc(r.id)}">
        <span class="report-glyph" aria-hidden="true">${esc(cat?.glyph ?? '⚠')}</span>
        <div class="report-copy">
          <b>${esc(r.headline)}</b>
          <span class="report-meta">${place}${esc(cat?.label ?? r.category)} · ${timeAgo(r.happened_at)}</span>
          ${actions}
        </div>
      </article>`;
  }).join('');
}

export function popupHTML(props, categories) {
  const cat = categories.find(c => c.slug === props.category);
  const where = [props.address, props.city].filter(Boolean).join(', ');
  const supports = Number(props.support_count) || 0;

  // Signed-out visitors get the text too now, but a member's feed may still
  // arrive before the description does, so handle its absence.
  const body = props.description
    ? `<p class="popup-body">${esc(props.description)}</p>`
    : '';

  return `
    <div class="popup-head">
      <span class="popup-glyph" aria-hidden="true">${esc(cat?.glyph ?? '\u26A0')}</span>
      <div>
        <p class="popup-kicker">${esc(cat?.label ?? props.category)}</p>
        <p class="popup-title">${esc(props.headline)}</p>
      </div>
    </div>
    ${body}
    <p class="popup-meta">
      ${where ? esc(where) + ' &middot; ' : ''}${esc(timeAgo(props.happened_at))}
      ${supports ? ` &middot; ${supports} ${supports === 1 ? 'person' : 'people'} confirmed this` : ''}
    </p>`;
}

/** A police station or hospital, clicked on the map. Not user content, but
 * routed through esc() anyway — an OSM name field is still text from a
 * source we do not control. */
export function safetyPopupHTML(props) {
  const isHospital = props.kind === 'hospital';
  return `
    <div class="popup-head">
      <span class="popup-glyph ${isHospital ? 'is-hospital' : 'is-police'}" aria-hidden="true">${isHospital ? '\u{1F3E5}' : '\u{1F693}'}</span>
      <div>
        <p class="popup-kicker">${isHospital ? 'Hospital' : 'Police station'}</p>
        <p class="popup-title">${esc(props.name)}</p>
      </div>
    </div>
    ${props.address ? `<p class="popup-body">${esc(props.address)}</p>` : ''}
    <p class="popup-meta">via OpenStreetMap</p>`;
}

export function setGateNote(host, { mode, shown = 0, hiddenCount = 0, signedIn }) {
  if (signedIn) { host.hidden = true; return; }
  host.hidden = false;
  if (mode === 'summary') {
    host.innerHTML = `Each circle is how many scams were reported here this week.
      <b>Zoom into a town</b> to see individual reports, or
      <button class="chip-action" data-open-auth>join free</button> to see them all.`;
  } else if (hiddenCount > 0) {
    host.innerHTML = `Showing ${shown} of ${shown + hiddenCount} reports here.
      <b>${hiddenCount} more ${hiddenCount === 1 ? 'is' : 'are'} members-only.</b>
      <button class="chip-action" data-open-auth>Join free to see them</button>`;
  } else {
    host.innerHTML = `Seen something here yourself?
      <button class="chip-action" data-open-auth>Join free</button> to put it on the map.`;
  }
}

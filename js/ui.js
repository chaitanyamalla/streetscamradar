// ---------------------------------------------------------------------------
// Rendering helpers. Everything a member typed passes through esc() before it
// reaches innerHTML — report text is untrusted input from strangers.
// ---------------------------------------------------------------------------
import { PIN_COLOR } from './config.js';

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// What happened, as the form asks it. This replaced a low/medium/high
// severity rating: a reporter cannot grade their own risk, but they do know
// whether money went, whether anyone was hurt, and whether they were
// threatened.
export const IMPACTS = {
  money:   { glyph: '\u{1F4B5}', label: 'Money lost' },
  harm:    { glyph: '\u{1FA79}', label: 'Hurt or forced' },
  threats: { glyph: '\u{1F628}', label: 'Threatened' },
};

/**
 * impacts arrives as a real array from the database, but MapLibre serialises
 * non-primitive feature properties to JSON before a click handler ever sees
 * them — so the same field is a string on the map and an array in the list.
 */
export function parseImpacts(value) {
  if (Array.isArray(value)) return value.filter(k => k in IMPACTS);
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter(k => k in IMPACTS);
  } catch { /* not JSON — fall through to the Postgres array literal */ }
  return value.replace(/^\{|\}$/g, '').split(',').filter(k => k in IMPACTS);
}

export function impactTags(value) {
  const keys = parseImpacts(value);
  if (!keys.length) return '';
  return `<span class="impact-tags">${keys.map(k =>
    `<span class="impact-tag is-${esc(k)}"><span aria-hidden="true">${IMPACTS[k].glyph}</span> ${esc(IMPACTS[k].label)}</span>`
  ).join('')}</span>`;
}

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
        : 'Nothing reported here in the last 7 days. That is good news — or nobody has told us yet.'
    }</p>`;
    return;
  }

  host.innerHTML = reports.map(r => {
    const cat = byslug.get(r.category);
    const isOn = supported.has(r.id);
    const place = r.city ? `${esc(r.city)} · ` : '';
    const confirms = Number(r.support_count) || 0;

    // Confirming is for other people's reports; the author's move on their own
    // is to withdraw it. Someone backing their own report would just be voting
    // for their own visibility, since confirmations now drive it.
    const actions = signedIn ? `
      <div class="report-actions">
        ${r.is_mine
          ? `<button class="chip-action" data-withdraw="${esc(r.id)}">Withdraw my report</button>`
          : `<button class="chip-action" data-support="${esc(r.id)}" aria-pressed="${isOn}">
               ${isOn ? '✓ Confirmed' : 'I saw this too'}
             </button>
             <button class="chip-action" data-flag="${esc(r.id)}">Flag</button>`}
      </div>` : '';

    return `
      <article class="report-entry${confirmClass(confirms)}" data-report="${esc(r.id)}">
        <span class="report-glyph" aria-hidden="true">${esc(cat?.glyph ?? '⚠')}</span>
        <div class="report-copy">
          <b>${esc(r.headline)}</b>
          <span class="report-meta">${place}${esc(cat?.label ?? r.category)} · ${timeAgo(r.happened_at)}</span>
          ${impactTags(r.impacts)}
          ${confirmBadge(confirms)}
          ${actions}
        </div>
      </article>`;
  }).join('');
}

/**
 * How loudly a report is drawn. Confirmations are the only signal the site has
 * that more than one person met the same thing in the same place, so they —
 * not a self-assessed severity — are what raise a report.
 */
export const confirmClass = (n) => (n >= 3 ? ' is-confirmed-many' : n >= 1 ? ' is-confirmed' : '');

export function confirmBadge(n) {
  if (!n) return '';
  return `<span class="confirm-badge">\u2713 ${n} ${n === 1 ? 'person' : 'people'} confirmed this</span>`;
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
    ${impactTags(props.impacts)}
    ${body}
    ${confirmBadge(supports)}
    <p class="popup-meta">
      ${where ? esc(where) + ' &middot; ' : ''}${esc(timeAgo(props.happened_at))}
    </p>`;
}

/** A police station or hospital, clicked on the map. Not user content, but
 * routed through esc() anyway — an OSM name field is still text from a
 * source we do not control. */
/**
 * Getting there, and calling ahead.
 *
 * Knowing a police station is 400m away is only half of it — the other half is
 * which way to walk. The link hands the coordinates to Google Maps, which on a
 * phone opens the app itself and starts navigation; on a desktop it opens the
 * website. Coordinates rather than the name, because a name can resolve to the
 * wrong branch and this is not a moment to be approximately right.
 *
 * No travel mode is set. Google keeps whatever the viewer last used, which is
 * a better guess than ours: walking to a station round the corner and driving
 * to a hospital are both the common case, depending on which you tapped.
 */
function directionsHTML(props) {
  const lat = Number(props.lat);
  const lng = Number(props.lng);
  const tel = String(props.phone ?? '').replace(/[^+0-9]/g, '');
  const parts = [];

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    parts.push(`<a class="popup-action is-primary" href="${esc(url)}"
                   target="_blank" rel="noopener noreferrer">Directions</a>`);
  }
  if (tel) {
    parts.push(`<a class="popup-action" href="tel:${esc(tel)}">Call ${esc(props.phone)}</a>`);
  }
  return parts.length ? `<div class="popup-actions">${parts.join('')}</div>` : '';
}

export function safetyPopupHTML(props) {
  const isHospital = props.kind === 'hospital';
  // MapLibre serialises feature properties, so a boolean arrives as a string.
  const hasER = props.emergency === true || props.emergency === 'true';
  const kicker = isHospital
    ? (hasER ? 'Hospital &middot; emergency department' : 'Hospital')
    : 'Police station';

  const lines = [];
  if (props.address) lines.push(esc(props.address));
  if (props.opening_hours) lines.push(`Open ${esc(props.opening_hours)}`);

  return `
    <div class="popup-head">
      <span class="popup-glyph ${isHospital ? 'is-hospital' : 'is-police'}" aria-hidden="true">${isHospital ? '\u{1F3E5}' : '\u{1F693}'}</span>
      <div>
        <p class="popup-kicker">${kicker}</p>
        <p class="popup-title">${esc(props.name)}</p>
      </div>
    </div>
    ${lines.length ? `<p class="popup-body">${lines.join('<br />')}</p>` : ''}
    ${directionsHTML(props)}
    <p class="popup-meta">via OpenStreetMap</p>`;
}

/** A date and time input pair, pre-filled from an ISO timestamp in local time. */
const localParts = (iso) => {
  const d = new Date(iso);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
};

/**
 * Your own reports, in your profile. Different from the map list: it shows
 * every report you have filed, including ones that have aged off the map,
 * says plainly how long each has left, and lets you fix what you wrote.
 *
 * Tapping the headline takes you to it on the map. Withdrawing asks first,
 * in the page rather than through a browser confirm box, which on a phone is
 * easy to dismiss without reading.
 */
export function renderProfileReports(host, reports, categories, windowDays,
                                     { mine = true, moveWindowHours = 24 } = {}) {
  if (!reports.length) {
    host.innerHTML = `<p class="empty-note">${mine
      ? 'You have not filed a report yet. When you do, it will live here — with what it collected, and how long it has left.'
      : 'Nothing here yet.'}</p>`;
    return;
  }
  const byslug = new Map(categories.map(c => [c.slug, c]));

  host.innerHTML = reports.map(r => {
    const cat = byslug.get(r.category);
    const confirms = Number(r.support_count) || 0;
    const ageMs = Date.now() - new Date(r.happened_at).getTime();
    const daysLeft = Math.ceil((windowDays * 86400000 - ageMs) / 86400000);
    const live = daysLeft > 0;
    const flagged = Number(r.flag_count) > 0;
    const when = localParts(r.happened_at);
    const id = esc(r.id);
    const filedAgo = Date.now() - new Date(r.created_at ?? r.happened_at).getTime();
    const movable = filedAgo < moveWindowHours * 3600000;

    // Somebody else's report you confirmed: the only thing that is yours here
    // is the confirmation, so that is the only thing you can take back.
    if (!mine) {
      return `
      <article class="profile-report" data-report="${id}">
        <span class="report-glyph" aria-hidden="true">${esc(cat?.glyph ?? '⚠')}</span>
        <div class="report-copy">
          <button type="button" class="report-open" data-show="${id}">${esc(r.headline)}</button>
          <span class="report-meta">
            ${r.city ? esc(r.city) + ' · ' : ''}${esc(cat?.label ?? r.category)} · ${timeAgo(r.happened_at)}
          </span>
          ${impactTags(r.impacts)}
          <div class="report-actions">
            <button class="chip-action" data-unconfirm="${id}">Undo my confirmation</button>
          </div>
        </div>
      </article>`;
    }

    const actions = r.is_mine ? `
      <div class="report-actions">
        <button class="chip-action" data-edit="${id}">Edit</button>
        <button class="chip-action" data-withdraw="${id}">Withdraw</button>
      </div>
      <div class="withdraw-confirm" data-confirm="${id}" hidden>
        <span>Remove this from the map? It cannot be undone.</span>
        <button class="chip-action is-danger" data-withdraw-yes="${id}">Yes, remove it</button>
        <button class="chip-action" data-withdraw-no="${id}">Keep it</button>
      </div>
      <form class="edit-form" data-edit-form="${id}" hidden>
        <label for="edit-headline-${id}">Headline</label>
        <input id="edit-headline-${id}" name="headline" required minlength="8" maxlength="90"
               value="${esc(r.headline)}" />
        <label for="edit-description-${id}">What others should know</label>
        <textarea id="edit-description-${id}" name="description" required rows="3"
                  maxlength="1200">${esc(r.description ?? '')}</textarea>
        <label class="edit-when-toggle">
          <input type="checkbox" name="retime" /> Also correct when it happened
        </label>
        <div class="when-row" data-when hidden>
          <input type="date" name="date" value="${esc(when.date)}" aria-label="Date it happened" />
          <input type="time" name="time" value="${esc(when.time)}" aria-label="Time it happened" />
        </div>
        ${movable ? `
        <label class="edit-when-toggle">
          <input type="checkbox" name="remove" /> Also correct where it happened
        </label>
        <div data-where hidden>
          <div class="address-row">
            <input name="address" placeholder="Street, landmark or postcode"
                   value="${esc(r.address ?? '')}" autocomplete="off" />
            <button type="button" class="ghost-button small" data-find="${id}">Find</button>
          </div>
          <p class="pin-status" data-pin-status>Currently ${esc(r.address || r.city || 'the pin you dropped')}.</p>
        </div>` : `
        <p class="field-hint">Where it happened can only be corrected in the first
          ${moveWindowHours} hours, and this one is past that.</p>`}
        <div class="report-actions">
          <button class="chip-action is-primary" type="submit">Save changes</button>
          <button class="chip-action" type="button" data-edit-cancel="${id}">Cancel</button>
        </div>
      </form>` : '';

    return `
      <article class="profile-report${live ? '' : ' is-expired'}" data-report="${id}">
        <span class="report-glyph" aria-hidden="true">${esc(cat?.glyph ?? '⚠')}</span>
        <div class="report-copy">
          <button type="button" class="report-open" data-show="${id}">${esc(r.headline)}</button>
          <span class="report-meta">
            ${r.city ? esc(r.city) + ' · ' : ''}${esc(cat?.label ?? r.category)} · ${timeAgo(r.happened_at)}
          </span>
          ${impactTags(r.impacts)}
          <span class="profile-status">
            <span class="${live ? 'is-live' : 'is-gone'}">${live
              ? `On the map · ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`
              : 'Off the map — older than ' + windowDays + ' days'}</span>
            ${confirms ? `<span class="is-confirms">✓ ${confirms} confirmed</span>` : ''}
            ${flagged ? `<span class="is-flagged">⚑ ${r.flag_count} flagged</span>` : ''}
          </span>
          ${actions}
        </div>
      </article>`;
  }).join('');
}

/** The four counts, each a button that filters the list below it. A number
 *  you cannot act on is trivia; a number that shows you what it counted is a
 *  way around your own reports. */
export function renderProfileStats(host, { filed, live, received, given }, active = 'filed') {
  const tile = (key, n, label) =>
    `<button type="button" class="stat-tile${key === active ? ' is-active' : ''}"
             data-stat="${key}" aria-pressed="${key === active}">
       <b>${n}</b><span>${esc(label)}</span>
     </button>`;
  host.innerHTML =
    tile('filed', filed, filed === 1 ? 'report filed' : 'reports filed') +
    tile('live', live, 'on the map now') +
    tile('received', received, 'confirmations received') +
    tile('given', given, 'you have confirmed');
}

export const STAT_TITLES = {
  filed: 'Your reports',
  live: 'Still on the map',
  received: 'Reports others confirmed',
  given: 'Reports you confirmed',
};

export function setGateNote(host, { mode, shown = 0, hiddenCount = 0, signedIn }) {
  if (signedIn) { host.hidden = true; return; }
  host.hidden = false;
  if (mode === 'summary') {
    host.innerHTML = `Each circle is how many scams were reported here in the last 7 days.
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

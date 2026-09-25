// ---------------------------------------------------------------------------
// Rendering helpers. Everything a member typed passes through esc() before it
// reaches innerHTML — report text is untrusted input from strangers.
// ---------------------------------------------------------------------------
import { PIN_COLOR } from './config.js';
import { t, tn, plural, tOr } from './i18n.js';
import { STRINGS as ADVISORY, officialUrl, countryTitle, levelLabel, levelExplain,
         emergencyLine, contextLine } from './advisory.js';

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// What happened, as the form asks it. This replaced a low/medium/high
// severity rating: a reporter cannot grade their own risk, but they do know
// whether money went, whether anyone was hurt, and whether they were
// threatened.
export const IMPACTS = {
  money:   { glyph: '\u{1F4B5}', key: 'impact.money' },
  harm:    { glyph: '\u{1FA79}', key: 'impact.harm' },
  threats: { glyph: '\u{1F628}', key: 'impact.threats' },
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
    `<span class="impact-tag is-${esc(k)}"><span aria-hidden="true">${IMPACTS[k].glyph}</span> ${esc(t(IMPACTS[k].key))}</span>`
  ).join('')}</span>`;
}

export function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return mins <= 1 ? t('time.justNow') : t('time.minutes', { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('time.hours', { n: hours });
  const days = Math.round(hours / 24);
  return days === 1 ? t('time.yesterday') : t('time.days', { n: days });
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

/** A category's name and blurb in the reader's language, or the database's
 *  own wording for a slug we do not have a string for. */
export const categoryLabel = (cat, slug) =>
  tOr(`category.${cat?.slug ?? slug}`, cat?.label ?? slug ?? '');
const categoryBlurb = (cat) => tOr(`category.${cat.slug}.blurb`, cat.blurb ?? '');

export function renderCategoryFilters(host, categories, activeSet) {
  if (!categories.length) {
    host.innerHTML = `<p class="muted-note">${esc(t('filters.noCategories'))}</p>`;
    return;
  }
  host.innerHTML = categories.map(c => `
    <button type="button" class="cat-chip" data-category="${esc(c.slug)}"
            aria-pressed="${activeSet.has(c.slug)}" title="${esc(categoryBlurb(c))}">
      <span class="glyph" aria-hidden="true">${esc(c.glyph)}</span>${esc(categoryLabel(c))}
    </button>`).join('');
}

export function renderReportList(host, reports, { categories, mode, supported, signedIn }) {
  const byslug = new Map(categories.map(c => [c.slug, c]));

  if (!reports.length) {
    host.innerHTML = `<p class="empty-note">${esc(
      t(mode === 'summary' ? 'reports.empty.summary' : 'reports.empty.here')
    )}</p>`;
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
          ? `<button class="chip-action" data-withdraw="${esc(r.id)}">${esc(t('reports.withdrawMine'))}</button>`
          : `<button class="chip-action" data-support="${esc(r.id)}" aria-pressed="${isOn}">
               ${esc(t(isOn ? 'reports.confirmed' : 'reports.confirm'))}
             </button>
             <button class="chip-action" data-flag="${esc(r.id)}">${esc(t('reports.flag'))}</button>`}
      </div>` : '';

    return `
      <article class="report-entry${confirmClass(confirms)}" data-report="${esc(r.id)}">
        <span class="report-glyph" aria-hidden="true">${esc(cat?.glyph ?? '⚠')}</span>
        <div class="report-copy">
          <b>${esc(r.headline)}</b>
          <span class="report-meta">${place}${esc(categoryLabel(cat, r.category))} · ${timeAgo(r.happened_at)}</span>
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
  return `<span class="confirm-badge">${esc(plural('reports.confirmedBy', n))}</span>`;
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
        <p class="popup-kicker">${esc(categoryLabel(cat, props.category))}</p>
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

/** A hospital, clicked on the map. Not user content, but
 * routed through esc() anyway — an OSM name field is still text from a
 * source we do not control. */
/**
 * Getting there, and calling ahead.
 *
 * Knowing a hospital is 400m away is only half of it — the other half is
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
                   target="_blank" rel="noopener noreferrer">${esc(t('hospital.directions'))}</a>`);
  }
  if (tel) {
    parts.push(`<a class="popup-action" href="tel:${esc(tel)}">${
      esc(t('hospital.call', { number: props.phone }))}</a>`);
  }
  return parts.length ? `<div class="popup-actions">${parts.join('')}</div>` : '';
}

/**
 * Opening hours short enough to sit on the kicker line.
 *
 * OpenStreetMap records anything from "24/7" to
 * "Mo-Fr 15:00-17:00; Sa,Su,PH 13:00-17:00". The first clause is the one that
 * answers "can I go now?"; the rest stays in the body, so nothing is lost by
 * putting the short form up top.
 */
export function shortHours(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const first = text.split(';')[0].trim();
  return first.length > 24 ? `${first.slice(0, 23)}\u2026` : first;
}

export function safetyPopupHTML(props) {
  // MapLibre serialises feature properties, so a boolean arrives as a string.
  const hasER = props.emergency === true || props.emergency === 'true';
  const brief = shortHours(props.opening_hours);
  const kicker = [
    t('hospital.kind'),
    hasER ? t('hospital.withER') : null,
    brief || null,
  ].filter(Boolean).map(esc).join(' &middot; ');

  const lines = [];
  if (props.address) lines.push(esc(props.address));
  // Only repeat the hours below when the short form left something out.
  if (props.opening_hours && String(props.opening_hours).trim() !== brief) {
    lines.push(esc(t('hospital.open', { hours: props.opening_hours })));
  }

  return `
    <div class="popup-head">
      <span class="popup-glyph is-hospital" aria-hidden="true">\u{1F3E5}</span>
      <div>
        <p class="popup-kicker">${kicker}</p>
        <p class="popup-title">${esc(props.name)}</p>
      </div>
    </div>
    ${lines.length ? `<p class="popup-body">${lines.join('<br />')}</p>` : ''}
    ${directionsHTML(props)}
    <p class="popup-meta">${esc(t('hospital.source'))}</p>`;
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
    host.innerHTML = `<p class="empty-note">${
      esc(t(mine ? 'profile.empty' : 'profile.emptyOther'))}</p>`;
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
            ${r.city ? esc(r.city) + ' · ' : ''}${esc(categoryLabel(cat, r.category))} · ${timeAgo(r.happened_at)}
          </span>
          ${impactTags(r.impacts)}
          <div class="report-actions">
            <button class="chip-action" data-unconfirm="${id}">${esc(t('profile.unconfirm'))}</button>
          </div>
        </div>
      </article>`;
    }

    const actions = r.is_mine ? `
      <div class="report-actions">
        <button class="chip-action" data-edit="${id}">${esc(t('profile.edit'))}</button>
        <button class="chip-action" data-withdraw="${id}">${esc(t('reports.withdraw'))}</button>
      </div>
      <div class="withdraw-confirm" data-confirm="${id}" hidden>
        <span>${esc(t('profile.withdrawAsk'))}</span>
        <button class="chip-action is-danger" data-withdraw-yes="${id}">${esc(t('profile.withdrawYes'))}</button>
        <button class="chip-action" data-withdraw-no="${id}">${esc(t('profile.withdrawNo'))}</button>
      </div>
      <form class="edit-form" data-edit-form="${id}" hidden>
        <label for="edit-headline-${id}">${esc(t('profile.edit.headline'))}</label>
        <input id="edit-headline-${id}" name="headline" required minlength="8" maxlength="90"
               value="${esc(r.headline)}" />
        <label for="edit-description-${id}">${esc(t('profile.edit.description'))}</label>
        <textarea id="edit-description-${id}" name="description" required rows="3"
                  maxlength="1200">${esc(r.description ?? '')}</textarea>
        <label class="edit-when-toggle">
          <input type="checkbox" name="retime" /> ${esc(t('profile.edit.retime'))}
        </label>
        <div class="when-row" data-when hidden>
          <input type="date" name="date" value="${esc(when.date)}" aria-label="${esc(t('report.whenDate'))}" />
          <input type="time" name="time" value="${esc(when.time)}" aria-label="${esc(t('report.whenTime'))}" />
        </div>
        ${movable ? `
        <label class="edit-when-toggle">
          <input type="checkbox" name="remove" /> ${esc(t('profile.edit.remove'))}
        </label>
        <div data-where hidden>
          <div class="address-row">
            <input name="address" placeholder="${esc(t('report.addressPlaceholder'))}"
                   value="${esc(r.address ?? '')}" autocomplete="off" />
            <button type="button" class="ghost-button small" data-find="${id}">${esc(t('report.find'))}</button>
          </div>
          <p class="pin-status" data-pin-status>${esc(t('profile.edit.currently', {
            place: r.address || r.city || t('profile.edit.pinDropped'),
          }))}</p>
        </div>` : `
        <p class="field-hint">${esc(t('profile.edit.tooOld', { hours: moveWindowHours }))}</p>`}
        <div class="report-actions">
          <button class="chip-action is-primary" type="submit">${esc(t('profile.edit.save'))}</button>
          <button class="chip-action" type="button" data-edit-cancel="${id}">${esc(t('profile.edit.cancel'))}</button>
        </div>
      </form>` : '';

    return `
      <article class="profile-report${live ? '' : ' is-expired'}" data-report="${id}">
        <span class="report-glyph" aria-hidden="true">${esc(cat?.glyph ?? '⚠')}</span>
        <div class="report-copy">
          <button type="button" class="report-open" data-show="${id}">${esc(r.headline)}</button>
          <span class="report-meta">
            ${r.city ? esc(r.city) + ' · ' : ''}${esc(categoryLabel(cat, r.category))} · ${timeAgo(r.happened_at)}
          </span>
          ${impactTags(r.impacts)}
          <span class="profile-status">
            <span class="${live ? 'is-live' : 'is-gone'}">${esc(live
              ? plural('profile.onMap', daysLeft)
              : t('profile.offMap', { days: windowDays }))}</span>
            ${confirms ? `<span class="is-confirms">${esc(t('profile.confirms', { n: confirms }))}</span>` : ''}
            ${flagged ? `<span class="is-flagged">${esc(t('profile.flagged', { n: r.flag_count }))}</span>` : ''}
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
    tile('filed', filed, plural('profile.stat.filed', filed)) +
    tile('live', live, t('profile.stat.live')) +
    tile('received', received, t('profile.stat.received')) +
    tile('given', given, t('profile.stat.given'));
}

export const STAT_TITLE_KEYS = {
  filed: 'profile.list.filed',
  live: 'profile.list.live',
  received: 'profile.list.received',
  given: 'profile.list.given',
};

/**
 * The advisory dialog's body.
 *
 * German throughout, like the advisories themselves — see js/advisory.js for
 * why. What it shows is the level, the two dates, the country's emergency
 * numbers, and how many countries carry a warning right now; then a link out.
 * Never the advisory text.
 *
 * The prose that used to wrap all this said, at length, what the layout now
 * says by itself. A traveller reading a travel warning wants the number to
 * dial and the date it was written, not two paragraphs about our sourcing.
 */
export function advisoryDialogHTML(row, { level, tone, changed, checked, stats }) {
  if (!row) return `<p class="empty-note">${esc(ADVISORY.empty)}</p>`;

  const numbers = emergencyLine(row.country_code);
  const facts = [
    numbers && [ADVISORY.emergency, numbers],
    changed && [ADVISORY.changedKey, changed],
    checked && [ADVISORY.checkedKey, checked],
  ].filter(Boolean);

  const context = contextLine(stats);

  return `
    <div class="advisory-panel ${esc(tone)}">
      <p class="advisory-level">${esc(levelLabel(level))}</p>
      <p class="advisory-explain">${esc(levelExplain(level))}</p>
    </div>
    ${facts.length ? `<dl class="advisory-facts">${facts.map(([key, value]) =>
      `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>` : ''}
    ${context ? `<p class="advisory-context">${esc(context)}</p>` : ''}
    <a class="primary-button wide advisory-link" target="_blank" rel="noopener noreferrer"
       href="${esc(officialUrl(row.content_id))}">${esc(ADVISORY.readOfficial)}</a>
    <p class="fine-print">${esc(ADVISORY.sourceNote)}</p>`;
}

export function setGateNote(host, { mode, shown = 0, hiddenCount = 0, signedIn }) {
  if (signedIn) { host.hidden = true; return; }
  host.hidden = false;
  if (mode === 'summary') {
    host.innerHTML = t('gate.summary');
  } else if (hiddenCount > 0) {
    host.innerHTML = tn('gate.partial', hiddenCount,
      { shown, total: shown + hiddenCount, hidden: hiddenCount });
  } else {
    host.innerHTML = t('gate.invite');
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers. Everything a member typed passes through esc() before it
// reaches innerHTML — report text is untrusted input from strangers.
// ---------------------------------------------------------------------------
import { PIN_COLOR, METEOALARM_COUNTRIES } from './config.js';
import { hazardSignSVG } from './hazard-signs.js';
import { runningDays, stillRunning, eventName, isUpcoming } from './hazards.js';
import { t, tn, plural, tOr, formatDate, currentLanguage } from './i18n.js';
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
/**
 * How long a toast stays up. Short on purpose: it is an acknowledgement, not
 * something to read twice, and one lingering over a dialog somebody is trying
 * to use is in the way.
 */
const TOAST_MS = 2000;

/**
 * A message over everything, including an open dialog.
 *
 * The z-index used to lose to the report dialog, and the refusal for a pin in
 * the sea appeared behind the very window it was about. A modal <dialog> is in
 * the browser's top layer, which sits above every z-index there is, so the
 * only way over it is to be in the top layer too — which is what a popover is.
 *
 * Browsers without popover support fall back to the class alone: the toast is
 * then exactly as it was, which is worse than this but not broken.
 */
export function toast(message, { error = false } = {}) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.toggle('is-error', error);

  if (typeof el.showPopover === 'function') {
    // Closed and reopened even when it is already up. The top layer stacks in
    // the order things enter it and showPopover() on something already open
    // does nothing, so a toast left over from a moment ago would sit UNDER a
    // dialog opened since. Re-entering puts it back on top.
    try { if (el.matches(':popover-open')) el.hidePopover(); } catch { /* fine */ }
    try { el.showPopover(); } catch { /* fine */ }
  }
  // A frame later, so the slide-up animates from the hidden position rather
  // than being skipped along with the display change the popover just made.
  requestAnimationFrame(() => el.classList.add('show'));

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    if (typeof el.hidePopover === 'function') {
      // After it has slid away, not during.
      setTimeout(() => { try { el.hidePopover(); } catch { /* already closed */ } }, 300);
    }
  }, TOAST_MS);
}

/**
 * Put a toast that is already up back on top of the top layer.
 *
 * Call this after opening a dialog. The top layer paints in the order things
 * enter it, so a dialog opened after a toast covers it — which is what
 * happened to the refusal for a pin at the poles: it is decided the instant
 * you click, before the report window reopens behind it, where the refusal
 * for a pin at sea arrives a second later with the window already there.
 */
export function liftToast() {
  const el = document.querySelector('#toast');
  if (!el || typeof el.showPopover !== 'function') return;
  try {
    // Asked of the popover itself rather than the .show class: the class is
    // added a frame later, so a dialog opening in the same tick as the toast —
    // which is exactly what happens when a pin is refused on the spot — would
    // find it not yet "showing" and leave it underneath.
    if (!el.matches(':popover-open')) return;
    el.hidePopover();
    el.showPopover();
  } catch { /* fine */ }
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

/**
 * How far back to look, as one chip per answer.
 *
 * The labels are not "1 day", "2 days", "3 days": the first one is "Today",
 * because a day counted back from right now is what a person means by today
 * and "1 day" reads like a duration rather than a choice. The widest is named
 * for what it is — "All 7 days" — so the chip that shows everything says so
 * instead of looking like one more step on the ladder.
 */
export function renderAgeBar(host, chips, chosen, windowDays) {
  // Built once, then only ever updated. It would be shorter to rewrite
  // innerHTML every time, and that is what this did first — but the bar is
  // repainted on every pan and every refetch, and rewriting it throws away the
  // focused element. The cost was a keyboard: an arrow key moved the chip, the
  // refetch landed a moment later, and focus was on the body, so the next
  // arrow key went nowhere. Nothing a mouse would ever notice.
  const signature = `${chips.join(',')}|${windowDays}|${currentLanguage()}`;
  if (host.dataset.chips !== signature) {
    host.dataset.chips = signature;
    host.innerHTML = chips.map(days => {
      const label = days === 1 ? t('reports.when.today')
        : days >= windowDays ? t('reports.when.all', { n: windowDays })
        : plural('reports.when.days', days);
      return `<button type="button" class="age-chip" role="radio"
                      data-age="${days}">${esc(label)}</button>`;
    }).join('');
  }
  for (const chip of host.querySelectorAll('.age-chip')) {
    const on = Number(chip.dataset.age) === chosen;
    chip.classList.toggle('is-on', on);
    chip.setAttribute('aria-checked', String(on));
    chip.tabIndex = on ? 0 : -1;
  }
}

/**
 * The line above the list: how far back, and whose view of it.
 *
 * Both halves in one string rather than concatenated, because the separator
 * and the order of the two are a language's business, not ours.
 */
export function reportScopeLine({ mode, ageDays, windowDays }) {
  const when = ageDays === 1
    ? t('reports.when.today')
    : plural('reports.window.days', Math.min(ageDays, windowDays));
  return t(mode === 'member' ? 'reports.scope.member' : 'reports.scope.public', { when });
}

export function renderReportList(host, reports, { categories, mode, supported, signedIn,
                                                  narrowed = false }) {
  const byslug = new Map(categories.map(c => [c.slug, c]));

  if (!reports.length) {
    // "Nothing reported here in the last 7 days" is the wrong sentence when
    // the reader has just narrowed it to today: the right answer is that the
    // window is narrow, not that the place is quiet, and those two readings
    // lead somewhere different.
    const key = mode === 'summary' ? 'reports.empty.summary'
      : narrowed ? 'reports.empty.narrowed'
      : 'reports.empty.here';
    host.innerHTML = `<p class="empty-note">${esc(t(key))}</p>`;
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
    //
    // It carries the same on-the-map line and the same dulling as your own,
    // because the question a reader has is the same one — is this still up? —
    // and a list where half the rows answer it and half do not is a list that
    // looks broken.
    if (!mine) {
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
          </span>
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
 * why. What it shows is the level, the country's emergency numbers, the date
 * the ministry itself last updated the advisory, and how many countries carry
 * a warning right now; then a link out. Never the advisory text.
 *
 * When we last fetched it is deliberately not a row. It is our housekeeping,
 * not the reader's business, and on a daily refresh it says the same thing
 * every day. The context line carries the freshness promise instead — and
 * withdraws it if the refresh has plainly stopped.
 *
 * The prose that used to wrap all this said, at length, what the layout now
 * says by itself. A traveller reading a travel warning wants the number to
 * dial and the date it was written, not two paragraphs about our sourcing.
 */
export function advisoryDialogHTML(row, { level, tone, changed, stats, ageDays }) {
  if (!row) return `<p class="empty-note">${esc(ADVISORY.empty)}</p>`;

  const numbers = emergencyLine(row.country_code);
  const facts = [
    numbers && [ADVISORY.emergency, numbers],
    changed && [ADVISORY.changedKey, changed],
  ].filter(Boolean);

  const context = contextLine(stats, ageDays);

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

/**
 * An earthquake, clicked on the map.
 *
 * The magnitude and where, the agency's own words for the place, and a link to
 * GDACS. No advice: what to do about an earthquake that already happened is not
 * ours to say, and the one line that matters — that this is not an alert
 * service — is said plainly rather than implied.
 */
/**
 * How GDACS graded it, in GDACS's own words.
 *
 * Every alert level is shown on the map now, and most of what it publishes is
 * Green — seventy-two green wildfires on an ordinary day. Drawing those without
 * saying so would tell a reader there are seventy-two disasters. This is the
 * sentence that stops that being a lie, so it is on every hazard rather than
 * only the serious ones.
 */
/**
 * The grading, in two words.
 *
 * It used to name the agency — and named the wrong one for a while, saying
 * "Orange alert from GDACS" on weather warnings a national met office had
 * issued. That was fixed by keeping a string per agency, and then by noticing
 * that the popup already names the agency twice underneath: on the button you
 * press to go and read it, and in the legend that says whose data this is. So
 * the attribution goes where attribution belongs, the line says what it is for,
 * and there is no longer an agency here to get wrong.
 */
const gradeLine = (severity) => {
  const text = tOr(`hazard.grade.${severity}`, '');
  return text ? `<p class="popup-grade is-${esc(severity)}">${esc(text)}</p>` : '';
};

export function quakePopupHTML(props) {
  const magnitude = Number(props.magnitude);
  const when = props.at ? timeAgo(props.at) : '';
  const tsunami = props.tsunami === 'true' || props.tsunami === true;
  // How far down it was. A quake 158 km deep is felt far less than the same
  // one at 10 km, and that is most of what "was it serious here" means.
  const depthValue = Number(props.depth_km);
  const depth = Number.isFinite(depthValue) ? Math.round(depthValue) : null;

  return `
    <div class="popup-head">
      <span class="popup-glyph is-hazard">${hazardSignSVG('earthquake', { size: 26 })}</span>
      <div>
        <p class="popup-kicker">${esc(t('hazard.kind.earthquake'))}</p>
        <p class="popup-title">${esc(t('hazard.magnitude', {
          m: Number.isFinite(magnitude) ? magnitude.toFixed(1) : '?',
        }))}</p>
      </div>
    </div>
    ${props.place ? `<p class="popup-body">${esc(props.place)}</p>` : ''}
    ${gradeLine(props.severity)}
    ${depth ? `<p class="popup-fine">${esc(t('hazard.depth', { km: depth }))}</p>` : ''}
    ${tsunami ? `<p class="hazard-tsunami">${esc(t('hazard.tsunami'))}</p>` : ''}
    ${props.url ? `<div class="popup-actions">
      <a class="popup-action is-primary" href="${esc(props.url)}"
         target="_blank" rel="noopener noreferrer">${esc(t('hazard.official'))}</a>
    </div>` : ''}
    <p class="popup-meta">${esc(when)}${when ? ' \u00b7 ' : ''}${esc(t('hazard.source.quake'))}</p>`;
}

/**
 * A GDACS event, opened from its marker.
 *
 * Four things, and only one of them is ours: what kind of event it is, GDACS's
 * name for it, GDACS's grading, and GDACS's own MEASUREMENT — "Magnitude 5.2M,
 * Depth:10km", "Tropical storm (maximum wind speed of 120 km/h)". That last one
 * was being thrown away at the fetcher, which left the popup carrying three
 * lines of our prose about what a marker position means and nothing at all
 * about the event.
 *
 * What the position means still matters — a volcano is where it is, a cyclone
 * has moved since, a flood is a centroid that can sit in open water — but it is
 * the same sentence on every marker of that kind. It is said once in the
 * Disaster update panel now, where the markers are explained, instead of on
 * every single one of them.
 */
export function disasterPopupHTML(props) {
  const kind = String(props.kind ?? 'flood');

  // Three different sentences, because there are three different situations
  // and one of them used to be told wrong:
  //
  //   still running, days old   "Ongoing since 9 Aug"
  //   finished                  "Ended 28 Sep"      <- said "Ongoing" before
  //   happened just now         "4 h ago"
  //
  // "11 days ago" about a fire still burning says the opposite of the truth,
  // and so does "Ongoing since 9 Aug" about a flood the agency closed on the
  // 28th. Which one it is comes from to_date, the last moment GDACS vouched
  // for it — not from how long it ran.
  const day = { day: 'numeric', month: 'short' };
  const running = stillRunning(props);
  const when = !running && props.to_date
    ? t('hazard.ended', { when: formatDate(props.to_date, day) })
    : runningDays(props) >= 1
      ? t('hazard.since', { when: formatDate(props.from_date, day) })
      : (props.from_date ? timeAgo(props.from_date) : '');

  return `
    <div class="popup-head">
      <span class="popup-glyph is-hazard">${
        hazardSignSVG(kind, { size: 26, dull: !running })}</span>
      <div>
        <p class="popup-kicker">${esc(t(`hazard.kind.${kind}`))}</p>
        <p class="popup-title">${esc(eventName(props.name))}</p>
      </div>
    </div>
    ${gradeLine(props.severity)}
    ${props.measure ? `<p class="popup-measure">${esc(props.measure)}</p>` : ''}
    ${props.url ? `<div class="popup-actions">
      <a class="popup-action is-primary" href="${esc(props.url)}"
         target="_blank" rel="noopener noreferrer">${esc(t('hazard.official'))}</a>
    </div>` : ''}
    <p class="popup-meta">${esc(when)}${when ? ' \u00b7 ' : ''}${esc(t('disaster.source'))}</p>`;
}

/**
 * MeteoAlarm's own page for a country, in the reader's language.
 *
 * Why this exists. The popup used to offer one link: CAP's <web>, whatever the
 * issuing service put there. Across the live feeds that is anything from a real
 * warnings page — dwd.de/warnungen, met.ie/warnings, knmi.nl/waarschuwingen —
 * to a bare front door. Greece sends "https://www.emy.gr" on every one of its
 * warnings, so clicking a Greek rain warning opened a Greek weather homepage
 * with no sign of the warning you clicked.
 *
 * MeteoAlarm shows the same warning on a map, in the reader's language, the same
 * way for all thirty-eight countries. So that becomes the first link and the
 * service's own page stays as the second, named, because it is still the
 * authority and for half of them it is the better page.
 *
 * The URL shape is not guessed. Italy's own CAP feed publishes
 * "https://meteoalarm.org/en/live/region/IT?s=valle" — a national met service
 * using MeteoAlarm's URL, with the ISO code and a language segment in it. That
 * is as authoritative as a URL shape gets.
 */
// Every language this page is served in, each confirmed by asking MeteoAlarm for
// it and finding that language's own word for a warning in what came back:
//
//   /en/ warning   /de/ warnung    /it/ allerta       /fr/ vigilance
//   /es/ aviso     /nl/ waarschuwing   /pt/ aviso     /pl/ ostrzeż   /cs/ výstrah
//
// Checked that way rather than by status code, because the site is a
// single-page app that answers 200 to any path at all — a made-up /zz/ returns
// a page too, in English and visibly smaller than the real ones. Which also
// means a language we get wrong degrades to English rather than breaking.
const METEOALARM_LANGS = new Set(
  ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'cs']);

export function meteoalarmUrl(code) {
  const country = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  const spoken = String(currentLanguage() ?? 'en').slice(0, 2).toLowerCase();
  const lang = METEOALARM_LANGS.has(spoken) ? spoken : 'en';
  return `https://meteoalarm.org/${lang}/live/region/${country}`;
}

/**
 * When a weather warning applies, in one line.
 *
 * Three situations, and they are genuinely different things to tell somebody:
 *
 *   in force, with an end     "Until Fri 18:00"
 *   not yet started           "From Fri 06:00"
 *   in force, no end given    nothing — "until further notice" is a claim the
 *                             feed did not make, so we make none either
 *
 * The upcoming case is the one worth being careful about: a wind warning shown
 * without its start date reads as "it is windy now", and if it starts tomorrow
 * morning that is simply false.
 */
export function warningWhen(row) {
  const clock = { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  if (isUpcoming(row)) return t('weather.from', { when: formatDate(row.from_date, clock) });
  return row.to_date ? t('weather.until', { when: formatDate(row.to_date, clock) }) : '';
}

/**
 * Who is telling us, named, and through what if anything sits in between.
 *
 * The met service is the authority — the Deutscher Wetterdienst, NOAA's local
 * office — and `source` is its own name for itself. MeteoAlarm is the network
 * that carries Europe's, and naming it was right while Europe was all there
 * was; saying "via MeteoAlarm" under a Texas warning would be wrong, so it is
 * said only where it is true.
 */
export function warningCredit(rows) {
  const who = [...new Set(rows.map(w => w.source).filter(Boolean))].join(', ');
  const viaMeteoalarm = rows.some(w => METEOALARM_COUNTRIES.has(w.country_code));
  return t(viaMeteoalarm ? 'weather.source.meteoalarm' : 'weather.source', { who });
}

/**
 * A weather warning, opened from its marker.
 *
 * The line about what the position MEANS matters more here than anywhere else
 * on this map, because it is not the same thing twice. Where the service sent a
 * polygon, the marker is the middle of an area covering whole districts. Where
 * it sent only a name that nothing could place, the marker is the middle of the
 * COUNTRY — and saying "the centre of the area warned" about that would be a
 * lie with a precision attached. The popup says which, in words, and the areas
 * are named underneath either way.
 */
/**
 * The two ways out of a weather popup, in the order they are useful.
 *
 * MeteoAlarm first: one page, the reader's language, the warning drawn on a map,
 * and the same for every country. The issuing service second, named, because it
 * is the authority and because for several of them — the DWD, the KNMI, AEMET —
 * it is a better page than MeteoAlarm's. Named rather than called "official
 * details", so a reader can see where each one goes before clicking.
 */
function weatherLinks(props) {
  const meteoalarm = meteoalarmUrl(props.country_code);
  const service = String(props.source ?? '').trim();
  const links = [];
  if (meteoalarm) {
    links.push(`<a class="popup-action is-primary" href="${esc(meteoalarm)}"
      target="_blank" rel="noopener noreferrer">${esc(t('weather.onMeteoalarm'))}</a>`);
  }
  if (props.url) {
    // The service's own name on the button. "Official details" told a reader
    // nothing about which of two official places they were about to go to.
    links.push(`<a class="popup-action" href="${esc(props.url)}"
      target="_blank" rel="noopener noreferrer">${esc(service || t('hazard.official'))}</a>`);
  }
  return links.length ? `<div class="popup-actions">${links.join('')}</div>` : '';
}

export function weatherPopupHTML(props) {
  const kind = String(props.kind ?? 'wind');
  const when = warningWhen(props);
  const areas = String(props.areas ?? '').split(',').map(a => a.trim()).filter(Boolean);
  const shown = areas.slice(0, 6).join(', ');
  const rest = areas.length - 6;
  const also = Number(props.also) || 0;

  return `
    <div class="popup-head">
      <span class="popup-glyph is-hazard">${hazardSignSVG(kind, { size: 26 })}</span>
      <div>
        <p class="popup-kicker">${esc(t(`hazard.kind.${kind}`))}</p>
        <p class="popup-title">${esc(rest > 0 ? `${shown} +${rest}` : shown)}</p>
      </div>
    </div>
    ${gradeLine(props.severity)}
    ${isUpcoming(props) ? `<p class="hazard-upcoming">${esc(t('weather.upcoming'))}</p>` : ''}
    ${weatherLinks(props)}
    <p class="popup-meta">${esc(when)}${when && also ? ' \u00b7 ' : ''}${
      also ? esc(t('weather.alsoHere', { n: also })) : ''}</p>`;
}

/**
 * The severe weather in the country in view.
 *
 * The one hazard with nowhere to put a marker: a warning covers counties at a
 * time, so it is listed rather than drawn. Grouped by what is being warned of
 * — Spain publishes forty orange warnings on a wet afternoon, one per
 * province, and forty rows saying "Rain" is a list nobody reads to the bottom
 * of.
 *
 * Every row names the service that issued it, because that is the authority
 * here, and nothing in it is ours.
 */
export function weatherDialogHTML(rows) {
  if (!rows?.length) return `<p class="empty-note">${esc(t('weather.none'))}</p>`;

  // Grouped by what is warned of, how badly, and WHETHER IT HAS STARTED. That
  // last part is not a detail: merging a wind warning in force now with one
  // that begins on Friday into a single "Wind" row would be a sentence that is
  // half true, and the reader has no way to tell which half.
  const groups = new Map();
  for (const row of rows) {
    const ahead = isUpcoming(row);
    const key = `${row.kind}|${row.severity}|${ahead}`;
    const group = groups.get(key) ?? { ...row, areas: [], ahead };
    for (const area of String(row.areas ?? '').split(',').map(a => a.trim())) {
      if (area && area !== '…' && !group.areas.includes(area)) group.areas.push(area);
    }
    // The furthest-out end time, so the row says when the last of them lifts —
    // and for a group that has not started, the SOONEST start, because the
    // question there is "from when do I have to think about this".
    if (!group.to_date || (row.to_date && row.to_date > group.to_date)) {
      group.to_date = row.to_date;
    }
    if (ahead && row.from_date && (!group.from_date || row.from_date < group.from_date)) {
      group.from_date = row.from_date;
    }
    groups.set(key, group);
  }

  // In force first. What is happening now outranks what might happen on Friday,
  // and within each half the red ones come before the orange ones.
  const order = (row) => (row.ahead ? 2 : 0) + (row.severity === 'severe' ? 0 : 1);

  const entries = [...groups.values()].sort((a, b) => order(a) - order(b)).map(row => {
    const shown = row.areas.slice(0, 8).join(', ');
    const rest = row.areas.length - 8;
    const when = warningWhen(row);
    return `
      <div class="disaster-row is-${esc(row.severity)}${row.ahead ? ' is-upcoming' : ''}">
        <span class="disaster-sign">${hazardSignSVG(row.kind, { size: 26 })}</span>
        <p class="disaster-kind">${esc(t(`hazard.kind.${row.kind}`))}</p>
        <p class="disaster-name">${esc(rest > 0 ? `${shown} +${rest}` : shown)}</p>
        ${when ? `<p class="disaster-when">${esc(when)}</p>` : ''}
        ${(() => {
          const meteoalarm = meteoalarmUrl(row.country_code);
          const out = [];
          if (meteoalarm) {
            out.push(`<a class="disaster-link" href="${esc(meteoalarm)}"
               target="_blank" rel="noopener noreferrer">${esc(t('weather.onMeteoalarm'))}</a>`);
          }
          if (row.url) {
            out.push(`<a class="disaster-link is-quiet" href="${esc(row.url)}"
               target="_blank" rel="noopener noreferrer">${esc(
                 String(row.source ?? '').trim() || t('hazard.official'))}</a>`);
          }
          return out.join(' ');
        })()}
      </div>`;
  }).join('');

  return `${entries}
    <p class="popup-meta">${esc(warningCredit(rows))}</p>
    <p class="fine-print">${esc(t('hazard.notAlert'))}</p>`;
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

// ---------------------------------------------------------------------------
// Standing: a level, a bar, and any badges.
// ---------------------------------------------------------------------------

/** Every badge the database can hold, in the order they are shown. */
export const BADGES = ['creator', 'top', 'founder', 'partner'];

const BADGE_GLYPH = { creator: '🎥', top: '🏅', founder: '🌱', partner: '🤝' };

/**
 * One badge, as a chip with its meaning on hover.
 *
 * A badge the page has no string for is drawn as nothing rather than as its
 * slug. Somebody adding a fifth kind in SQL before adding it to js/locales
 * should see it missing, not see `partner_2` on a stranger's profile in nine
 * languages.
 */
export function badgeChip(slug) {
  const name = tOr(`badge.${slug}`, '');
  if (!name) return '';
  return `<span class="badge-chip" title="${esc(tOr(`badge.${slug}.note`, name))}"
    ><span aria-hidden="true">${BADGE_GLYPH[slug] ?? '★'}</span>${esc(name)}</span>`;
}

/**
 * Where you are on the ladder.
 *
 * The bar measures the CURRENT rung rather than the whole climb — the distance
 * from the points that got you to this level to the points that reach the
 * next. A bar against the top of the ladder would sit at four percent for
 * almost everybody and tell them nothing except that they are nowhere, which
 * is the failure that makes hundred-level systems feel pointless.
 */
export function renderStanding(host, standing) {
  if (!standing) { host.hidden = true; return; }
  host.hidden = false;

  const level = Number(standing.level) || 1;
  const points = Number(standing.points) || 0;
  const floor = Number(standing.level_floor) || 0;
  const next = standing.next_points == null ? null : Number(standing.next_points);

  const span = next == null ? 0 : Math.max(next - floor, 1);
  const done = next == null ? 1 : Math.min(Math.max((points - floor) / span, 0), 1);

  const name = tOr(`level.${level}`, '');
  const badges = (standing.badges ?? []).map(badgeChip).join('');

  host.innerHTML = `
    <div class="standing-head">
      <p class="standing-level">
        <span class="standing-number">${t('profile.level.n', { n: level })}</span>
        ${name ? `<span class="standing-name">${esc(name)}</span>` : ''}
      </p>
      <p class="standing-points">${esc(plural('profile.level.points', points))}</p>
    </div>
    ${badges ? `<div class="badge-row">${badges}</div>` : ''}
    <div class="standing-bar" role="img"
         aria-label="${esc(next == null
            ? t('profile.level.max')
            : tn('profile.level.toNext', next - points, { level: level + 1 }))}">
      <i style="width:${(done * 100).toFixed(1)}%"></i>
    </div>
    <p class="standing-next">${esc(next == null
      ? t('profile.level.max')
      : tn('profile.level.toNext', next - points, { level: level + 1 }))}</p>
    <p class="standing-how">${esc(t('profile.level.how'))}</p>`;
}

/** The members who asked to be named. */
export function renderBoard(host, rows) {
  if (!rows.length) {
    host.innerHTML = `<p class="empty-note">${esc(t('profile.board.empty'))}</p>`;
    return;
  }
  host.innerHTML = rows.map((r, i) => `
    <div class="board-row">
      <span class="board-rank">${i + 1}</span>
      <span class="board-name">${esc(r.display_name ?? '')}</span>
      <span class="board-badges">${(r.badges ?? []).map(badgeChip).join('')}</span>
      <span class="board-level">${esc(t('profile.level.n', { n: Number(r.level) || 1 }))}</span>
    </div>`).join('');
}

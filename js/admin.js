// ---------------------------------------------------------------------------
// The admin panel: who the members are, and what each of them is.
//
// ENGLISH ONLY — see the comment in admin.html for why.
//
// WHAT PROTECTS THIS. Not this file. Every call it makes is refused by the
// database unless auth.uid() belongs to somebody whose profile row says
// 'admin', and that check runs inside each function rather than here. A page
// is a suggestion: anybody can open a console and call the same things. So the
// rule is that nothing in here decides anything — it asks, and shows what came
// back. Hiding the controls from a member is manners, not security.
// ---------------------------------------------------------------------------
import { bootPage } from './page.js';
import { initAuth, onAuthChange } from './auth.js';
import { esc, toast, badgeChip, EARNED_BADGES, BADGES } from './ui.js';
import { formatDate } from './i18n.js';
import { adminLocks, adminSetLock, adminClearLock, lockScopes,
         adminNotices, adminPostNotice, adminDropNotice } from './data.js';
import { amAdmin, adminMembers, adminSetRole, adminSetLevel, adminSetReportLimit,
         adminSetBadge, adminClearBadge,
         adminSetListed, adminRemoveMember, adminReports, adminSetReportStatus,
         adminDeleteReport, contributorLadder, adminSetLevels, adminRegionCatalog,
         adminBlockedRegions, adminSetBlockedRegions, adminSettings,
         adminSetSetting, adminMemberCountries } from './data.js';

const $ = (sel) => document.querySelector(sel);
const ROLES = ['member', 'moderator', 'admin'];

const state = {
  me: null, admin: false, pending: null,
  tab: 'members',
  members: [], search: '', role: '', memberLevel: '', country: '', countries: [],
  reports: [], reportFilter: 'flagged', reportSearch: '',
  // The ladder is edited as a whole and only sent when Save is pressed: it is
  // valid as a set, not a row at a time, so a half-edited one must not reach
  // the database.
  levels: [],
  locks: [], notices: [], scopes: [], groups: [],
  regions: [], blocked: { countries: [], groups: [], closed: 0 }, regionSearch: '',
  settings: [],
};

// --- what the page is allowed to be ----------------------------------------
async function decideAccess() {
  state.admin = Boolean(state.me) && await amAdmin();

  const gate = $('#admin-gate');
  const body = $('#admin-body');
  $('#admin-signin').hidden = Boolean(state.me);

  if (!state.me) {
    $('#admin-lede').textContent = 'This page is for administrators.';
    $('#admin-gate-note').textContent = 'Sign in on the map first, then come back.';
    gate.hidden = false; body.hidden = true;
    return;
  }
  if (!state.admin) {
    $('#admin-lede').textContent = 'This page is for administrators.';
    $('#admin-gate-note').textContent =
      `Signed in as ${state.me.email ?? 'a member'}, who is not one. `
      + 'An existing admin can change that here; the first one is made in the SQL editor.';
    gate.hidden = false; body.hidden = true;
    return;
  }
  gate.hidden = true; body.hidden = false;
  await showTab(state.tab);
}

// --- tabs -------------------------------------------------------------------
const TABS = ['members', 'reports', 'levels', 'locks', 'notices', 'regions', 'settings'];

// The heading follows the tab. Leaving it on "Members" while the Reports
// screen is open reads as a page that did not notice it had changed.
const HEADINGS = {
  members: ['Members',
    'Roles, levels and badges. Everything here is checked again by the '
    + 'database, so a mistake is refused rather than applied.'],
  reports: ['Reports',
    'What people filed, and what to do about the ones somebody flagged. '
    + 'Approving clears the flags; hiding keeps the report; deleting does not.'],
  levels: ['Levels',
    'The ladder every member climbs, and how far apart its rungs are. '
    + 'Changing it recomputes everybody at once.'],
  locks: ['Locks',
    'Switch a layer off in one country, or every layer at once. Temporary or '
    + 'until lifted. Hiding reports already filed takes warnings away from '
    + 'travellers, so it is a separate switch from pausing new ones.'],
  notices: ['Notices',
    'Something the feeds do not carry — a protest, a strike, a border '
    + 'closure — shown over the country it is about until you take it down.'],
  regions: ['Regions',
    'Where new reports are refused. Reading is never affected — everything '
    + 'already on the map stays visible everywhere, to everyone.'],
  settings: ['Settings',
    'The numbers that change how the site behaves, applied the moment they '
    + 'are saved.'],
};
const LOADERS = {
  members: load,
  reports: loadReports,
  levels: loadLevels,
  locks: loadLocks,
  notices: loadNotices,
  regions: loadRegions,
  settings: loadSettings,
};

async function showTab(name) {
  if (!TABS.includes(name)) return;
  state.tab = name;
  const [title, lede] = HEADINGS[name];
  $('#admin-title').textContent = title;
  $('#admin-lede').textContent = lede;
  for (const tab of document.querySelectorAll('.admin-tab')) {
    const on = tab.dataset.tab === name;
    tab.classList.toggle('is-on', on);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('.admin-panel')) {
    panel.hidden = panel.id !== `tab-${name}`;
  }
  // Fetched when first opened rather than on load: five screens' worth of
  // queries for the one somebody wanted is five times the wait.
  await LOADERS[name]?.();
}

$('.admin-tabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('.admin-tab');
  if (tab) showTab(tab.dataset.tab);
});

$('.admin-tabs')?.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const at = TABS.indexOf(state.tab);
  const next = TABS[(at + step + TABS.length) % TABS.length];
  showTab(next);
  $(`.admin-tab[data-tab="${next}"]`)?.focus();
});

async function load() {
  $('#admin-list').innerHTML = '<p class="empty-note">Loading…</p>';
  try {
    state.members = await adminMembers({
      search: state.search,
      role: state.role,
      level: state.memberLevel ? Number(state.memberLevel) : null,
      country: state.country,
    });
    paint();
  } catch (err) {
    $('#admin-list').innerHTML = `<p class="empty-note">${esc(err.message)}</p>`;
  }
  // Both lists are of what is actually there, so they are filled from the
  // database rather than written out here — a level that no longer exists or a
  // country nobody has reported in would otherwise sit in the dropdown
  // promising results it cannot give.
  if (!state.countries.length) {
    const [countries, ladder] = await Promise.all([
      adminMemberCountries(), contributorLadder(),
    ]);
    state.countries = countries;
    $('#member-country').innerHTML = '<option value="">Anywhere</option>'
      + countries.map(c => `<option value="${esc(c.country_code)}">${esc(c.country_code)}
          — ${c.members} ${c.members === 1 ? 'member' : 'members'}</option>`).join('');
    $('#member-level').innerHTML = '<option value="">Any level</option>'
      + ladder.map(([level]) => `<option value="${level}">Level ${level}</option>`).join('');
  }
}

// --- drawing ----------------------------------------------------------------
function memberRow(m) {
  const mine = m.id === state.me?.id;
  const given = m.level_override != null;
  return `
    <article class="admin-row" data-id="${esc(m.id)}">
      <div class="ar-who">
        <p class="ar-name">${esc(m.display_name || '(no nickname)')}
          ${mine ? '<span class="ar-you">you</span>' : ''}</p>
        <p class="ar-mail">${esc(m.email ?? '—')}</p>
        <p class="ar-meta">${m.points} points · ${m.reports} reports ·
          joined ${esc(formatDate(m.created_at, { year: 'numeric', month: 'short' }))}</p>
        ${(m.countries ?? []).length
          ? `<p class="ar-where">reports in ${(m.countries ?? []).map(c =>
              `<span class="ar-cc">${esc(c)}</span>`).join(' ')}</p>`
          : ''}
      </div>

      <div class="ar-controls">
        <label class="ar-field">
          <span>Role</span>
          <select data-act="role">
            ${ROLES.map(r => `<option value="${r}"${r === m.role ? ' selected' : ''}>${r}</option>`).join('')}
          </select>
        </label>

        <label class="ar-field">
          <span>Level${given ? ' (given)' : ''}</span>
          <select data-act="level">
            <option value="">earned — level ${m.level}</option>
            ${Array.from({ length: 10 }, (_, i) => i + 1).map(n =>
              `<option value="${n}"${given && m.level_override === n ? ' selected' : ''}>level ${n}</option>`).join('')}
          </select>
        </label>

        <label class="ar-field">
          <span>Reports a day${m.daily_report_limit ? ' (given)' : ''}</span>
          <input type="number" min="1" max="500" step="1" data-act="allowance"
                 placeholder="${m.daily_quota ?? ''}"
                 value="${m.daily_report_limit ?? ''}"
                 title="Empty means whatever their level and badge allow — ${m.daily_quota ?? '?'} a day right now. A number here can only raise that, never lower it." />
        </label>

        <label class="ar-check">
          <input type="checkbox" data-act="listed"${m.listed ? ' checked' : ''} />
          <span>On the contributors list</span>
        </label>
      </div>

      <!-- Every badge, with a checkbox on each, because an admin can say yes
           or no about any of them. The seven earned ones have a THIRD state
           the other four do not: no opinion, which is the normal one and means
           whatever this member's reports add up to. A checkbox cannot show
           three states, so the undo beside it does — it appears only on a
           badge somebody decided by hand, and puts it back on the count.
           Taking an earned badge away has to be a stored decision and not a
           deleted row: the reports that earned it have not gone anywhere, so a
           delete would hand it straight back on the next load. -->
      <div class="ar-badges">
        ${BADGES.map(slug => {
          const has = (m.badges ?? []).includes(slug);
          const byHand = Object.prototype.hasOwnProperty.call(m.overrides ?? {}, slug);
          const earnable = EARNED_BADGES.includes(slug);
          return `
          <label class="ar-badge${has ? ' is-on' : ''}${byHand && earnable ? ' is-hand' : ''}">
            <input type="checkbox" data-act="badge" data-badge="${slug}"
                   ${has ? 'checked' : ''} />
            ${badgeChip(slug)}
            ${earnable ? `<button type="button" class="ar-auto" data-act="badge-auto"
                   data-badge="${slug}" title="Back to whatever they earned"
                   ${byHand ? '' : 'hidden'}>&#8634;</button>` : ''}
          </label>`;
        }).join('')}
      </div>
      <p class="ar-badge-note">Ticked without the ${'\u21BA'} is earned from their
         reports and keeps itself up to date.</p>

      <div class="ar-danger">
        <button type="button" class="link-danger" data-act="remove"
                ${mine ? 'disabled title="Close your own account from your profile"' : ''}>Remove member</button>
      </div>
    </article>`;
}

function paint() {
  const n = state.members.length;
  const filtered = Boolean(state.search || state.role || state.memberLevel || state.country);
  $('#admin-count').textContent =
    `${n === 1 ? '1 member' : `${n} members`}${filtered ? ' matching' : ''}`;
  $('#admin-list').innerHTML = n
    ? state.members.map(memberRow).join('')
    : `<p class="empty-note">${filtered
        ? 'Nobody matches all of those. Reset to see everybody.'
        : 'No members yet.'}</p>`;
}

/** Replace one member in place, so the whole list is not rebuilt under a cursor. */
function refreshRow(id, changes) {
  const i = state.members.findIndex(m => m.id === id);
  if (i < 0) return;
  state.members[i] = { ...state.members[i], ...changes };
  $(`.admin-row[data-id="${CSS.escape(id)}"]`)?.outerHTML; // keep the node for focus
  const node = $(`.admin-row[data-id="${CSS.escape(id)}"]`);
  if (node) node.outerHTML = memberRow(state.members[i]);
}

/** Put a control back where it was when the database said no. */
// The second argument is optional. It was not, and a caller that passed only
// the work crashed the page with "Cannot destructure property 'onFail' of
// undefined" — which is a strange way for a form to tell you it refused.
async function attempt(work, { onFail } = {}) {
  try {
    await work();
  } catch (err) {
    toast(err.message, { error: true });
    onFail?.();
  }
}

// --- acting -----------------------------------------------------------------
$('#admin-list').addEventListener('change', async (e) => {
  const row = e.target.closest('.admin-row');
  if (!row) return;
  const id = row.dataset.id;
  const act = e.target.dataset.act;
  const member = state.members.find(m => m.id === id);
  if (!member) return;

  if (act === 'role') {
    const wanted = e.target.value;
    await attempt(async () => {
      await adminSetRole(id, wanted);
      member.role = wanted;
      toast(`${member.display_name || 'They'} are now ${wanted}.`);
    }, { onFail: () => { e.target.value = member.role; } });
  }

  if (act === 'level') {
    const wanted = e.target.value === '' ? null : Number(e.target.value);
    await attempt(async () => {
      const now = await adminSetLevel(id, wanted);
      refreshRow(id, { level_override: wanted, level: now });
      toast(wanted ? `Level ${wanted}, given.` : 'Back to the level they have earned.');
    }, { onFail: () => { e.target.value = member.level_override ?? ''; } });
  }

  if (act === 'allowance') {
    const raw = e.target.value.trim();
    const wanted = raw === '' ? null : Number(raw);
    await attempt(async () => {
      const now = await adminSetReportLimit(id, wanted);
      refreshRow(id, { daily_report_limit: wanted, daily_quota: now });
      // The number in force, not the number typed: setting 3 on a partner
      // leaves them on 20, and saying "3 a day" there would be a lie the
      // console told about its own database.
      toast(wanted
        ? `${member.display_name || 'They'} may file ${now} a day.`
        : `Back to what their level and badge allow — ${now} a day.`);
    }, { onFail: () => { e.target.value = member.daily_report_limit ?? ''; } });
  }

  if (act === 'listed') {
    const wanted = e.target.checked;
    await attempt(async () => {
      await adminSetListed(id, wanted);
      member.listed = wanted;
    }, { onFail: () => { e.target.checked = !wanted; } });
  }

  if (act === 'badge') {
    const badge = e.target.dataset.badge;
    const wanted = e.target.checked;
    await attempt(async () => {
      const badges = await adminSetBadge(id, badge, wanted);
      member.badges = badges;
      // The decision is recorded for an earned badge whichever way it went —
      // "not this person" is as much a decision as "yes this one" — so the
      // undo appears on both.
      if (EARNED_BADGES.includes(badge)) member.overrides = { ...(member.overrides ?? {}), [badge]: wanted };
      paintBadgeState(e.target.closest('.ar-badge'), badge, member);
    }, { onFail: () => { e.target.checked = !wanted; } });
  }
});

/** Put one badge's controls back in step with what the member now has. */
function paintBadgeState(label, badge, member) {
  if (!label) return;
  const has = (member.badges ?? []).includes(badge);
  const byHand = Object.prototype.hasOwnProperty.call(member.overrides ?? {}, badge);
  label.classList.toggle('is-on', has);
  label.classList.toggle('is-hand', byHand && EARNED_BADGES.includes(badge));
  const input = label.querySelector('input[data-act="badge"]');
  if (input) input.checked = has;
  const undo = label.querySelector('[data-act="badge-auto"]');
  if (undo) undo.hidden = !byHand;
}

// Back to automatic. Not the same as switching it off: off outlives the next
// twenty reports, this is the absence of an opinion.
$('#admin-list').addEventListener('click', async (e) => {
  if (e.target.dataset.act !== 'badge-auto') return;
  e.preventDefault();
  const row = e.target.closest('.admin-row');
  const id = row?.dataset.id;
  const member = state.members.find(m => m.id === id);
  const badge = e.target.dataset.badge;
  if (!member) return;
  await attempt(async () => {
    member.badges = await adminClearBadge(id, badge);
    const rest = { ...(member.overrides ?? {}) };
    delete rest[badge];
    member.overrides = rest;
    paintBadgeState(e.target.closest('.ar-badge'), badge, member);
    toast('Back to whatever they earned.');
  }, { onFail: () => {} });
});

// Removing somebody is the one thing here that cannot be undone, so it asks
// first and names who it is about — a confirm dialog that does not say the
// name is a dialog people click through.
$('#admin-list').addEventListener('click', (e) => {
  if (e.target.dataset.act !== 'remove') return;
  const id = e.target.closest('.admin-row')?.dataset.id;
  const member = state.members.find(m => m.id === id);
  if (!member) return;
  state.pending = { kind: 'member', id };
  $('#confirm-title').textContent = 'Remove this member?';
  $('#confirm-text').textContent =
    `${member.display_name || member.email || 'This member'} and their ${member.reports} `
    + `report${member.reports === 1 ? '' : 's'} will be deleted. This cannot be undone.`;
  $('#confirm-dialog').showModal();
});

$('#confirm-no').addEventListener('click', () => $('#confirm-dialog').close());
$('[data-close="confirm-dialog"]').addEventListener('click', () => $('#confirm-dialog').close());
$('#confirm-yes').addEventListener('click', async () => {
  const asked = state.pending;
  state.pending = null;
  $('#confirm-dialog').close();
  if (!asked) return;
  await attempt(async () => {
    if (asked.kind === 'member') {
      await adminRemoveMember(asked.id);
      state.members = state.members.filter(m => m.id !== asked.id);
      paint();
    } else {
      await adminDeleteReport(asked.id);
      state.reports = state.reports.filter(r => r.id !== asked.id);
      paintReports();
    }
    toast('Deleted.');
  }, {});
});

let searching;
$('#admin-search').addEventListener('input', (e) => {
  state.search = e.target.value.trim();
  clearTimeout(searching);
  searching = setTimeout(load, 250);
});

// The three dropdowns filter immediately — there is nothing to debounce about
// a choice from a list, and waiting 250ms after one reads as lag.
for (const [id, key] of [['#member-role', 'role'], ['#member-level', 'memberLevel'],
                         ['#member-country', 'country']]) {
  $(id).addEventListener('change', (e) => { state[key] = e.target.value; load(); });
}

$('#member-reset').addEventListener('click', () => {
  state.search = state.role = state.memberLevel = state.country = '';
  $('#admin-search').value = '';
  for (const id of ['#member-role', '#member-level', '#member-country']) $(id).value = '';
  load();
});

$('#admin-signin').addEventListener('click', () => { window.location.href = 'index.html#map'; });

// --- reports ----------------------------------------------------------------
const STATUS_WORD = {
  published: 'On the map',
  under_review: 'Hidden, under review',
  removed: 'Taken down',
};

function reportRow(r) {
  const flags = (r.reasons ?? []).join(', ');
  const when = formatDate(r.happened_at, { day: 'numeric', month: 'short', year: 'numeric' });
  return `
    <article class="admin-row report-row" data-id="${esc(r.id)}">
      <div class="ar-who">
        <p class="ar-name">${esc(r.headline)}</p>
        <p class="ar-meta">
          <span class="rr-status is-${esc(r.status)}">${esc(STATUS_WORD[r.status] ?? r.status)}</span>
          ${r.flag_count > 0 ? `<span class="rr-flags">⚑ ${r.flag_count}${flags ? ' · ' + esc(flags) : ''}</span>` : ''}
          ${r.support_count > 0 ? `<span class="rr-ok">✓ ${r.support_count}</span>` : ''}
        </p>
        <p class="ar-meta">${esc(r.city || '—')}${r.country_code ? ' · ' + esc(r.country_code) : ''}
          · ${esc(when)} · filed by ${esc(r.reporter ?? '—')}
          ${r.on_the_map ? '' : '· <em>not on the map</em>'}</p>
        <p class="rr-text">${esc(r.description)}</p>
      </div>
      <div class="ar-controls">
        ${r.status !== 'published' ? '<button type="button" class="ghost-button small" data-act="approve">Approve</button>' : ''}
        ${r.status !== 'under_review' ? '<button type="button" class="ghost-button small" data-act="hide">Hide</button>' : ''}
        ${r.status !== 'removed' ? '<button type="button" class="ghost-button small" data-act="takedown">Take down</button>' : ''}
        <button type="button" class="link-danger" data-act="delete">Delete</button>
      </div>
    </article>`;
}

function paintReports() {
  const n = state.reports.length;
  $('#report-count').textContent = n === 1 ? '1 report' : `${n} reports`;
  $('#report-admin-list').innerHTML = n
    ? state.reports.map(reportRow).join('')
    : '<p class="empty-note">Nothing here.</p>';
}

async function loadReports() {
  $('#report-admin-list').innerHTML = '<p class="empty-note">Loading…</p>';
  try {
    state.reports = await adminReports(state.reportFilter, state.reportSearch, 100);
    paintReports();
  } catch (err) {
    $('#report-admin-list').innerHTML = `<p class="empty-note">${esc(err.message)}</p>`;
  }
}

$('#report-filter').addEventListener('change', (e) => {
  state.reportFilter = e.target.value;
  loadReports();
});

let reportSearching;
$('#report-search').addEventListener('input', (e) => {
  state.reportSearch = e.target.value.trim();
  clearTimeout(reportSearching);
  reportSearching = setTimeout(loadReports, 250);
});

$('#report-admin-list').addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  const id = e.target.closest('.report-row')?.dataset.id;
  if (!act || !id) return;

  if (act === 'delete') {
    const report = state.reports.find(r => r.id === id);
    state.pending = { kind: 'report', id };
    $('#confirm-title').textContent = 'Delete this report?';
    $('#confirm-text').textContent =
      `“${report?.headline ?? 'This report'}” will be gone for good. `
      + 'To take it off the map without deleting it, use Hide instead.';
    $('#confirm-dialog').showModal();
    return;
  }

  const status = { approve: 'published', hide: 'under_review', takedown: 'removed' }[act];
  if (!status) return;
  await attempt(async () => {
    await adminSetReportStatus(id, status);
    toast(act === 'approve' ? 'Approved, and its flags cleared.' : `Now ${STATUS_WORD[status].toLowerCase()}.`);
    await loadReports();
  }, {});
});

// --- the ladder -------------------------------------------------------------
function paintLevels() {
  $('#levels-admin').innerHTML = `
    <thead><tr><th scope="col">Level</th><th scope="col">Points needed</th>
      <th scope="col">Reports a day</th></tr></thead>
    <tbody>${state.levels.map(([level, points, quota], i) => `
      <tr>
        <th scope="row">Level ${level}</th>
        <td><input type="number" min="0" step="1" value="${points}" data-field="points"
                   data-row="${i}" ${i === 0 ? 'disabled title="Level 1 is where everybody starts"' : ''} /></td>
        <td><input type="number" min="1" max="500" step="1" value="${quota}"
                   data-field="quota" data-row="${i}" /></td>
      </tr>`).join('')}</tbody>`;
  $('#level-drop').disabled = state.levels.length <= 1;
}

async function loadLevels() {
  state.levels = await contributorLadder();
  paintLevels();
}

$('#levels-admin').addEventListener('input', (e) => {
  const row = Number(e.target.dataset.row);
  if (!Number.isInteger(row)) return;
  // Which column was typed in. Before the allowance existed there was only
  // one number per rung and this wrote blindly to index 1, which with two
  // columns would have quietly saved the allowance as the points threshold.
  const at = e.target.dataset.field === 'quota' ? 2 : 1;
  state.levels[row][at] = Number(e.target.value);
});

$('#level-add').addEventListener('click', () => {
  const [lastLevel, lastPoints, lastQuota] = state.levels[state.levels.length - 1] ?? [0, 0, 5];
  state.levels.push([lastLevel + 1, lastPoints + 100, lastQuota]);
  paintLevels();
});

$('#level-drop').addEventListener('click', () => {
  if (state.levels.length > 1) state.levels.pop();
  paintLevels();
});

$('#levels-save').addEventListener('click', async () => {
  await attempt(async () => {
    const saved = await adminSetLevels(
      state.levels.map(([level, min_points, daily_quota]) =>
        ({ level, min_points, daily_quota })));
    state.levels = saved.map(r =>
      [Number(r.level), Number(r.min_points), Number(r.daily_quota ?? 5)]);
    paintLevels();
    toast('The ladder is saved, and every level recomputed with it.');
  }, { onFail: loadLevels });     // a refused ladder must not stay on screen
});

// --- locks ------------------------------------------------------------------
//
// What each scope is called on screen, and what it actually does. The slugs
// come from the database — lock_scopes() — so a scope added there appears here
// with a readable name rather than as a bare slug, and one removed there
// disappears from the form instead of lingering as a box that does nothing.
const SCOPE_WORDS = {
  reports_new: ['Pause new reports',
    'Nobody can file a report there. What is already on the map stays.'],
  reports:     ['Hide reports already filed',
    'Takes existing warnings away from travellers in that country. Rarely the right answer.'],
  advisories:  ['Hide the travel advisory', 'For when the ministry feed is wrong or stale.'],
  disasters:   ['Hide disaster alerts', 'For when GDACS is reporting nonsense there.'],
  weather:     ['Hide weather warnings', 'For when MeteoAlarm is reporting nonsense there.'],
  safety:      ['Hide police and hospitals', 'For when the OpenStreetMap data is badly wrong.'],
};

function paintLockForm() {
  $('#lock-scopes').innerHTML = '<legend>What to switch off</legend>'
    + state.scopes.map(slug => {
        const [name, why] = SCOPE_WORDS[slug] ?? [slug, ''];
        return `<label class="scope-pick${slug === 'reports' ? ' is-heavy' : ''}">
          <input type="checkbox" value="${esc(slug)}" />
          <span><strong>${esc(name)}</strong>${why ? `<em>${esc(why)}</em>` : ''}</span>
        </label>`;
      }).join('');
}

function lockRow(l) {
  const words = (l.scopes ?? []).map(s => (SCOPE_WORDS[s] ?? [s])[0]).join(', ');
  const whole = (l.scopes ?? []).length === state.scopes.length && state.scopes.length > 0;
  return `<tr class="${l.in_force ? '' : 'is-done'}" data-country="${esc(l.country_code)}">
    <th scope="row">${esc(l.country_code)}</th>
    <td>${whole ? '<strong>Everything</strong>' : esc(words)}</td>
    <td>${l.until
          ? `until ${esc(new Date(l.until).toLocaleString())}`
          : (l.in_force ? 'until lifted' : '—')}</td>
    <td class="set-note">${esc(l.note ?? '')}</td>
    <td>${l.in_force
          ? '<button class="ghost-button small" data-act="unlock" type="button">Lift</button>'
          : 'expired'}</td>
  </tr>`;
}

function paintLocks() {
  $('#locks-admin').innerHTML = state.locks.length
    ? `<thead><tr><th scope="col">Country</th><th scope="col">Switched off</th>
         <th scope="col">For how long</th><th scope="col">Why (ours)</th><th scope="col"></th>
       </tr></thead><tbody>${state.locks.map(lockRow).join('')}</tbody>`
    : '<tbody><tr><td class="set-note">Nothing is locked anywhere.</td></tr></tbody>';
}

async function loadLocks() {
  // The scope list first: the form and the table both name scopes from it.
  if (!state.scopes.length) state.scopes = await lockScopes();
  if (!$('#lock-group').options.length || $('#lock-group').options.length === 1) {
    const groups = await adminRegionCatalog();
    $('#lock-group').innerHTML = '<option value="">—</option>'
      + groups.map(g => `<option value="${esc(g.group_code)}">`
          + `${esc(g.group_code)} — ${esc(g.kind)} (${g.countries})</option>`).join('');
    state.groups = groups;
  }
  paintLockForm();
  state.locks = await adminLocks();
  paintLocks();
}

const ticked = () =>
  [...document.querySelectorAll('#lock-scopes input:checked')].map(i => i.value);

$('#lock-everything').addEventListener('click', () => {
  for (const box of document.querySelectorAll('#lock-scopes input')) box.checked = true;
});
$('#lock-none').addEventListener('click', () => {
  for (const box of document.querySelectorAll('#lock-scopes input')) box.checked = false;
});

// A group expands to its countries HERE rather than in the database, so the
// admin can see what they are about to lock before they do it.
$('#lock-group').addEventListener('change', (e) => {
  const code = e.target.value;
  if (!code) return;
  const members = (state.groups.find(g => g.group_code === code)?.members ?? '')
    .split(/\s+/).filter(Boolean);
  $('#lock-countries').value = members.join(', ');
  e.target.value = '';
  toast(`${members.length} countries filled in. Check the list before applying.`);
});

$('#lock-save').addEventListener('click', async () => {
  const countries = $('#lock-countries').value.split(/[\s,;]+/)
    .map(c => c.trim().toUpperCase()).filter(Boolean);
  if (!countries.length) { toast('Which country?', { error: true }); return; }
  const scopes = ticked();
  const until = $('#lock-until').value
    ? new Date($('#lock-until').value).toISOString() : null;

  // Hiding reports already filed is the one switch that takes information away
  // from travellers, so it is confirmed rather than applied on a single click.
  if (scopes.includes('reports') && !window.confirm(
        `Hide every report already filed in ${countries.join(', ')}?\n\n`
        + 'Travellers there lose the warnings other people left them. '
        + 'Pausing NEW reports does not do this.')) return;

  await attempt(async () => {
    const touched = await adminSetLock(countries, scopes,
      $('#lock-note').value.trim(), until);
    toast(scopes.length
      ? `${touched} ${touched === 1 ? 'country' : 'countries'} locked.`
      : 'Lock lifted.');
    await loadLocks();
  }, { onFail: loadLocks });
});

$('#locks-admin').addEventListener('click', async (e) => {
  if (e.target.dataset.act !== 'unlock') return;
  const country = e.target.closest('tr')?.dataset.country;
  if (!country) return;
  await attempt(async () => {
    await adminClearLock(country);
    toast(`${country} is open again.`);
    await loadLocks();
  }, { onFail: loadLocks });
});

// --- notices ----------------------------------------------------------------
const KIND_WORDS = { info: 'Information', warning: 'Warning', danger: 'Serious' };

function noticeRow(n) {
  return `<tr class="${n.in_force ? '' : 'is-done'}" data-id="${esc(n.id)}">
    <th scope="row">${esc(n.country_code)}</th>
    <td><span class="notice-kind is-${esc(n.kind)}">${esc(KIND_WORDS[n.kind] ?? n.kind)}</span></td>
    <td lang="${esc(n.lang)}"><strong>${esc(n.headline)}</strong>
      ${n.body ? `<em class="set-note">${esc(n.body)}</em>` : ''}</td>
    <td>${esc(n.lang)}</td>
    <td>${n.until
          ? `until ${esc(new Date(n.until).toLocaleString())}`
          : (n.in_force ? 'until taken down' : '—')}</td>
    <td>${n.in_force
          ? '<button class="ghost-button small" data-act="drop" type="button">Take down</button>'
          : 'gone'}</td>
  </tr>`;
}

function paintNotices() {
  $('#notices-admin').innerHTML = state.notices.length
    ? `<thead><tr><th scope="col">Country</th><th scope="col">Kind</th>
         <th scope="col">What it says</th><th scope="col">Lang</th>
         <th scope="col">For how long</th><th scope="col"></th>
       </tr></thead><tbody>${state.notices.map(noticeRow).join('')}</tbody>`
    : '<tbody><tr><td class="set-note">No notices anywhere.</td></tr></tbody>';
}

async function loadNotices() {
  if (!$('#notice-lang').options.length) {
    // The nine the site is read in, which is also what the table's own
    // constraint allows — anything else is refused on the way in.
    $('#notice-lang').innerHTML = ['en','de','es','fr','it','pt','nl','cs','pl']
      .map(c => `<option value="${c}"${c === 'en' ? ' selected' : ''}>${c}</option>`).join('');
  }
  state.notices = await adminNotices();
  paintNotices();
}

$('#notice-post').addEventListener('click', async () => {
  const country = $('#notice-country').value.trim().toUpperCase();
  const headline = $('#notice-headline').value.trim();
  if (!country) { toast('Which country?', { error: true }); return; }
  if (headline.length < 4) { toast('A headline needs more than that.', { error: true }); return; }
  await attempt(async () => {
    await adminPostNotice({
      country, kind: $('#notice-kind').value, headline,
      body: $('#notice-body').value.trim(), lang: $('#notice-lang').value,
      until: $('#notice-until').value
        ? new Date($('#notice-until').value).toISOString() : null,
    });
    toast(`Posted over ${country}.`);
    $('#notice-headline').value = '';
    $('#notice-body').value = '';
    await loadNotices();
  }, { onFail: loadNotices });
});

$('#notices-admin').addEventListener('click', async (e) => {
  if (e.target.dataset.act !== 'drop') return;
  const id = e.target.closest('tr')?.dataset.id;
  if (!id) return;
  await attempt(async () => {
    await adminDropNotice(id);
    toast('Taken down.');
    await loadNotices();
  }, { onFail: loadNotices });
});

// --- regions ----------------------------------------------------------------
function paintRegions() {
  const chosen = new Set(state.blocked.groups ?? []);
  const q = state.regionSearch.toLowerCase();
  const shown = state.regions.filter(r => !q || r.group_code.toLowerCase().includes(q));

  $('#region-state').textContent = state.blocked.closed
    ? `${state.blocked.closed} countries are closed to new reports.`
    : 'Everywhere is open to new reports.';
  $('#region-state').classList.toggle('is-closed', state.blocked.closed > 0);

  $('#region-list').innerHTML = shown.map(r => `
    <label class="region-row${chosen.has(r.group_code) ? ' is-on' : ''}">
      <input type="checkbox" data-group="${esc(r.group_code)}" ${chosen.has(r.group_code) ? 'checked' : ''} />
      <span class="rg-name">${esc(r.group_code)}</span>
      <span class="rg-kind">${esc(r.kind)}</span>
      <span class="rg-count">${r.countries}</span>
    </label>`).join('') || '<p class="empty-note">No region matches that.</p>';

  $('#region-countries').value = (state.blocked.countries ?? []).join(', ');
}

async function loadRegions() {
  if (!state.regions.length) state.regions = await adminRegionCatalog();
  state.blocked = await adminBlockedRegions() ?? { countries: [], groups: [], closed: 0 };
  paintRegions();
}

let regionSearching;
$('#region-search').addEventListener('input', (e) => {
  state.regionSearch = e.target.value.trim();
  clearTimeout(regionSearching);
  regionSearching = setTimeout(paintRegions, 150);
});

$('#region-list').addEventListener('change', (e) => {
  const group = e.target.dataset.group;
  if (!group) return;
  const groups = new Set(state.blocked.groups ?? []);
  if (e.target.checked) groups.add(group); else groups.delete(group);
  state.blocked.groups = [...groups];
  e.target.closest('.region-row')?.classList.toggle('is-on', e.target.checked);
});

$('#regions-save').addEventListener('click', async () => {
  const countries = $('#region-countries').value
    .split(/[,\s]+/).map(c => c.trim().toUpperCase()).filter(Boolean);
  await attempt(async () => {
    const closed = await adminSetBlockedRegions(countries, state.blocked.groups ?? []);
    state.blocked.countries = countries;
    state.blocked.closed = closed;
    paintRegions();
    toast(closed ? `${closed} countries are now closed to new reports.`
                 : 'Everywhere is open again.');
  }, { onFail: loadRegions });
});

// --- settings ---------------------------------------------------------------
function paintSettings() {
  $('#settings-admin').innerHTML = `
    <thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">What it does</th></tr></thead>
    <tbody>${state.settings.map(s => `
      <tr>
        <th scope="row"><code class="set-key">${esc(s.key)}</code></th>
        <td><input type="text" inputmode="decimal" value="${esc(s.value)}"
                   data-key="${esc(s.key)}" size="8" /></td>
        <td class="set-note">${esc(s.note ?? '')}</td>
      </tr>`).join('')}</tbody>`;
}

async function loadSettings() {
  state.settings = await adminSettings();
  paintSettings();
}

// Saved when the field is left rather than on every keystroke: half a number
// is a number, and 1 on the way to 14 would be applied and then applied again.
$('#settings-admin').addEventListener('change', async (e) => {
  const key = e.target.dataset.key;
  if (!key) return;
  const was = state.settings.find(s => s.key === key);
  await attempt(async () => {
    const now = await adminSetSetting(key, e.target.value);
    if (was) was.value = now;
    e.target.value = now;
    toast(`${key} is now ${now}.`);
  }, { onFail: () => { e.target.value = was?.value ?? ''; } });
});

// --- start ------------------------------------------------------------------
await bootPage();
initAuth();
onAuthChange((user) => { state.me = user; decideAccess(); });

// Exposed for the tests, which drive this the way a person would.
window.__admin = state;

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
import { esc, toast, badgeChip, BADGES } from './ui.js';
import { formatDate } from './i18n.js';
import { amAdmin, adminMembers, adminSetRole, adminSetLevel, adminSetBadge,
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
const TABS = ['members', 'reports', 'levels', 'regions', 'settings'];

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

        <label class="ar-check">
          <input type="checkbox" data-act="listed"${m.listed ? ' checked' : ''} />
          <span>On the contributors list</span>
        </label>
      </div>

      <div class="ar-badges">
        ${BADGES.map(slug => `
          <label class="ar-badge${(m.badges ?? []).includes(slug) ? ' is-on' : ''}">
            <input type="checkbox" data-act="badge" data-badge="${slug}"
                   ${(m.badges ?? []).includes(slug) ? 'checked' : ''} />
            ${badgeChip(slug)}
          </label>`).join('')}
      </div>

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
async function attempt(work, { onFail }) {
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
      e.target.closest('.ar-badge')?.classList.toggle('is-on', wanted);
    }, { onFail: () => { e.target.checked = !wanted; } });
  }
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
    <thead><tr><th scope="col">Level</th><th scope="col">Points needed</th></tr></thead>
    <tbody>${state.levels.map(([level, points], i) => `
      <tr>
        <th scope="row">Level ${level}</th>
        <td><input type="number" min="0" step="1" value="${points}"
                   data-row="${i}" ${i === 0 ? 'disabled title="Level 1 is where everybody starts"' : ''} /></td>
      </tr>`).join('')}</tbody>`;
  $('#level-drop').disabled = state.levels.length <= 1;
}

async function loadLevels() {
  state.levels = await contributorLadder();
  paintLevels();
}

$('#levels-admin').addEventListener('input', (e) => {
  const row = Number(e.target.dataset.row);
  if (Number.isInteger(row)) state.levels[row][1] = Number(e.target.value);
});

$('#level-add').addEventListener('click', () => {
  const [lastLevel, lastPoints] = state.levels[state.levels.length - 1] ?? [0, 0];
  state.levels.push([lastLevel + 1, lastPoints + 100]);
  paintLevels();
});

$('#level-drop').addEventListener('click', () => {
  if (state.levels.length > 1) state.levels.pop();
  paintLevels();
});

$('#levels-save').addEventListener('click', async () => {
  await attempt(async () => {
    const saved = await adminSetLevels(
      state.levels.map(([level, min_points]) => ({ level, min_points })));
    state.levels = saved.map(r => [Number(r.level), Number(r.min_points)]);
    paintLevels();
    toast('The ladder is saved, and every level recomputed with it.');
  }, { onFail: loadLevels });     // a refused ladder must not stay on screen
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

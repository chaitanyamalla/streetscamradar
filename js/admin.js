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
         adminSetListed, adminRemoveMember } from './data.js';

const $ = (sel) => document.querySelector(sel);
const ROLES = ['member', 'moderator', 'admin'];

const state = { me: null, admin: false, members: [], search: '', pending: null };

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
  $('#admin-lede').textContent =
    'Roles, levels and badges. Everything here is checked again by the database, '
    + 'so a mistake is refused rather than applied.';
  gate.hidden = true; body.hidden = false;
  await load();
}

async function load() {
  $('#admin-list').innerHTML = '<p class="empty-note">Loading…</p>';
  try {
    state.members = await adminMembers(state.search, 100);
    paint();
  } catch (err) {
    $('#admin-list').innerHTML = `<p class="empty-note">${esc(err.message)}</p>`;
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
  $('#admin-count').textContent = n === 1 ? '1 member' : `${n} members`;
  $('#admin-list').innerHTML = n
    ? state.members.map(memberRow).join('')
    : '<p class="empty-note">Nobody matches that.</p>';
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
  state.pending = id;
  $('#confirm-text').textContent =
    `${member.display_name || member.email || 'This member'} and their ${member.reports} `
    + `report${member.reports === 1 ? '' : 's'} will be deleted. This cannot be undone.`;
  $('#confirm-dialog').showModal();
});

$('#confirm-no').addEventListener('click', () => $('#confirm-dialog').close());
$('[data-close="confirm-dialog"]').addEventListener('click', () => $('#confirm-dialog').close());
$('#confirm-yes').addEventListener('click', async () => {
  const id = state.pending;
  $('#confirm-dialog').close();
  if (!id) return;
  await attempt(async () => {
    await adminRemoveMember(id);
    state.members = state.members.filter(m => m.id !== id);
    paint();
    toast('Removed.');
  }, {});
});

let searching;
$('#admin-search').addEventListener('input', (e) => {
  state.search = e.target.value.trim();
  clearTimeout(searching);
  searching = setTimeout(load, 250);
});

$('#admin-signin').addEventListener('click', () => { window.location.href = 'index.html#map'; });

// --- start ------------------------------------------------------------------
await bootPage();
initAuth();
onAuthChange((user) => { state.me = user; decideAccess(); });

// Exposed for the tests, which drive this the way a person would.
window.__admin = state;

// A Supabase stand-in: PostgREST's shapes, and the rules that decide answers.
//
// Covers the tables and RPCs this site calls — derived from the source, not
// from memory. What it does NOT model is said so in the comments rather than
// quietly approximated.
//
// THE RULE: where the real thing is awkward, be awkward the same way. Each
// "modelled because" below records a bug that got through a more convenient
// version of this file.
//
// What a test drives, all on `window`:
//   __setUser(u)        sign somebody in; u carries identities/app_metadata
//   __reports           the rows the map and the feed read
//   __categories        scam categories
//   __allowance         { quota, used } for my_reporting_allowance
//   __refuseReport      a reason string; the next insert is refused with it
//   __locks __notices   country locks and notices
//   __isAdmin           false makes is_admin say no even for a signed-in user
//   __rpc               { name: value } to answer anything not modelled
const SCOPES = ['reports_new', 'reports', 'advisories', 'disasters', 'weather', 'safety'];
const LADDER = [[1,0,5],[2,20,7],[3,50,9],[4,100,11],[5,180,13],
                [6,300,15],[7,460,18],[8,660,20],[9,900,22],[10,1200,25]];

// What Supabase attaches per way in. A password account carries an `email`
// identity and an OAuth one does not.
//
// Modelled because: without these, code asking "how did this person get here?"
// looked right while testing nothing — the provider set was empty rather than
// wrong, so every answer came out the same.
export const emailUser = (email, id = 'u1') => ({
  id, email,
  app_metadata: { provider: 'email', providers: ['email'] },
  identities: [{ provider: 'email', identity_id: 'i-email' }],
});
export const googleUser = (email, id = 'u1') => ({
  id, email,
  app_metadata: { provider: 'google', providers: ['google'] },
  identities: [{ provider: 'google', identity_id: 'i-google' }],
  user_metadata: { full_name: 'Ana Google', name: 'Ana Google', email_verified: true },
});

// A query builder that collects its filters and applies them at await time,
// the way PostgREST does — so a test can assert on WHAT was asked for, and a
// filter the app forgot actually changes the answer.
class Query {
  constructor(rows) { this.rows = rows ?? []; this.filters = []; this._order = null; this._limit = null; }
  select() { return this; }
  eq(col, val)  { this.filters.push(r => r[col] === val); return this; }
  neq(col, val) { this.filters.push(r => r[col] !== val); return this; }
  gte(col, val) { this.filters.push(r => r[col] >= val); return this; }
  lte(col, val) { this.filters.push(r => r[col] <= val); return this; }
  in(col, vals) { this.filters.push(r => vals.includes(r[col])); return this; }
  // PostgREST's or() takes one string of comma-separated conditions:
  //   'to_date.is.null,to_date.gte.2026-01-01'
  // Parsed rather than ignored, because both hazard feeds use it to mean
  // "still running or finished recently", and a stub that dropped it returned
  // rows the real query excludes — or, as it first did here, threw and took
  // the whole refresh chain down with it.
  or(expr) {
    const terms = String(expr).split(',').map(term => {
      const [col, op, ...rest] = term.split('.');
      const value = rest.join('.');
      return (r) => {
        const got = r[col];
        if (op === 'is') return value === 'null' ? got == null : String(got) === value;
        if (op === 'gte') return got != null && got >= value;
        if (op === 'lte') return got != null && got <= value;
        if (op === 'eq')  return String(got) === value;
        // An operator this does not know must not quietly pass everything.
        throw new Error(`stub: or() does not model '${op}' (${term})`);
      };
    });
    this.filters.push(r => terms.some(fn => fn(r)));
    return this;
  }
  not(col, op, value) {
    this.filters.push(r => !(op === 'is' && value === null ? r[col] == null : r[col] === value));
    return this;
  }
  is(col, value) { this.filters.push(r => (value === null ? r[col] == null : r[col] === value)); return this; }
  order(col, o = {}) { this._order = { col, asc: o.ascending !== false }; return this; }
  limit(n) { this._limit = n; return this; }
  single() { this._one = true; return this; }
  // maybeSingle() returns null rather than an error when there is no row,
  // which is exactly why getProfile() uses it: a member who has not saved a
  // profile yet is an ordinary state, not a failure. A stub without it threw,
  // and the thrown error looked nothing like the missing method it was.
  maybeSingle() { this._one = true; return this; }
  get result() {
    let out = this.rows.filter(r => this.filters.every(f => f(r)));
    if (this._order) {
      const { col, asc } = this._order;
      out = [...out].sort((a, b) => {
        const x = a[col], y = b[col];
        const cmp = x === y ? 0 : (x > y ? 1 : -1);
        return asc ? cmp : -cmp;
      });
    }
    if (this._limit != null) out = out.slice(0, this._limit);
    return this._one ? (out[0] ?? null) : out;
  }
  // A real thenable, not just an object with a then().
  //
  // Modelled because: a then() that returned the handler's value left the
  // chain without .catch or .finally, and data.js ends several reads with
  // .catch(...) — so the stub threw "catch is not a function" and took the
  // whole refresh chain down with it, which looked nothing like the bug it was.
  get _settled() { return Promise.resolve({ data: this.result, error: null }); }
  then(onOk, onNo) { return this._settled.then(onOk, onNo); }
  catch(onNo) { return this._settled.catch(onNo); }
  finally(fn) { return this._settled.finally(fn); }
}

export function createClient() {
  let user = null;
  const listeners = [];
  const live = (row) => row.until == null || Date.parse(row.until) > Date.now();
  const fail = (message) => ({ data: null, error: { message } });
  const win = () => (typeof window === 'undefined' ? {} : window);

  const reports = () => win().__reports ?? [];
  const locked = (scope) => (win().__locks ?? [])
    .filter(l => live(l) && (l.scopes ?? []).includes(scope))
    .map(l => String(l.country_code).toUpperCase());

  const client = {
    __setUser(u) {
      user = u;
      listeners.forEach(f => f(u ? 'SIGNED_IN' : 'SIGNED_OUT', u ? { user: u } : null));
    },
    auth: {
      async getSession() { return { data: { session: user ? { user } : null } }; },
      async getUser() { return { data: { user } }; },
      onAuthStateChange(fn) {
        listeners.push(fn);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signInWithPassword({ email, password }) {
        if (win().__knownUsers?.[email] === password) {
          client.__setUser(emailUser(email)); return { error: null };
        }
        return { error: { message: 'Invalid login credentials' } };
      },
      async signUp({ email, password }) {
        (win().__knownUsers ??= {})[email] = password;
        if (win().__requireConfirmation) {
          return { data: { session: null, user: emailUser(email) }, error: null };
        }
        client.__setUser(emailUser(email));
        return { data: { session: { user: emailUser(email) }, user: emailUser(email) }, error: null };
      },
      async signInWithOtp({ email }) { win().__lastMagicLink = email; return { error: null }; },
      async signInWithOAuth({ provider }) { win().__lastOAuth = provider; return { error: null }; },
      async updateUser({ password }) {
        if (!user) return { error: { message: 'not signed in' } };
        if ((password ?? '').length < 6) {
          return { error: { message: 'Password should be at least 6 characters' } };
        }
        win().__newPassword = password; return { error: null };
      },
      async signOut() { client.__setUser(null); return { error: null }; },
    },

    from(table) {
      if (table === 'reports') {
        return { insert: async (row) => {
          if (!user) return { error: { message: 'new row violates row-level security policy' } };
          // The gate, as Postgres reports it: check_report_allowed() raises
          // 'report_refused:<reason>' and PostgREST relays that message
          // verbatim. A tidy {code:'quota'} would be a shape the page is
          // never handed.
          if (win().__refuseReport) {
            return { error: { message: 'report_refused:' + win().__refuseReport, code: '23514' } };
          }
          // A country locked to new reports refuses too, the way
          // reporting_allowed() does.
          if (locked('reports_new').includes(String(row.country_code).toUpperCase())
           || locked('reports').includes(String(row.country_code).toUpperCase())) {
            return { error: { message: 'new row violates row-level security policy' } };
          }
          (win().__reports ??= []).unshift({
            ...row, id: 'new-' + Date.now(), support_count: 0, flag_count: 0, is_mine: true });
          win().__lastInsert = row;
          return { error: null };
        } };
      }
      if (table === 'reports_feed') {
        // Rows in a locked country are not here, and your own are no
        // exception — if they were, a member could detect a lock by watching
        // their own pins survive.
        const hidden = locked('reports');
        return new Query(reports()
          .filter(r => !hidden.includes(String(r.country_code).toUpperCase()))
          .map(r => ({ ...r, is_mine: Boolean(user) && r.reporter_id === user.id })));
      }
      if (table === 'scam_categories') return new Query(win().__categories ?? []);
      if (table === 'contributor_levels') {
        return new Query((win().__ladder ?? LADDER)
          .map(([level, min_points, daily_quota]) => ({ level, min_points, daily_quota })));
      }
      if (table === 'report_supports') {
        return Object.assign(new Query(win().__supported ?? []), {
          insert: async (row) => {
            (win().__supported ??= []).push({ report_id: row.report_id }); return { error: null };
          },
          delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        });
      }
      if (table === 'report_flags') {
        return { insert: async (row) => { win().__lastFlag = row.report_id; return { error: null }; } };
      }
      if (table === 'profiles') {
        return Object.assign(new Query(user ? [{
          id: user.id, display_name: win().__displayName ?? null,
          home_label: null, home_lat: null, home_lng: null,
          locale: win().__locale ?? null, listed: win().__listed ?? false,
          role: win().__role ?? 'member', created_at: '2026-08-01T00:00:00.000Z',
        }] : []), {
          update: (row) => ({ eq: async () => {
            if ('display_name' in row) win().__displayName = row.display_name;
            if ('locale' in row) win().__locale = row.locale;
            if ('listed' in row) win().__listed = row.listed;
            return { error: null };
          } }),
        });
      }
      // The four feeds, each hidden by its own lock scope the way the select
      // policies hide them.
      const feeds = {
        travel_advisories: ['advisories', win().__advisories],
        disaster_alerts:   ['disasters',  win().__disasters],
        weather_warnings:  ['weather',    win().__weather],
        safety_places:     ['safety',     win().__safety],
      };
      if (feeds[table]) {
        const [scope, rows] = feeds[table];
        const hidden = locked(scope);
        return new Query((rows ?? [])
          .filter(r => !hidden.includes(String(r.country_code).toUpperCase())));
      }
      return new Query([]);
    },

    async rpc(name, p = {}) {
      const admin = Boolean(user) && win().__isAdmin !== false;

      if (name === 'is_admin') return { data: admin, error: null };
      if (name === 'lock_scopes') return { data: SCOPES, error: null };
      if (name === 'blocked_countries') return { data: win().__blocked ?? [], error: null };

      if (name === 'active_locks') {
        return { data: (win().__locks ?? []).filter(live)
          .map(({ country_code, scopes, until }) => ({ country_code, scopes, until })),
          error: null };
      }
      if (name === 'notices_for') {
        const want = String(p.p_country ?? '').toUpperCase();
        const order = { danger: 0, warning: 1, info: 2 };
        return { data: (win().__notices ?? [])
          .filter(n => live(n) && String(n.country_code).toUpperCase() === want)
          .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9)),
          error: null };
      }

      // Returns a TABLE, so PostgREST sends an array of one row with
      // snake_case keys. A bare object would let the page read .quota off
      // something the real call never gives it.
      if (name === 'my_reporting_allowance') {
        if (!user) return fail('sign in required');
        const a = win().__allowance ?? { quota: 5, used: 0 };
        const quota = Number(a.quota ?? 5), used = Number(a.used ?? 0);
        return { data: [{ quota, used, remaining: Math.max(quota - used, 0),
                          next_allowed_at: a.next_allowed_at ?? null }], error: null };
      }

      if (name.startsWith('admin_') && !admin) return fail('you are not an administrator');
      if (name === 'admin_members') return { data: win().__members ?? [], error: null };
      if (name === 'admin_region_catalog') {
        // `members` is a space-separated list of country codes, as the real
        // function returns it — the console splits on whitespace to fill the
        // lock form, so a comma-separated stub would silently produce one
        // very long "country".
        return { data: win().__groups ?? [
          { group_code: 'western-europe', kind: 'zone',  countries: 3, members: 'FR ES PT' },
          { group_code: 'EU',             kind: 'union', countries: 2, members: 'FR DE' },
        ], error: null };
      }
      if (name === 'admin_locks') {
        return { data: (win().__locks ?? []).map(l => ({ ...l, in_force: live(l) })), error: null };
      }
      if (name === 'admin_notices') {
        return { data: (win().__notices ?? []).map(n => ({ ...n, in_force: live(n) })), error: null };
      }
      if (name === 'admin_set_lock') {
        const codes = [...new Set((p.p_countries ?? []).map(c => String(c).trim().toUpperCase()))]
          .filter(Boolean);
        if (!codes.length) return fail('no country given');
        const unknown = codes.find(c => !(win().__knownCountries ?? ['FR','ES','IT','PT','DE','GB','IN','JP','US','BR']).includes(c));
        if (unknown) return fail(`${unknown} is not a country code we know`);
        const scopes = [...new Set((p.p_scopes ?? []).filter(Boolean))];
        win().__locks ??= [];
        if (!scopes.length) {
          win().__locks = win().__locks.filter(l => !codes.includes(l.country_code));
          return { data: 0, error: null };
        }
        const bad = scopes.find(s => !SCOPES.includes(s));
        if (bad) return fail(`${bad} is not something that can be locked`);
        if (p.p_until && Date.parse(p.p_until) <= Date.now()) {
          return fail('that lock would already have expired');
        }
        for (const code of codes) {
          win().__locks = win().__locks.filter(l => l.country_code !== code);
          win().__locks.unshift({ country_code: code, scopes, note: p.p_note ?? null,
            until: p.p_until ?? null, created_at: new Date().toISOString() });
        }
        return { data: codes.length, error: null };
      }
      if (name === 'admin_clear_lock') {
        const code = String(p.p_country ?? '').toUpperCase();
        const before = (win().__locks ?? []).length;
        win().__locks = (win().__locks ?? []).filter(l => l.country_code !== code);
        return { data: before !== win().__locks.length, error: null };
      }
      if (name === 'admin_post_notice') {
        const code = String(p.p_country ?? '').toUpperCase();
        if (!(win().__knownCountries ?? ['FR','ES','IT','PT','DE','GB','IN','JP','US','BR']).includes(code)) {
          return fail(`${p.p_country} is not a country code we know`);
        }
        if (!['info','warning','danger'].includes(p.p_kind)) {
          return fail('new row violates check constraint "country_notices_kind_check"');
        }
        const headline = String(p.p_headline ?? '').trim();
        if (headline.length < 4 || headline.length > 90) {
          return fail('new row violates check constraint "country_notices_headline_check"');
        }
        const id = 'n-' + Math.random().toString(16).slice(2, 10);
        (win().__notices ??= []).unshift({ id, country_code: code, kind: p.p_kind,
          headline, body: p.p_body ?? null, lang: p.p_lang ?? 'en',
          until: p.p_until ?? null, created_at: new Date().toISOString() });
        return { data: id, error: null };
      }
      if (name === 'admin_drop_notice') {
        const before = (win().__notices ?? []).length;
        win().__notices = (win().__notices ?? []).filter(n => n.id !== p.p_id);
        return { data: before !== win().__notices.length, error: null };
      }

      // Anything not modelled: whatever the test put in window.__rpc, and
      // otherwise an empty list rather than undefined, so a screen this was
      // not written for still renders instead of throwing.
      if (win().__rpc && Object.hasOwn(win().__rpc, name)) {
        return { data: win().__rpc[name], error: null };
      }
      return { data: [], error: null };
    },
  };
  if (typeof window !== 'undefined') window.__supabaseStub = client;
  return client;
}

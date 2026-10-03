// ---------------------------------------------------------------------------
// Everything that talks to Supabase lives here.
//
// Note what is NOT here: any check of the form "if signed out, hide X". The
// page asks a different *question* depending on who is asking, but the answer
// is decided by the database. A visitor who edits this file in their browser
// gets nothing extra — the publishable key maps to the anon role, and the anon
// role has no read access to the reports table at all.
// ---------------------------------------------------------------------------
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { t } from './i18n.js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, isConfigured, PUBLIC_DETAIL_MAX_SPAN, SAFETY_MAX_PLACES } from './config.js';

export const supabase = isConfigured()
  ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

export class NotConfiguredError extends Error {
  constructor() { super('Supabase is not configured yet — see js/config.js'); }
}

const need = () => { if (!supabase) throw new NotConfiguredError(); };

// --- Categories ------------------------------------------------------------
let categoryCache = null;

export async function getCategories() {
  if (categoryCache) return categoryCache;
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('scam_categories')
    .select('slug,label,glyph,blurb,sort_order')
    .order('sort_order');
  if (error) throw error;
  categoryCache = data ?? [];
  return categoryCache;
}

// --- Reading the map -------------------------------------------------------
/**
 * Fetch whatever the current viewer is allowed to see inside `bounds`.
 * Returns { mode, reports, cells, hiddenCount } where mode is one of:
 *   'member'  — every live report in view
 *   'sample'  — a capped handful (signed out, zoomed in)
 *   'summary' — counts per grid cell only (signed out, zoomed out)
 *
 * `ageDays` is the chip above the report list, and it is passed to the two
 * public functions rather than applied here. A density circle is a number the
 * database already added up, so there is nothing left in the browser to
 * filter; and the five-row sample has to be the five newest of what was ASKED
 * for, not five from across the week with four of them then dropped.
 *
 * The member query is the exception: it narrows here as well, because the row
 * cap is 500 and a narrower window should spend all 500 on days the reader can
 * actually see.
 */
export async function fetchForBounds(bounds, { signedIn, ageDays = null }) {
  need();
  const { minLat, minLng, maxLat, maxLng } = bounds;
  const since = ageDays
    ? new Date(Date.now() - ageDays * 86400000).toISOString()
    : null;

  if (signedIn) {
    let query = supabase
      .from('reports_feed')
      .select('id,category,impacts,headline,description,lat,lng,address,city,country_code,happened_at,support_count,is_mine')
      .gte('lat', minLat).lte('lat', maxLat)
      .gte('lng', minLng).lte('lng', maxLng);
    if (since) query = query.gte('happened_at', since);
    const { data, error } = await query
      .order('happened_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    return { mode: 'member', reports: data ?? [], cells: [], hiddenCount: 0 };
  }

  const span = Math.max(maxLat - minLat, maxLng - minLng);
  if (span <= PUBLIC_DETAIL_MAX_SPAN) {
    const { data, error } = await supabase.rpc('public_sample_reports', {
      min_lat: minLat, min_lng: minLng, max_lat: maxLat, max_lng: maxLng,
      max_age_days: ageDays,
    });
    if (error) throw error;
    const reports = data ?? [];
    const total = reports[0]?.total_in_view ?? 0;
    return { mode: 'sample', reports, cells: [], hiddenCount: Math.max(0, total - reports.length) };
  }

  const { data, error } = await supabase.rpc('public_area_summary', {
    min_lat: minLat, min_lng: minLng, max_lat: maxLat, max_lng: maxLng, cells: 14,
    max_age_days: ageDays,
  });
  if (error) throw error;
  return { mode: 'summary', reports: [], cells: data ?? [], hiddenCount: 0 };
}

// --- Writing ---------------------------------------------------------------
export async function submitReport(report) {
  need();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error(t('toast.signInRequired'));

  const { error } = await supabase.from('reports').insert({
    reporter_id: user.id,
    category: report.category,
    impacts: report.impacts,
    headline: report.headline.trim(),
    description: report.description.trim(),
    lat: report.lat,
    lng: report.lng,
    address: report.address || null,
    city: report.city || null,
    country_code: report.countryCode || null,
    happened_at: report.happenedAt,
  });
  if (error) throw error;
}

export async function withdrawReport(id) {
  need();
  const { data, error } = await supabase.rpc('delete_my_report', { p_report_id: id });
  if (error) throw error;
  return data === true;
}

// --- Support and flags -----------------------------------------------------
export async function mySupports(reportIds) {
  if (!supabase || !reportIds.length) return new Set();
  const { data, error } = await supabase
    .from('report_supports').select('report_id').in('report_id', reportIds);
  if (error) return new Set();           // not signed in — nothing to show
  return new Set((data ?? []).map(r => r.report_id));
}

export async function addSupport(reportId) {
  need();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error(t('error.signInToConfirm'));
  const { error } = await supabase.from('report_supports')
    .insert({ report_id: reportId, user_id: user.id });
  if (error && error.code !== '23505') throw error;  // 23505 = already supported
}

export async function removeSupport(reportId) {
  need();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase.from('report_supports')
    .delete().eq('report_id', reportId).eq('user_id', user.id);
  if (error) throw error;
}

export async function flagReport(reportId, reason = 'other') {
  need();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error(t('error.signInToFlag'));
  const { error } = await supabase.from('report_flags')
    .insert({ report_id: reportId, user_id: user.id, reason });
  if (error && error.code !== '23505') throw error;
}

// --- Profile ---------------------------------------------------------------
export async function getProfile() {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const columns = 'id,display_name,home_label,home_lat,home_lng,locale,created_at';
  const { data, error } = await supabase.from('profiles')
    .select(`${columns},role,listed`).eq('id', user.id).maybeSingle();
  // A database that has not had the roles part of schema.sql applied has no
  // such columns, and PostgREST refuses the whole select rather than the two
  // it does not know. Asked again without them, because losing the name you
  // chose over a nav link you would not have seen anyway is the wrong trade.
  if (error) {
    const again = await supabase.from('profiles')
      .select(columns).eq('id', user.id).maybeSingle();
    return again.data ?? null;
  }
  return data ?? null;
}

/**
 * Remember the language you picked, against your account rather than this
 * browser. Signed in on a borrowed laptop, the site still opens in yours.
 *
 * Deliberately quiet on failure: an older database without the column would
 * otherwise turn "change language" — which has already visibly worked — into
 * an error message.
 */
export async function saveLocale(code) {
  if (!supabase) return false;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { error } = await supabase.from('profiles')
    .update({ locale: code }).eq('id', user.id);
  if (error) { console.warn('Could not save the language choice:', error.message); return false; }
  return true;
}

export async function saveDisplayName(name) {
  need();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error(t('error.signInGeneric'));
  const { error } = await supabase.from('profiles')
    .update({ display_name: name || null }).eq('id', user.id);
  if (error) throw error;
}

/**
 * Everything you have filed, newest first — including reports that have aged
 * past the 7-day window. reports_feed keeps your own rows visible to you
 * whatever their age, which is the whole reason you can still find them here
 * after they have come off the map.
 */
export async function myReports() {
  need();
  const { data, error } = await supabase
    .from('reports_feed')
    .select('id,category,impacts,headline,description,lat,lng,address,city,country_code,happened_at,created_at,support_count,flag_count,is_mine')
    .eq('is_mine', true)
    .order('happened_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Change the wording of your own report. Goes through a function because
 * members have no UPDATE on the table — the same shape as withdrawing.
 * happenedAt left out keeps the original time, which is the point: fixing a
 * typo should not quietly move when the scam happened.
 */
export async function editMyReport(id, { headline, description, happenedAt = null, place = null }) {
  need();
  const { data, error } = await supabase.rpc('edit_my_report', {
    p_report_id: id,
    p_headline: headline.trim(),
    p_description: description.trim(),
    p_happened_at: happenedAt,
    p_lat: place?.lat ?? null,
    p_lng: place?.lng ?? null,
    p_address: place?.address ?? null,
    p_city: place?.city ?? null,
    p_country_code: place?.countryCode ?? null,
  });
  if (error) throw error;
  if (data !== true) throw new Error(t('toast.editFailed'));
  return true;
}

/** Close the account and take its reports with it. Irreversible. */
export async function deleteMyAccount() {
  need();
  const { error } = await supabase.rpc('delete_my_account');
  if (error) throw error;
  return true;
}

/** The reports you have confirmed, as far as you can still see them — one
 *  that has aged off the map is gone for everyone but its author. */
export async function myConfirmedReports() {
  need();
  // One call, and NOT through reports_feed. That view keeps somebody else's
  // report only while it is inside the week, so this used to collect the right
  // ids from report_supports and then lose half of them on the way back — the
  // tile said two and the list showed none. my_confirmed_reports() asks the
  // question the tile is counting. See supabase/schema.sql.
  const { data, error } = await supabase.rpc('my_confirmed_reports');
  if (error) throw error;
  return data ?? [];
}

/**
 * How many other people's reports you have confirmed.
 *
 * Counted over exactly the rows myConfirmedReports() returns, by the same
 * join, so the tile and the list it opens cannot disagree. Counting
 * report_supports directly included supports on reports that have since been
 * removed, which is a number with nothing behind it.
 */
export async function myConfirmationCount() {
  need();
  const { data, error } = await supabase.rpc('my_confirmation_count');
  if (error) throw error;
  return Number(data) || 0;
}

// --- Administration --------------------------------------------------------
//
// Every one of these is refused by the database unless the caller is an admin.
// None of them trusts the page it is called from, which is why there is no
// "am I allowed" flag anywhere in here: the answer is whatever the call says.

/** Am I an admin? Asked of the database, never of the page. */
export async function amAdmin() {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('is_admin');
  if (error) return false;
  return data === true;
}

export async function adminMembers(search = '', limit = 100) {
  need();
  const { data, error } = await supabase.rpc('admin_members',
    { p_search: search || null, p_limit: limit });
  if (error) throw error;
  return data ?? [];
}

export async function adminSetRole(id, role) {
  need();
  const { data, error } = await supabase.rpc('admin_set_role', { p_id: id, p_role: role });
  if (error) throw error;
  return data;
}

export async function adminSetLevel(id, level) {
  need();
  const { data, error } = await supabase.rpc('admin_set_level',
    { p_id: id, p_level: level ?? null });
  if (error) throw error;
  return data;
}

export async function adminSetBadge(id, badge, on, note = null) {
  need();
  const { data, error } = await supabase.rpc('admin_set_badge',
    { p_id: id, p_badge: badge, p_on: on, p_note: note });
  if (error) throw error;
  return data ?? [];
}

export async function adminSetListed(id, listed) {
  need();
  const { data, error } = await supabase.rpc('admin_set_listed',
    { p_id: id, p_listed: listed });
  if (error) throw error;
  return data;
}

export async function adminRemoveMember(id) {
  need();
  const { error } = await supabase.rpc('admin_remove_member', { p_id: id });
  if (error) throw error;
  return true;
}

// --- The ladder itself -----------------------------------------------------
/**
 * The level thresholds, as the database currently has them.
 *
 * Read by the reference page so that retuning contributor_levels changes what
 * the page tells people, rather than leaving it quoting numbers from the day
 * it was written. Public, like the categories: a ladder nobody can see is not
 * a ladder anybody can climb towards.
 */
export async function contributorLadder() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('contributor_levels').select('level,min_points').order('level');
  if (error) return [];
  return (data ?? []).map(r => [Number(r.level), Number(r.min_points)]);
}

/**
 * What a report, a confirmation received and a confirmation given are worth.
 *
 * Through a function rather than by reading app_settings, which is revoked
 * from the browser and should stay that way — it also holds which regions are
 * closed to reporting.
 */
export async function pointWeights() {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('point_weights');
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? { report: Number(row.report), confirmation: Number(row.confirmation),
                 given: Number(row.given) } : null;
}

// --- Standing: level, points, badges ---------------------------------------
/**
 * Your own level and what it is made of, in one call.
 *
 * Quiet on failure, deliberately. This is an ornament on a dialog whose job is
 * showing you your reports; a database that has not had the levels part of
 * schema.sql applied yet should cost the ornament, not the dialog.
 */
export async function myStanding() {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('my_standing');
  if (error) return null;
  return (Array.isArray(data) ? data[0] : data) ?? null;
}

/** The members who asked to be named, best first. */
export async function contributorsBoard(limit = 20) {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('contributors_board', { p_limit: limit });
  if (error) return [];
  return data ?? [];
}

/** Put yourself on the board, or take yourself off it again. */
export async function saveListed(listed) {
  need();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase.from('profiles')
    .update({ listed: Boolean(listed) }).eq('id', user.id);
  if (error) throw error;
}

export async function saveHomeArea({ label, lat, lng }) {
  need();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase.from('profiles')
    .update({ home_label: label, home_lat: lat, home_lng: lng }).eq('id', user.id);
  if (error) throw error;
}

// --- Safety places ---------------------------------------------------------
/**
 * Hospitals in view. Public reference data, so no sign-in branching: the same
 * rows for everyone.
 *
 * kind is filtered here rather than assumed, because the table can still hold
 * police rows from earlier crawls and a stray one would be drawn as a
 * hospital.
 *
 * These used to come straight from OpenStreetMap's Overpass API on every pan,
 * which tied a feature of the site to a free, shared, frequently congested
 * service — it hung more often than it answered. They are now refreshed into
 * our own table by .github/workflows/safety-data.yml, so this is one indexed
 * query like everything else here.
 */
// --- Travel advisories -----------------------------------------------------
/**
 * Every country's advisory status, read once and kept for the session.
 *
 * About two hundred small rows, so one read is cheaper than a query each time
 * the map crosses a border — and it means the dialog can list every country
 * without going back to the network. The promise itself is cached, not just
 * the result, so a burst of pans while the first read is in flight shares it
 * rather than starting five more.
 */
let advisoryCache = null;

export function fetchAdvisories() {
  if (advisoryCache) return advisoryCache;
  if (!supabase) return Promise.resolve(new Map());

  advisoryCache = supabase
    .from('travel_advisories')
    .select('country_code,content_id,title,country_name,warning,partial_warning,'
          + 'situation_warning,situation_part_warning,last_modified,refreshed_at')
    .then(({ data, error }) => {
      if (error) throw error;
      return new Map((data ?? []).map(row => [row.country_code, row]));
    })
    .catch(err => {
      // A failed read must not poison the session: drop the cache so the next
      // pan tries again, rather than showing nothing until a reload.
      advisoryCache = null;
      throw err;
    });
  return advisoryCache;
}

/**
 * Ongoing natural disasters, by country, read once and kept for the session.
 *
 * Small — a few dozen rows on an ordinary day — and the same shape of read as
 * the travel advisories, for the same reason: the question is about a country,
 * so the answer is fetched per country set rather than per view.
 *
 * Events whose own end date is more than a week past are left behind. GDACS
 * normally drops them itself and our refresh follows, but a stale row outliving
 * the thing it describes is the one failure that would show a flood that ended.
 */
let disasterCache = null;

export function fetchDisasters() {
  if (disasterCache) return disasterCache;
  if (!supabase) return Promise.resolve(new Map());

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  disasterCache = supabase
    .from('disaster_alerts')
    .select('event_id,country_code,kind,severity,name,from_date,to_date,url,lat,lng,'
            + 'magnitude,depth_km,measure')
    .or(`to_date.is.null,to_date.gte.${weekAgo}`)
    .then(({ data, error }) => {
      if (error) throw error;
      const byCountry = new Map();
      for (const row of data ?? []) {
        const list = byCountry.get(row.country_code) ?? [];
        list.push(row);
        byCountry.set(row.country_code, list);
      }
      // Most serious first, so a chip that can only name a few names the worst.
      for (const list of byCountry.values()) {
        list.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'severe' ? -1 : 1));
      }
      return byCountry;
    })
    .catch(err => {
      // A failed read must not poison the session: drop the cache so the next
      // pan tries again rather than showing nothing until a reload.
      disasterCache = null;
      throw err;
    });
  return disasterCache;
}

/**
 * Severe weather warnings, by country, read once and kept for the session.
 *
 * Europe through MeteoAlarm and the United States through NOAA's National
 * Weather Service, orange or red only, which is a few hundred rows at a time.
 *
 * Warnings that have already expired are left behind here as well as deleted by
 * the refresh, because a warning whose own end time has passed is over whatever
 * any table says. Nothing is kept for a week the way reports and disasters are:
 * last Tuesday's wind warning is not history, it is noise.
 *
 * Warnings that have not STARTED yet are kept, deliberately. A met service
 * issues up to about two days ahead, and "a red wind warning from Friday
 * morning" is exactly what somebody planning a trip wants to know. The page
 * labels them as upcoming rather than implying they are in force now.
 *
 * lat and lng come back too, from one of two places, and place_kind says which.
 * Eight of MeteoAlarm's services send a CAP polygon and its centre is used;
 * for the rest the area's NAME is looked up once and remembered, and where even
 * that fails the marker sits on the middle of the country and says so. A row
 * with no position at all still belongs in the chip and the list.
 */
let weatherCache = null;

export function fetchWeatherWarnings() {
  if (weatherCache) return weatherCache;
  if (!supabase) return Promise.resolve(new Map());

  const now = new Date().toISOString();
  weatherCache = supabase
    .from('weather_warnings')
    .select('warning_id,country_code,kind,severity,areas,from_date,to_date,source,url,'
            + 'lat,lng,place_kind')
    .or(`to_date.is.null,to_date.gte.${now}`)
    .then(({ data, error }) => {
      if (error) throw error;
      const byCountry = new Map();
      for (const row of data ?? []) {
        const list = byCountry.get(row.country_code) ?? [];
        list.push(row);
        byCountry.set(row.country_code, list);
      }
      for (const list of byCountry.values()) {
        list.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'severe' ? -1 : 1));
      }
      return byCountry;
    })
    .catch(err => {
      weatherCache = null;
      throw err;
    });
  return weatherCache;
}

/**
 * Where reporting is closed, as a set of country codes.
 *
 * Read once and kept: it changes when an administrator changes it, which is
 * rare, and asking on every pin would be a request per click. The database
 * refuses these reports whatever this says — this is only so the page can say
 * why before somebody types out a report that would be thrown away.
 *
 * A failed read is an open map. Being unable to reach the list is not a reason
 * to stop people reporting, and the rule that matters still holds underneath.
 */
let blockedCache = null;

export function fetchBlockedCountries() {
  if (blockedCache) return blockedCache;
  if (!supabase) return Promise.resolve(new Set());

  blockedCache = supabase.rpc('blocked_countries')
    .then(({ data, error }) => {
      if (error) throw error;
      return new Set((data ?? []).map(code => String(code).toUpperCase()));
    })
    .catch(err => {
      blockedCache = null;
      console.warn('could not read the blocked regions:', err);
      return new Set();
    });
  return blockedCache;
}

export async function fetchSafetyPlaces(bounds) {
  need();
  const { minLat, minLng, maxLat, maxLng } = bounds;
  const { data, error } = await supabase
    .from('safety_places')
    .select('id,kind,name,address,lat,lng,country_code,opening_hours,phone,emergency')
    .eq('kind', 'hospital')
    .gte('lat', minLat).lte('lat', maxLat)
    .gte('lng', minLng).lte('lng', maxLng)
    .limit(SAFETY_MAX_PLACES);
  if (error) throw error;
  return data ?? [];
}

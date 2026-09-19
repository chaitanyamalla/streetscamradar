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
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, isConfigured, PUBLIC_DETAIL_MAX_SPAN } from './config.js';

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
 */
export async function fetchForBounds(bounds, { signedIn }) {
  need();
  const { minLat, minLng, maxLat, maxLng } = bounds;

  if (signedIn) {
    const { data, error } = await supabase
      .from('reports_feed')
      .select('id,category,severity,headline,description,lat,lng,address,city,country_code,happened_at,support_count,is_mine')
      .gte('lat', minLat).lte('lat', maxLat)
      .gte('lng', minLng).lte('lng', maxLng)
      .order('happened_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    return { mode: 'member', reports: data ?? [], cells: [], hiddenCount: 0 };
  }

  const span = Math.max(maxLat - minLat, maxLng - minLng);
  if (span <= PUBLIC_DETAIL_MAX_SPAN) {
    const { data, error } = await supabase.rpc('public_sample_reports', {
      min_lat: minLat, min_lng: minLng, max_lat: maxLat, max_lng: maxLng,
    });
    if (error) throw error;
    const reports = data ?? [];
    const total = reports[0]?.total_in_view ?? 0;
    return { mode: 'sample', reports, cells: [], hiddenCount: Math.max(0, total - reports.length) };
  }

  const { data, error } = await supabase.rpc('public_area_summary', {
    min_lat: minLat, min_lng: minLng, max_lat: maxLat, max_lng: maxLng, cells: 14,
  });
  if (error) throw error;
  return { mode: 'summary', reports: [], cells: data ?? [], hiddenCount: 0 };
}

// --- Writing ---------------------------------------------------------------
export async function submitReport(report) {
  need();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to be signed in to file a report.');

  const { error } = await supabase.from('reports').insert({
    reporter_id: user.id,
    category: report.category,
    severity: report.severity,
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
  if (!user) throw new Error('Sign in to confirm a report.');
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
  if (!user) throw new Error('Sign in to flag a report.');
  const { error } = await supabase.from('report_flags')
    .insert({ report_id: reportId, user_id: user.id, reason });
  if (error && error.code !== '23505') throw error;
}

// --- Profile ---------------------------------------------------------------
export async function getProfile() {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from('profiles')
    .select('id,display_name,home_label,home_lat,home_lng').eq('id', user.id).maybeSingle();
  return data ?? null;
}

export async function saveHomeArea({ label, lat, lng }) {
  need();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase.from('profiles')
    .update({ home_label: label, home_lat: lat, home_lng: lng }).eq('id', user.id);
  if (error) throw error;
}

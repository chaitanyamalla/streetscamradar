// ---------------------------------------------------------------------------
// Sign-in: email magic link, or Google.
//
// Both are handled entirely by Supabase Auth — this file never sees or stores
// a password, and there is no password reset flow to get wrong.
// ---------------------------------------------------------------------------
import { supabase } from './data.js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, isConfigured } from './config.js';
import { t } from './i18n.js';

const listeners = new Set();
let currentUser = null;

/** Call `fn(user|null)` now and on every sign-in / sign-out. */
export function onAuthChange(fn) {
  listeners.add(fn);
  fn(currentUser);
  return () => listeners.delete(fn);
}

const announce = (user) => {
  currentUser = user;
  listeners.forEach(fn => { try { fn(user); } catch (e) { console.error(e); } });
};

export async function initAuth() {
  if (!supabase) { announce(null); return; }
  const { data: { session } } = await supabase.auth.getSession();
  announce(session?.user ?? null);
  supabase.auth.onAuthStateChange((_event, session) => announce(session?.user ?? null));
}

export const currentUserSync = () => currentUser;

/**
 * Supabase's raw auth errors are written for developers. Rewrite the ones a
 * visitor can actually do something about.
 */
function friendly(error) {
  const m = String(error?.message ?? '');
  for (const [pattern, key] of [
    [/Invalid login credentials/i,                     'authError.credentials'],
    [/User already registered|already been registered/i,'authError.registered'],
    [/Password should be at least/i,                   'authError.shortPassword'],
    [/email rate limit exceeded|over_email_send_rate_limit/i, 'authError.rateLimit'],
    [/Email not confirmed/i,                           'authError.unconfirmed'],
    [/provider is not enabled|Unsupported provider/i,  'authError.provider'],
  ]) {
    if (pattern.test(m)) return new Error(t(key));
  }
  // Anything we have not seen before keeps Supabase's own wording, which is at
  // least specific; only a blank one falls back to the generic line.
  return error instanceof Error ? error : new Error(m || t('authError.generic'));
}

const notConfigured = () => new Error(t('authError.notConfigured'));

/** Sign in with a password. No email is sent, so no rate limit applies. */
export async function signInWithPassword(email, password) {
  if (!supabase) throw notConfigured();
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim(), password,
  });
  if (error) throw friendly(error);
}

/**
 * Create an account with a password.
 * Returns { needsConfirmation: true } when the project still requires a
 * confirmation email, so the page can say so rather than appearing to hang.
 */
export async function signUpWithPassword(email, password) {
  if (!supabase) throw notConfigured();
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(), password,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw friendly(error);
  return { needsConfirmation: !data.session };
}

/**
 * Which sign-in methods are actually switched on for this project.
 *
 * Offering a Google button for a provider that is not enabled gets the user a
 * raw "Unsupported provider" error, so ask Supabase first and hide it instead.
 * The moment Google is enabled in the dashboard, the button reappears with no
 * code change.
 */
export async function enabledProviders() {
  const fallback = { email: true, google: false };
  if (!isConfigured()) return fallback;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
    });
    if (!res.ok) return fallback;
    const settings = await res.json();
    return { email: true, google: Boolean(settings?.external?.google) };
  } catch {
    return fallback;   // hide it rather than offer a button that errors
  }
}

/** Send a one-time sign-in link. Supabase creates the account if it is new. */
export async function sendMagicLink(email) {
  if (!supabase) throw notConfigured();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    // Bare origin, so it matches the allow-list entry exactly. Supabase only
    // honours this if it is listed under Authentication -> URL Configuration;
    // otherwise it silently falls back to Site URL, which defaults to
    // http://localhost:3000 and produces a dead link in the email.
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw friendly(error);
}

export async function signInWithGoogle() {
  if (!supabase) throw notConfigured();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw friendly(error);
}

/**
 * Change the password on the signed-in account. Supabase checks the session,
 * not the old password, so this only ever works for whoever is already here.
 */
export async function changePassword(password) {
  if (!supabase) throw notConfigured();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw friendly(error);
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

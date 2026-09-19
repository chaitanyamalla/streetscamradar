// ---------------------------------------------------------------------------
// Sign-in: email magic link, or Google.
//
// Both are handled entirely by Supabase Auth — this file never sees or stores
// a password, and there is no password reset flow to get wrong.
// ---------------------------------------------------------------------------
import { supabase } from './data.js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, isConfigured } from './config.js';

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
  if (/Invalid login credentials/i.test(m))
    return new Error('That email and password do not match an account. If you have not made one yet, use "Create account".');
  if (/User already registered|already been registered/i.test(m))
    return new Error('There is already an account with that email — use "Sign in" instead.');
  if (/Password should be at least/i.test(m))
    return new Error('Passwords need to be at least 6 characters.');
  if (/email rate limit exceeded|over_email_send_rate_limit/i.test(m))
    return new Error('Too many emails sent from this project in the last hour. Use a password instead, or try again later.');
  if (/Email not confirmed/i.test(m))
    return new Error('That account still needs confirming — check your email for the link.');
  if (/provider is not enabled|Unsupported provider/i.test(m))
    return new Error('That sign-in method is not switched on for this site yet.');
  return error instanceof Error ? error : new Error(m || 'Sign-in failed.');
}

/** Sign in with a password. No email is sent, so no rate limit applies. */
export async function signInWithPassword(email, password) {
  if (!supabase) throw new Error('Supabase is not configured yet.');
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
  if (!supabase) throw new Error('Supabase is not configured yet.');
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
  if (!supabase) throw new Error('Supabase is not configured yet.');
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
  if (!supabase) throw new Error('Supabase is not configured yet.');
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw friendly(error);
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

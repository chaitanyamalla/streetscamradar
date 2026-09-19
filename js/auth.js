// ---------------------------------------------------------------------------
// Sign-in: email magic link, or Google.
//
// Both are handled entirely by Supabase Auth — this file never sees or stores
// a password, and there is no password reset flow to get wrong.
// ---------------------------------------------------------------------------
import { supabase } from './data.js';

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

/** Send a one-time sign-in link. Supabase creates the account if it is new. */
export async function sendMagicLink(email) {
  if (!supabase) throw new Error('Supabase is not configured yet.');
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

export async function signInWithGoogle() {
  if (!supabase) throw new Error('Supabase is not configured yet.');
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

// Small in-file zustand-like store for auth session. Two-phase:
//   (a) hasToken() — we have a bearer, but perms may not be resolved yet.
//   (b) ready — the coordinator has told us who we are + what we can do.
// Consumers gate protected UI on session.can(x), which is false until ready.

import { useSyncExternalStore } from "react";
import { decodeToken, getToken, setToken, tokenExpiresSoon } from "@/lib/session";

type State = {
  token: string | null;
  user: string;
  perms: string[];
  ready: boolean;
  authed: boolean;
};

let state: State = load();
const listeners = new Set<() => void>();

function load(): State {
  // getToken()/setToken() are try/catch-wrapped for private-browsing modes,
  // where touching localStorage throws.
  const token = getToken();
  if (!token) return { token: null, user: "", perms: [], ready: true, authed: false };
  // The coordinator's token payload names the user "u", not "user".
  const decoded = decodeToken(token);
  return {
    token,
    user: decoded?.u ?? "",
    perms: expandPerms(decoded?.perms ?? []),
    ready: false,
    authed: true,
  };
}
function persist() {
  setToken(state.token || "");
}
function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

// Legacy `config` perm expands to the four fine-grained perms the modern UI
// checks. Keeps the console usable when talking to older coordinators.
function expandPerms(perms: string[]): string[] {
  const out = new Set(perms);
  if (out.has("config")) {
    out.add("saves"); out.add("mods"); out.add("settings"); out.add("watchdog");
  }
  return [...out];
}

export const session = {
  get token() { return state.token; },
  get user() { return state.user; },
  get perms() { return state.perms; },
  get authed() { return state.authed; },
  get ready() { return state.ready; },

  setSession(token: string, user: string, perms: string[]) {
    set({ token, user, perms: expandPerms(perms), ready: true, authed: true });
    persist();
  },
  setPerms(user: string, perms: string[]) {
    set({ user, perms: expandPerms(perms), ready: true });
  },
  markReady() { if (!state.ready) set({ ready: true }); },
  clear() { set({ token: null, user: "", perms: [], ready: true, authed: false }); persist(); },
  isTokenExpiringSoon() { return state.token ? tokenExpiresSoon(state.token) : false; },

  can(perm: string): boolean {
    if (!state.authed || !state.ready) return false;
    return state.perms.includes(perm);
  },
};

function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
function getSnapshot() { return state; }

export function useSession(): State {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Tiny zustand-like store (no dependency) for session state.
import { useSyncExternalStore } from "react";
import { clearToken, decodeToken, getToken, isExpired, setToken } from "@/lib/session";

export interface SessionState {
  token: string;
  user: string;
  perms: string[];
  authed: boolean;
  ready: boolean;   // false during initial /api/session bootstrap
}

type Listener = () => void;

const listeners = new Set<Listener>();
let state: SessionState = bootstrap();

function bootstrap(): SessionState {
  const token = getToken();
  const p = decodeToken(token);
  if (!p || isExpired(p)) {
    clearToken();
    return { token: "", user: "", perms: [], authed: false, ready: false };
  }
  return { token, user: p.u, perms: Array.isArray(p.perms) ? p.perms : [], authed: true, ready: false };
}

function emit() { listeners.forEach((l) => l()); }

export const session = {
  get(): SessionState { return state; },
  subscribe(l: Listener): () => void { listeners.add(l); return () => listeners.delete(l); },
  setSession(token: string, user: string, perms: string[]): void {
    setToken(token);
    state = { token, user, perms: perms || [], authed: !!token, ready: true };
    emit();
  },
  setPerms(user: string, perms: string[]): void {
    state = { ...state, user, perms: perms || [], ready: true };
    emit();
  },
  markReady(): void {
    if (!state.ready) { state = { ...state, ready: true }; emit(); }
  },
  clear(): void {
    clearToken();
    state = { token: "", user: "", perms: [], authed: false, ready: true };
    emit();
  },
  handleUnauthorized(): void { this.clear(); },
  can(perm: string): boolean {
    if (!state.authed) return false;
    if (state.perms.includes(perm)) return true;
    // Legacy coarse 'config' expands to saves/mods/settings/watchdog.
    if (state.perms.includes("config") && ["saves","mods","settings","watchdog"].includes(perm)) return true;
    return false;
  },
};

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.get, session.get);
}
export function usePermission(perm: string): boolean {
  const s = useSession();
  if (!s.authed) return false;
  if (s.perms.includes(perm)) return true;
  if (s.perms.includes("config") && ["saves","mods","settings","watchdog"].includes(perm)) return true;
  return false;
}

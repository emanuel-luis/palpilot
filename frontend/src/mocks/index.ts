// Mock adapter — intercepts fetch() when enabled, so the whole app is
// demonstrable without the coordinator running. Toggle with VITE_MOCK.
// Also exposes a dev-only "state switcher" the console renders on top.

import { fixtures, resetFixtures } from "./fixtures";
import { handle } from "./handlers";

const forcedOn = import.meta.env.VITE_MOCK === "1" || import.meta.env.DEV;

let enabled = forcedOn;

export function isMockEnabled(): boolean { return enabled; }
export function setMockEnabled(v: boolean): void { enabled = v; }

// dev-only knobs (see DevSwitcher component)
export const knobs = {
  vmForce: "" as "" | "off" | "starting" | "on" | "STOPPING",
  role: "owner" as "owner" | "operator" | "moderator" | "viewer",
  showPlayers: true,
  forceStale: false,
  next503: false,
  next409: false,
  latencyMs: 220,
};

export async function mockFetch(url: string, init: RequestInit): Promise<Response> {
  // Strip the same prefix api.ts prepends. Deliberately NOT location.pathname:
  // with the SPA fallback in place that is the current route (/console), not the
  // mount point, so it would fail to match and every mock route would 404.
  // Computed from the env var rather than importing BASE, which would make
  // mocks <-> api a circular import evaluated at module load.
  const base = (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");
  const rawPath = url.startsWith(base) ? url.slice(base.length) : url;
  const [path, queryString] = rawPath.split("?");
  const query = new URLSearchParams(queryString || "");
  const method = (init.method || "GET").toUpperCase();

  await new Promise((r) => setTimeout(r, knobs.latencyMs));

  // A real transport failure REJECTS; it does not resolve with a status. `new
  // Response("", {status: 0})` throws a RangeError (the constructor only accepts
  // 200-599), so this only "worked" by accident. Reject deterministically instead
  // — the random gate made the stale state impossible to reproduce.
  if (knobs.forceStale && path !== "/api/login" && path !== "/api/session") {
    return Promise.reject(new TypeError("Failed to fetch"));
  }

  const res = await handle({ method, path, query, body: init.body, fixtures, knobs });
  return res;
}

export { fixtures, resetFixtures };

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
  // strip BASE prefix (matches location.pathname stripping in api.ts)
  const base = location.pathname.replace(/\/+$/, "");
  const rawPath = url.startsWith(base) ? url.slice(base.length) : url;
  const [path, queryString] = rawPath.split("?");
  const query = new URLSearchParams(queryString || "");
  const method = (init.method || "GET").toUpperCase();

  await new Promise((r) => setTimeout(r, knobs.latencyMs));

  if (knobs.forceStale && Math.random() < 0.5 && path !== "/api/login" && path !== "/api/session") {
    return new Response("", { status: 0 as any }); // fetch itself would throw; simulate via network_error path
  }

  const res = await handle({ method, path, query, body: init.body, fixtures, knobs });
  return res;
}

export { fixtures, resetFixtures };

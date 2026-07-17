// Fetch wrapper shared by every store/view. Responsibilities (per
// docs/FRONTEND_V2_PLAN.md's API contract):
//
//   - Adds `Authorization: Bearer <token>` from the session store when a
//     token is present (never for the initial /api/login call, which has none).
//   - Parses the coordinator's uniform envelope `{ ok, error, ...data }` and
//     normalizes network/transport failures into the same shape, so callers
//     never need a try/catch.
//   - On HTTP 401 (except from /api/login itself, where a 401 just means
//     "bad credentials, stay on the login screen"): clears the session and
//     lets App.vue's reactive view-switch fall back to LoginView.
//   - Maintains a busy registry so buttons can bind `:loading` to a specific
//     in-flight action (via `opts.key`) instead of a single global spinner.
//   - Base path = `location.pathname` (stripped of trailing slashes), matching
//     the legacy UI: the coordinator serves this file from whatever path it's
//     mounted at, and API routes are siblings of that path, not the origin root.
//
// NOTE on the api.js <-> stores/session.js circular import: api.js calls
// `useSessionStore()` and stores/session.js calls `apiGet/apiPost` from here.
// This is safe because both only *use* the imported bindings inside function
// bodies (never at module-evaluation time), which is the standard pattern for
// breaking circular ESM dependencies between a store and its own dependencies.
import { reactive } from "vue";

import { useSessionStore } from "./stores/session";

const BASE = location.pathname.replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// busy registry
// ---------------------------------------------------------------------------

const busyState = reactive({ total: 0, keys: {} });

/** True while any request is in flight (no key) or a specific keyed action is. */
export function isBusy(key) {
  if (!key) return busyState.total > 0;
  return (busyState.keys[key] || 0) > 0;
}

function beginBusy(key) {
  busyState.total += 1;
  if (key) busyState.keys[key] = (busyState.keys[key] || 0) + 1;
}

function endBusy(key) {
  busyState.total = Math.max(0, busyState.total - 1);
  if (key) busyState.keys[key] = Math.max(0, (busyState.keys[key] || 0) - 1);
}

/** Reactive read-only handle, for components that want to render off it directly. */
export const busy = busyState;

// ---------------------------------------------------------------------------
// core request
// ---------------------------------------------------------------------------

/**
 * @param {string} method
 * @param {string} path        must start with "/", e.g. "/api/overview"
 * @param {*} [body]            plain object -> JSON-encoded; Blob/File/ArrayBuffer -> sent as-is (mods upload)
 * @param {object} [opts]
 * @param {string} [opts.key]         busy-registry key for `isBusy(key)`
 * @param {Object<string,string>} [opts.headers]  extra headers (e.g. Content-Type override for raw uploads)
 * @param {string} [opts.query]       query string, WITHOUT the leading "?"
 * @returns {Promise<{ok:boolean,status:number,error:string|null,data:object}>}
 */
async function request(method, path, body, opts = {}) {
  const { key, headers: extraHeaders, query } = opts;
  const session = useSessionStore();
  beginBusy(key);
  try {
    const headers = { ...(extraHeaders || {}) };
    if (session.token) headers.Authorization = `Bearer ${session.token}`;

    let payload;
    const isRaw = body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array;
    if (body !== undefined && !isRaw) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      payload = JSON.stringify(body);
    } else {
      payload = body;
    }

    const url = BASE + path + (query ? `?${query}` : "");
    let res;
    try {
      res = await fetch(url, { method, headers, body: payload });
    } catch {
      return { ok: false, status: 0, error: "network_error", data: {} };
    }

    let data = {};
    try {
      data = await res.json();
    } catch {
      // empty/non-JSON body (e.g. a 204) — treat as {} and rely on res.ok/res.status
    }

    if (res.status === 401 && path !== "/api/login") {
      session.handleUnauthorized();
    }

    const ok = res.ok && data.ok !== false;
    return { ok, status: res.status, error: ok ? null : data.error || `http_${res.status}`, data };
  } finally {
    endBusy(key);
  }
}

export const apiGet = (path, opts) => request("GET", path, undefined, opts);
export const apiPost = (path, body, opts) => request("POST", path, body ?? {}, opts);
export const apiDelete = (path, opts) => request("DELETE", path, undefined, opts);

/** Raw-body POST for uploads (mods): body is a Blob/File, not JSON-encoded. */
export const apiUpload = (path, blobOrFile, opts = {}) =>
  request("POST", path, blobOrFile, {
    ...opts,
    headers: { "Content-Type": "application/octet-stream", ...(opts.headers || {}) },
  });

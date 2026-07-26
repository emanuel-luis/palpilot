// The one HTTP client for the whole app.
//
// Base path is location.pathname (trailing slashes stripped) — the coordinator
// serves this bundle at an arbitrary path and the API routes are SIBLINGS of
// that path, not the origin root. So a /api/overview call becomes
// `${BASE}/api/overview`.
//
// Handles all five response shapes from the spec:
//   1. envelope   { ok, error, ...data }
//   2. FastAPI    { detail }
//   3. raw game JSON (no ok, no error)
//   4. raw agent  { raw, options, path } or { saved: true } etc.
//   5. non-JSON   binary downloads, plain-text 401 "Unauthorized", plain-text 500
//
// Success rule: res.ok && data.ok !== false  (a 2xx with no ok key = success).
// Never let await res.json() throw — always try/catch it.

import { session } from "@/stores/session";
import { mockFetch, isMockEnabled } from "@/mocks";

// API base. This MUST NOT be derived from location.pathname any more: the
// coordinator now serves an SPA fallback, so a deep link or reload lands on
// /console and pathname is no longer the mount point — every call would resolve
// to /console/api/... Cloud Run serves the service at the origin root, so the
// base is empty; set VITE_API_BASE at build time if it is ever mounted under a
// path prefix.
export const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");

export type ApiResult<T = any> = {
  ok: boolean;
  status: number;
  error: string | null;
  data: T;
};

async function rawFetch(url: string, init: RequestInit): Promise<Response> {
  if (isMockEnabled()) return mockFetch(url, init);
  return fetch(url, init);
}

async function readBody(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text().catch(() => "");
  if (!text) return {};
  if (ct.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try { return JSON.parse(text); } catch { /* fallthrough */ }
  }
  return { _raw: text };
}

interface Opts {
  headers?: Record<string, string>;
  query?: string;
  signal?: AbortSignal;
}

async function request<T = any>(
  method: string,
  path: string,
  body?: any,
  opts: Opts = {}
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;

  let payload: BodyInit | undefined;
  if (body == null || body === undefined) {
    payload = undefined;
  } else if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) {
    payload = body as BodyInit;
  } else if (typeof body === "string") {
    payload = body;
    if (!headers["Content-Type"]) headers["Content-Type"] = "text/plain";
  } else {
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const url = BASE + path + (opts.query ? `?${opts.query}` : "");

  let res: Response;
  try {
    res = await rawFetch(url, { method, headers, body: payload, signal: opts.signal });
  } catch (_e) {
    return { ok: false, status: 0, error: "network_error", data: {} as T };
  }

  const data = await readBody(res);

  // A 401 anywhere but /api/login means the token is dead (expired, or its `ver`
  // was bumped by logout-all / a password change): drop it so the app falls back
  // to the login screen. On /api/login a 401 just means "wrong password".
  if (res.status === 401 && path !== "/api/login") {
    session.clear();
  }

  const dataOkField = (data && typeof data === "object" ? (data as any).ok : undefined);
  const ok = res.ok && dataOkField !== false;
  const error = ok
    ? null
    : ((data && (data as any).error) || (data && (data as any).detail) || `http_${res.status}`);
  return { ok, status: res.status, error, data: data as T };
}

export const apiGet    = <T = any>(path: string, opts?: Opts) => request<T>("GET", path, undefined, opts);
export const apiPost   = <T = any>(path: string, body?: any, opts?: Opts) => request<T>("POST", path, body ?? {}, opts);
export const apiDelete = <T = any>(path: string, opts?: Opts) => request<T>("DELETE", path, undefined, opts);

export const apiUpload = <T = any>(path: string, blob: Blob | ArrayBuffer | Uint8Array, opts: Opts = {}) =>
  request<T>("POST", path, blob, {
    ...opts,
    headers: { "Content-Type": "application/octet-stream", ...(opts.headers || {}) },
  });

// Authenticated file download. The server strips Content-Disposition, so the
// filename MUST be supplied client-side. On non-2xx, try to pull { detail } or
// { error } out of the JSON body.
export async function apiDownload(path: string, filename: string): Promise<{ ok: boolean; error: string | null }> {
  const headers: Record<string, string> = {};
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  let res: Response;
  try {
    res = await rawFetch(BASE + path, { method: "GET", headers });
  } catch { return { ok: false, error: "network_error" }; }
  if (res.status === 401) { session.clear(); return { ok: false, error: "unauthorized" }; }
  if (!res.ok) {
    const body = await readBody(res);
    return { ok: false, error: (body as any).detail || (body as any).error || `download_failed_${res.status}` };
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { ok: true, error: null };
}

// Low-level session-token utilities: localStorage persistence + decoding the
// compact JWT-like token described in docs/FRONTEND_V2_PLAN.md:
//
//   base64url(header) + "." + base64url(payload) + "." + hex(HMAC-SHA256(...))
//   payload = { u, perms, iat, exp, ver }
//
// The frontend NEVER verifies the signature (that's the coordinator's job on
// every request) — decoding here is only so the app can restore `{user,perms}`
// and know the expiry after a page reload, without an extra round-trip.
//
// Deliberately framework-free (no pinia here) so it stays trivially testable
// and importable from anywhere, including outside components.

const STORAGE_KEY = "palpilot.token";

export function getToken() {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return ""; // storage disabled/unavailable (private mode, etc.)
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort only */
  }
}

export function clearToken() {
  setToken("");
}

function base64UrlToBase64(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  return pad ? padded + "=".repeat(4 - pad) : padded;
}

/**
 * Decode the payload segment of a session token. Returns null if the token
 * is missing, malformed, or not valid JSON — callers must treat null as "no
 * usable session".
 */
export function decodeToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = atob(base64UrlToBase64(parts[1]));
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/**
 * True if the decoded payload is missing/malformed or its `exp` (unix
 * seconds) has passed (with a small clock-skew allowance). Callers should
 * treat "expired" the same as "no session" — the coordinator is the source
 * of truth regardless.
 */
export function isExpired(payload, skewSeconds = 30) {
  if (!payload || typeof payload.exp !== "number") return true;
  return Date.now() / 1000 >= payload.exp - skewSeconds;
}

export function secondsUntilExpiry(payload) {
  if (!payload || typeof payload.exp !== "number") return 0;
  return Math.max(0, Math.round(payload.exp - Date.now() / 1000));
}

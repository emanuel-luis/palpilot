// Session token helpers — persistence + decode. The frontend never verifies
// the signature; the coordinator does that on every request. Decoding is only
// to restore { user, perms } after a reload without a round-trip.

const STORAGE_KEY = "palpilot.token";

export interface TokenPayload {
  u: string;
  perms: string[];
  iat?: number;
  exp?: number;
  ver?: number;
}

export function getToken(): string {
  try { return localStorage.getItem(STORAGE_KEY) || ""; } catch { return ""; }
}
export function setToken(t: string): void {
  try { if (t) localStorage.setItem(STORAGE_KEY, t); else localStorage.removeItem(STORAGE_KEY); } catch { /* private */ }
}
export function clearToken(): void { setToken(""); }

function b64urlToB64(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  return pad ? padded + "=".repeat(4 - pad) : padded;
}

export function decodeToken(token: string): TokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = atob(b64urlToB64(parts[1]));
    const p = JSON.parse(json);
    return p && typeof p === "object" ? p : null;
  } catch { return null; }
}

export function isExpired(p: TokenPayload | null, skew = 30): boolean {
  if (!p || typeof p.exp !== "number") return true;
  return Date.now() / 1000 >= p.exp - skew;
}

/** True when `token` is missing, unparseable, or within `skew` seconds of expiry. */
export function tokenExpiresSoon(token: string, skew = 300): boolean {
  return isExpired(decodeToken(token), skew);
}

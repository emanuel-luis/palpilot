// Auth/session state. Wraps ../session.js (token storage/decoding) with the
// actual API calls from docs/FRONTEND_V2_PLAN.md's auth contract:
//
//   POST /api/login          {username,password} -> {ok,token,user,perms,exp}  (429 + retry_after when throttled)
//   POST /api/logout         (client just drops the token; call is best-effort)
//   POST /api/logout-all     bumps the caller's token `ver` (invalidates every outstanding token, incl. this one)
//   POST /api/account/password  {old,new} -> re-hash + bump `ver` (also invalidates the current token)
//
// `me`/`perms` are populated two ways: directly from a fresh /api/login
// response, or decoded from the stored token's payload on page reload (see
// restore()). Either way they reflect the token currently held, not a
// separate profile fetch.
import { defineStore } from "pinia";

import { apiGet, apiPost } from "../api";
import { clearToken, decodeToken, getToken, isExpired, setToken } from "../session";

export const useSessionStore = defineStore("session", {
  state: () => ({
    token: getToken(),
    user: "",
    perms: [],
    ready: false, // true once the initial restore-from-localStorage pass has run
    loginBusy: false,
    loginError: "",
    retryAfter: 0, // seconds, set from a 429's retry_after
  }),

  getters: {
    isAuthenticated: (state) => !!state.token && !!state.user,
    can: (state) => (perm) => !perm || state.perms.includes(perm),
  },

  actions: {
    /** Call once at startup: recover {user,perms} from a stored token, or clear it if unusable. */
    restore() {
      const payload = decodeToken(this.token);
      if (this.token && payload && !isExpired(payload)) {
        this.user = payload.u || "";
        this.perms = Array.isArray(payload.perms) ? payload.perms : [];
        // The token's embedded perms can be stale (e.g. a pre-v3 token still
        // carries the coarse "config" perm for up to 12h). Refresh from the
        // server, which returns fresh, already-expanded effective perms.
        this.refresh();
      } else {
        this._clear();
      }
      this.ready = true;
    },

    /** Refresh {user,perms} from the server's authoritative /api/session. */
    async refresh() {
      const r = await apiGet("/api/session");
      if (r.ok && r.data) {
        this.user = r.data.user || this.user;
        if (Array.isArray(r.data.perms)) this.perms = r.data.perms;
      }
    },

    _clear() {
      this.token = "";
      this.user = "";
      this.perms = [];
      clearToken();
    },

    /** Called by api.js on any 401 (except from /api/login). */
    handleUnauthorized() {
      this._clear();
    },

    async login(username, password) {
      this.loginBusy = true;
      this.loginError = "";
      this.retryAfter = 0;
      try {
        const r = await apiPost("/api/login", { username, password }, { key: "login" });
        if (r.ok && r.data.token) {
          this.token = r.data.token;
          setToken(this.token);
          this.user = r.data.user || decodeToken(this.token)?.u || username;
          this.perms = r.data.perms || [];
          this.ready = true;
          return true;
        }
        if (r.status === 429) this.retryAfter = r.data.retry_after || 0;
        this.loginError = r.data.error || r.error || "login_failed";
        return false;
      } finally {
        this.loginBusy = false;
      }
    },

    async logout() {
      // Best-effort; the server treats this as a no-op (the token just isn't
      // reused again), so a network failure here must never block sign-out.
      try {
        await apiPost("/api/logout", {}, { key: "logout" });
      } catch {
        /* ignore */
      }
      this._clear();
    },

    /** Bumps `ver` server-side, invalidating every token for this user — including the current one. */
    async logoutAll() {
      const r = await apiPost("/api/logout-all", {}, { key: "logout-all" });
      this._clear();
      return r;
    },

    /**
     * Password change also bumps `ver` (per the plan), so the token this
     * request was authorized with becomes stale the instant it succeeds.
     * We always clear locally on success so the UI falls back to LoginView
     * and the user re-authenticates with the new password.
     */
    async changePassword(oldPassword, newPassword) {
      const r = await apiPost(
        "/api/account/password",
        { old: oldPassword, new: newPassword },
        { key: "change-password" },
      );
      if (r.ok) this._clear();
      return r;
    },
  },
});

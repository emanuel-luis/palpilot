// VM + Palworld-server state: overview polling, power, and the config
// (PalWorldSettings.ini) editor's load/save round-trip. Mirrors the routes
// the coordinator already exposes (see coordinator/main.py ROUTES) and that
// docs/FRONTEND_V2_PLAN.md keeps unchanged:
//
//   GET  /api/overview        -> {ok, vm:{status,ip,game_port}, server:{info,metrics,players}|null}
//   POST /api/vm/start|stop   -> {ok, starting|stopping}
//   GET  /api/config          -> {ok, options, raw, path}       (parsed PalWorldSettings.ini)
//   GET  /api/rest/settings   -> effective settings straight from the Palworld REST API
//   POST /api/config?restart= {options:{...}} | {raw:"..."}  -> {ok}
import { defineStore } from "pinia";

import { apiGet, apiPost } from "../api";

const TRANSITION_RE = /STOPPING|STAGING|PROVISIONING|REPAIRING|SUSPEND/;

export const useServerStore = defineStore("server", {
  state: () => ({
    vm: { status: "", ip: "", game_port: "" },
    server: null, // {info, metrics, players} while RUNNING, else null
    pollFails: 0,
    stale: false,
    _timer: null,

    configOptions: {}, // effective settings (from /api/rest/settings)
    configRaw: "",
    configPath: "",
    configLoaded: false,
  }),

  getters: {
    isRunning: (s) => s.vm.status === "RUNNING",
    isTransitioning: (s) => TRANSITION_RE.test(s.vm.status || ""),
    canStart: (s) => !!s.vm.status && s.vm.status !== "RUNNING" && !TRANSITION_RE.test(s.vm.status),
    info: (s) => (s.server && s.server.info) || null,
    metrics: (s) => (s.server && s.server.metrics) || null,
    players: (s) => (s.server && s.server.players) || [],
    /** `ip:port` players paste into Palworld's "Join via IP" box ("" until the IP is known). */
    joinAddress: (s) => (s.vm.ip ? `${s.vm.ip}:${s.vm.game_port || 8211}` : ""),

    /**
     * State of the *game server* (palworld.service), which is not the same thing
     * as the VM's power state: the VM boots in seconds but the game needs ~2min
     * more before its REST API answers. /api/overview only fills `server` while
     * the VM is RUNNING, and its `info` only once the game answers, so:
     *   offline  — VM is off (or transitioning): the game can't be up
     *   starting — VM is RUNNING but the game isn't answering yet
     *   online   — the game answered
     */
    gameState: (s) => {
      if (s.vm.status !== "RUNNING") return "offline";
      return s.server && s.server.info ? "online" : "starting";
    },
  },

  actions: {
    async pollOverview() {
      const r = await apiGet("/api/overview", { key: "overview" });
      if (r.ok) {
        this.vm = r.data.vm || this.vm;
        this.server = r.data.server ?? null;
        this.pollFails = 0;
        this.stale = false;
      } else if (r.status !== 401) {
        this.pollFails += 1;
        if (this.pollFails >= 2) this.stale = true;
      }
      return r;
    },

    /** Start polling every `intervalMs` (default 8s per the plan). Idempotent. */
    startPolling(intervalMs = 8000) {
      if (this._timer) return;
      this.pollOverview();
      this._timer = setInterval(() => this.pollOverview(), intervalMs);
    },

    stopPolling() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
    },

    async startVm() {
      const r = await apiPost("/api/vm/start", {}, { key: "vm-power" });
      setTimeout(() => this.pollOverview(), 3000);
      return r;
    },

    async stopVm() {
      const r = await apiPost("/api/vm/stop", {}, { key: "vm-power" });
      setTimeout(() => this.pollOverview(), 3000);
      return r;
    },

    async loadConfig() {
      const [eff, cfg] = await Promise.all([
        apiGet("/api/rest/settings", { key: "config" }),
        apiGet("/api/config", { key: "config" }),
      ]);
      this.configRaw = cfg.ok ? cfg.data.raw || "" : "";
      this.configPath = cfg.ok ? cfg.data.path || "" : "";
      this.configOptions = eff.ok ? eff.data : {};
      this.configLoaded = eff.ok;
      return eff;
    },

    /**
     * @param {Object<string,*>} changedOptions  key/value pairs that differ from the loaded snapshot
     * @param {{restart?: boolean, raw?: string}} [opts]  pass `raw` to save the raw-INI editor instead
     */
    async saveConfig(changedOptions, { restart = false, raw } = {}) {
      const body = raw !== undefined ? { raw } : { options: changedOptions };
      return apiPost("/api/config", body, { key: "config", query: `restart=${restart}` });
    },
  },
});

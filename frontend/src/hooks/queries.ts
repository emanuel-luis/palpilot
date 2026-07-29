// Server state. Every path here is verbatim from the coordinator's route table:
// there is no /api/power/* and no /api/settings — power is /api/vm/*, settings are
// /api/config plus the game's own /api/rest/settings.
//
// 503 {ok:false, error:"vm_offline"} is returned by EVERY proxied route while the
// VM is off. That is a normal state, not a failure, so `unwrap` resolves it as
// data (`{ offline: true }`) instead of rejecting — a rejection would put
// react-query into `error` and the UI would show a failure where it should show
// a calm "start the server first".
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiDelete, type ApiResult } from "@/lib/api";
import { session, useSession } from "@/stores/session";

export type MaybeOffline<T> = (T & { offline?: false }) | { offline: true; vmStatus: string };

/** Narrows any query payload to the vm_offline sentinel. */
export function isOffline(d: unknown): d is { offline: true; vmStatus: string } {
  return !!d && typeof d === "object" && (d as any).offline === true;
}

/** Resolve the payload, pass vm_offline through as data, reject anything else. */
function unwrap<T = any>(r: ApiResult<any>): MaybeOffline<T> | Promise<never> {
  if (r.status === 503 && (r.data as any)?.error === "vm_offline") {
    return { offline: true, vmStatus: (r.data as any)?.status || "TERMINATED" };
  }
  if (!r.ok) return Promise.reject(r);
  return r.data as T & { offline?: false };
}

// --------------------------------------------------------------- overview

export function useOverview() {
  const s = useSession();
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => apiGet<any>("/api/overview"),
    enabled: s.authed && s.ready,
    // One timer, adaptive: faster while the VM is mid-transition, 8s at rest
    // (the spec's cadence), slower when it's off and nothing can change on its own.
    refetchInterval: (q) => {
      const st = (q.state.data as any)?.data?.vm?.status;
      if (st === "PROVISIONING" || st === "STAGING" || st === "STOPPING" || st === "REPAIRING") return 3000;
      if (st === "RUNNING") return 8000;
      return 15000;
    },
    refetchOnWindowFocus: true,
    staleTime: 1000,
  });
}

export function usePower() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "start" | "stop") => apiPost(`/api/vm/${action}`),
    // The compute call is fire-and-forget; re-poll shortly after so the pill moves.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["overview"] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["overview"] }), 3000);
    },
  });
}

/** POST /api/restart — restarts the game process only. Perm: settings. */
export function useRestartGame() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost("/api/restart"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["overview"] }),
  });
}

// --------------------------------------------------------------- saves

export function useSaves() {
  return useQuery({
    queryKey: ["saves"],
    queryFn: () => apiGet<any>("/api/saves").then(unwrap),
    enabled: session.can("view"),
  });
}

/** GET /api/saves/{guid}/backups — only fetched while a slot's panel is open. */
export function useBackups(guid: string | null) {
  return useQuery({
    queryKey: ["backups", guid],
    queryFn: () => apiGet<any>(`/api/saves/${encodeURIComponent(guid!)}/backups`).then(unwrap),
    enabled: !!guid && session.can("view"),
  });
}

function invalidateSaves(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["saves"] });
  qc.invalidateQueries({ queryKey: ["backups"] });
}

export function useCreateSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiPost("/api/saves", { name }),
    onSuccess: () => invalidateSaves(qc),
  });
}
export function useCloneSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ guid, name }: { guid: string; name: string }) =>
      apiPost(`/api/saves/${encodeURIComponent(guid)}/clone`, { name }),
    onSuccess: () => invalidateSaves(qc),
  });
}
export function useRenameSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ guid, name }: { guid: string; name: string }) =>
      apiPost(`/api/saves/${encodeURIComponent(guid)}/rename`, { name }),
    onSuccess: () => invalidateSaves(qc),
  });
}
/** Activating swaps the world AND must restart the game for it to take effect. */
export function useActivateSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (guid: string) =>
      apiPost<any>(`/api/saves/${encodeURIComponent(guid)}/activate`, {}, { query: "restart=true" }),
    onSuccess: () => { invalidateSaves(qc); qc.invalidateQueries({ queryKey: ["overview"] }); },
  });
}
export function useBackupSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (guid: string) => apiPost(`/api/saves/${encodeURIComponent(guid)}/backup`),
    onSuccess: () => invalidateSaves(qc),
  });
}
/** The body key is `ref`, not `backup`. A restore always activates the target. */
export function useRestoreBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ guid, ref, asNewSlot, name }: { guid: string; ref: string; asNewSlot?: boolean; name?: string }) =>
      apiPost(`/api/saves/${encodeURIComponent(guid)}/restore`, {
        ref,
        ...(asNewSlot ? { as_new_slot: true, ...(name ? { name } : {}) } : {}),
      }),
    onSuccess: () => { invalidateSaves(qc); qc.invalidateQueries({ queryKey: ["overview"] }); },
  });
}
export function useDeleteSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (guid: string) => apiDelete(`/api/saves/${encodeURIComponent(guid)}`),
    onSuccess: () => invalidateSaves(qc),
  });
}

// --------------------------------------------------------------- game version
//
// The agent installs in a background thread (a steamcmd run outlives any request
// the coordinator holds open), so apply answers immediately and progress is read
// back from the `job` field — hence the fast refetch while a job is running.

export function useGameVersion() {
  return useQuery({
    queryKey: ["update"],
    queryFn: () => apiGet<any>("/api/update").then(unwrap),
    enabled: session.can("view"),
    refetchInterval: (q) => {
      const d: any = q.state.data;
      return d && !d.offline && d.job?.state === "running" ? 4000 : false;
    },
  });
}

/** POST /api/update/check — asks Steam for the current public buildid. */
export function useCheckUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<any>("/api/update/check"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["update"] }),
  });
}

/** POST /api/update/apply — `target` is "latest" or a buildid. Restarts the game. */
export function useApplyUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ target, force }: { target: string; force?: boolean }) =>
      apiPost<any>("/api/update/apply", { target, restart: true, ...(force ? { force: true } : {}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["update"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

/**
 * POST /api/update/steam-login — completes the Steam sign-in on the VM.
 *
 * The password is NOT sent from here; it comes from instance metadata. This only
 * carries the one-time Steam Guard code Steam wants per new machine.
 */
export function useSteamLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => apiPost<any>("/api/update/steam-login", code ? { code } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["update"] }),
  });
}

export function useUpdatePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (auto_update: boolean) => apiPost<any>("/api/update/policy", { auto_update }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["update"] }),
  });
}

/**
 * POST /api/saves/{guid}/version — binds a game build to a save.
 *
 * Under /api/saves, so this needs the `saves` permission, not `settings`: the
 * version a world runs on is part of the world. `apply` additionally installs it
 * right away, which only means anything for the active save.
 */
export function useSetSaveVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ guid, mode, buildid, apply }: { guid: string; mode: "latest" | "pinned"; buildid?: string; apply?: boolean }) =>
      apiPost<any>(`/api/saves/${encodeURIComponent(guid)}/version`, {
        mode,
        ...(buildid ? { buildid } : {}),
        ...(apply ? { apply: true } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["saves"] });
      qc.invalidateQueries({ queryKey: ["update"] });
    },
  });
}

// --------------------------------------------------------------- settings
//
// Two reads, merged: /api/config carries the raw INI text, the file path and the
// secret keys the game's REST API omits; /api/rest/settings carries the values the
// game is actually running. Effective values win; secrets survive.

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const [cfg, eff] = await Promise.all([
        apiGet<any>("/api/config"),
        apiGet<any>("/api/rest/settings"),
      ]);
      if (cfg.status === 503 && (cfg.data as any)?.error === "vm_offline") {
        return { offline: true as const, vmStatus: (cfg.data as any)?.status || "TERMINATED" };
      }
      if (!cfg.ok) return Promise.reject(cfg);
      const options: Record<string, string> = { ...((cfg.data as any)?.options || {}) };
      if (eff.ok && eff.data && typeof eff.data === "object") {
        for (const [k, v] of Object.entries(eff.data as Record<string, unknown>)) {
          if (v === null || typeof v === "object") continue; // skip arrays/objects
          options[k] = String(v);
        }
      }
      return {
        options,
        raw: (cfg.data as any)?.raw || "",
        path: (cfg.data as any)?.path || "",
      };
    },
    enabled: session.can("view"),
  });
}

/** POST /api/config?restart= with {options} or {raw}. Returns {saved:true}. */
export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ options, raw, restart }: { options?: Record<string, string>; raw?: string; restart?: boolean }) =>
      apiPost("/api/config", options ? { options } : { raw }, { query: `restart=${!!restart}` }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); qc.invalidateQueries({ queryKey: ["overview"] }); },
  });
}

/**
 * Settings for ONE save, which may not be the active one.
 *
 * Under /api/config rather than /api/saves on purpose: that prefix is gated
 * view/settings by the coordinator, which is the right permission for editing
 * settings — /api/saves would have applied the `saves` permission instead.
 *
 * For the active slot the server reads the live file, so this and useSettings()
 * agree. For any other slot it reads that slot's stored copy, and `stored:false`
 * means the slot has never been activated and has no config of its own yet.
 */
export function useSlotSettings(guid: string | null) {
  return useQuery({
    queryKey: ["settings", "slot", guid],
    queryFn: () => apiGet<any>(`/api/config/slot/${encodeURIComponent(guid!)}`).then(unwrap),
    enabled: !!guid && session.can("view"),
  });
}

export function useSaveSlotSettings(guid: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ options, raw, restart }: { options?: Record<string, string>; raw?: string; restart?: boolean }) =>
      apiPost(
        `/api/config/slot/${encodeURIComponent(guid!)}`,
        options ? { options } : { raw },
        { query: `restart=${!!restart}` },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      // Editing the active slot rewrites the live file, so the overview's
      // server name can change too.
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

export function useResetSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ restart }: { restart?: boolean }) =>
      apiPost<any>("/api/config/reset", {}, { query: `restart=${!!restart}` }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); qc.invalidateQueries({ queryKey: ["overview"] }); },
  });
}

// --------------------------------------------------------------- mods

export function useMods() {
  return useQuery({
    queryKey: ["mods"],
    queryFn: () => apiGet<any>("/api/mods").then(unwrap),
    enabled: session.can("view"),
  });
}
export function useInvalidateMods() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["mods"] });
}

// --------------------------------------------------------------- watchdog
// Not proxied to the VM — its config lives in cloud storage, so this keeps
// working while the server is off.

export function useWatchdog() {
  const s = useSession();
  return useQuery({
    queryKey: ["watchdog"],
    queryFn: () => apiGet<any>("/api/watchdog").then(unwrap),
    enabled: s.authed && s.ready && session.can("view"),
  });
}
export function useSaveWatchdog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { poll_seconds: number; grace_seconds: number }) => apiPost("/api/watchdog", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watchdog"] }),
  });
}

// --------------------------------------------------------------- users & roles

export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: () => apiGet<any>("/api/users").then((r) => (r.ok ? r.data : Promise.reject(r))),
    enabled: session.can("users"),
  });
}
export function useRoles() {
  return useQuery({
    queryKey: ["roles"],
    queryFn: () => apiGet<any>("/api/roles").then((r) => (r.ok ? r.data : Promise.reject(r))),
    enabled: session.can("users"),
  });
}
export function useUpsertUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: any) => apiPost("/api/users", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiDelete(`/api/users/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}
export function useUpsertRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; perms: string[] }) => apiPost("/api/roles", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["roles"] }); qc.invalidateQueries({ queryKey: ["users"] }); },
  });
}
export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiDelete(`/api/roles/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["roles"] }),
  });
}

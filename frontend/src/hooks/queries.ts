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

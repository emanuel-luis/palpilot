// All server-state hooks in one place. Each mirrors an endpoint in §6.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { session, useSession } from "@/stores/session";

// ── overview / power ────────────────────────────────────────────────
export function useOverview() {
  const s = useSession();
  return useQuery({
    queryKey: ["overview"],
    queryFn: async () => {
      const r = await apiGet("/api/overview");
      if (!r.ok && r.status !== 503) throw new Error(r.error || "load_failed");
      return r;
    },
    refetchInterval: s.authed ? 8000 : false,
    enabled: s.authed && s.ready,
  });
}

export function useStartVm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost("/api/vm/start"),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["overview"] }), 3000),
  });
}
export function useStopVm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost("/api/vm/stop"),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["overview"] }), 3000),
  });
}

// ── watchdog ────────────────────────────────────────────────────────
export function useWatchdog() {
  const s = useSession();
  return useQuery({
    queryKey: ["watchdog"],
    queryFn: async () => {
      const r = await apiGet("/api/watchdog");
      if (!r.ok) throw new Error(r.error || "load_failed");
      return r.data as { poll_seconds: number; grace_seconds: number };
    },
    enabled: s.authed && session.can("view"),
  });
}
export function useSaveWatchdog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { poll_seconds: number; grace_seconds: number }) => apiPost("/api/watchdog", v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watchdog"] }),
  });
}

// ── saves ───────────────────────────────────────────────────────────
export function useSaves(enabled = true) {
  return useQuery({
    queryKey: ["saves"],
    queryFn: async () => {
      const r = await apiGet("/api/saves");
      if (!r.ok) throw new Error(r.error || "load_failed");
      return r.data as { active: string; slots: any[] };
    },
    enabled,
  });
}
export function useSaveBackups(guid: string | null) {
  return useQuery({
    queryKey: ["backups", guid],
    queryFn: async () => {
      const r = await apiGet(`/api/saves/${guid}/backups`);
      if (!r.ok) throw new Error(r.error || "load_failed");
      return (r.data as any).backups as any[];
    },
    enabled: !!guid,
  });
}

// ── mods ────────────────────────────────────────────────────────────
export function useMods(enabled = true) {
  return useQuery({
    queryKey: ["mods"],
    queryFn: async () => {
      const r = await apiGet("/api/mods");
      if (!r.ok) throw new Error(r.error || "load_failed");
      return r.data as { dir: string; runtime_mode: "native"|"proton"; capabilities: { pak: boolean; logic: boolean; ue4ss: boolean }; mods: any[] };
    },
    enabled,
  });
}

// ── settings ────────────────────────────────────────────────────────
export function useSettings(enabled = true) {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const [cfg, eff] = await Promise.all([apiGet("/api/config"), apiGet("/api/rest/settings")]);
      if (!cfg.ok || !eff.ok) throw new Error("load_failed");
      return { config: cfg.data as any, effective: eff.data as Record<string, any> };
    },
    enabled,
  });
}

// ── users / roles ───────────────────────────────────────────────────
export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const r = await apiGet("/api/users");
      if (!r.ok) throw new Error(r.error || "load_failed");
      return r.data as { users: any[]; all_perms: string[]; roles: string[] };
    },
    enabled: session.can("users"),
  });
}
export function useRoles() {
  return useQuery({
    queryKey: ["roles"],
    queryFn: async () => {
      const r = await apiGet("/api/roles");
      if (!r.ok) throw new Error(r.error || "load_failed");
      return r.data as { roles: any[]; all_perms: string[] };
    },
    enabled: session.can("users"),
  });
}
export function useUpsertUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (u: { username: string; password?: string; role?: string; perms?: string[] }) => apiPost("/api/users", u),
    onSuccess: (r) => { if (r.ok) qc.setQueryData(["users"], r.data); },
  });
}
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiDelete(`/api/users/${encodeURIComponent(name)}`),
    onSuccess: (r) => { if (r.ok) qc.setQueryData(["users"], r.data); },
  });
}
export function useUpsertRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (r: { name: string; perms: string[] }) => apiPost("/api/roles", r),
    onSuccess: (r) => { if (r.ok) { qc.setQueryData(["roles"], r.data); qc.invalidateQueries({ queryKey: ["users"] }); } },
  });
}
export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiDelete(`/api/roles/${encodeURIComponent(name)}`),
    onSuccess: (r) => { if (r.ok) qc.setQueryData(["roles"], r.data); },
  });
}

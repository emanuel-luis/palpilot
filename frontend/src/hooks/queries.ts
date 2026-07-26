import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { session, useSession } from "@/stores/session";

export function useOverview() {
  const s = useSession();
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => apiGet<any>("/api/overview"),
    enabled: s.authed && s.ready,
    refetchInterval: (q) => {
      const st = (q.state.data as any)?.data?.vm?.status;
      if (st === "PROVISIONING" || st === "STAGING" || st === "STOPPING") return 3000;
      if (st === "RUNNING") return 6000;
      return 10000;
    },
    refetchOnWindowFocus: true,
    staleTime: 1000,
  });
}

export function usePower() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "start" | "stop") => apiPost(`/api/power/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["overview"] }),
  });
}

export function useSaves() {
  return useQuery({
    queryKey: ["saves"],
    queryFn: () => apiGet<any>("/api/saves").then((r) => (r.ok ? r.data : Promise.reject(r))),
    enabled: session.can("view"),
  });
}
export function useActivateSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost(`/api/saves/${encodeURIComponent(id)}/activate`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["saves"] }); qc.invalidateQueries({ queryKey: ["overview"] }); },
  });
}
export function useDeleteSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/api/saves/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saves"] }),
  });
}
export function useRenameSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => apiPost(`/api/saves/${encodeURIComponent(id)}/rename`, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saves"] }),
  });
}
export function useBackupSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost(`/api/saves/${encodeURIComponent(id)}/backup`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saves"] }),
  });
}
export function useRestoreBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, backup }: { id: string; backup: string }) => apiPost(`/api/saves/${encodeURIComponent(id)}/restore`, { backup }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saves"] }),
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<any>("/api/settings").then((r) => (r.ok ? r.data : Promise.reject(r))),
    enabled: session.can("view"),
  });
}
export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { changes?: Record<string, string>; raw?: string }) => apiPost("/api/settings", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
}

export function useMods() {
  return useQuery({
    queryKey: ["mods"],
    queryFn: () => apiGet<any>("/api/mods").then((r) => (r.ok ? r.data : Promise.reject(r))),
    enabled: session.can("view"),
  });
}

export function useWatchdog() {
  return useQuery({
    queryKey: ["watchdog"],
    queryFn: () => apiGet<any>("/api/watchdog").then((r) => (r.ok ? r.data : Promise.reject(r))),
    enabled: session.authed,
  });
}
export function useSaveWatchdog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { poll_seconds: number; grace_seconds: number }) => apiPost("/api/watchdog", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watchdog"] }),
  });
}

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

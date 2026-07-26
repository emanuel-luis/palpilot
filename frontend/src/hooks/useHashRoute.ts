import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
window.addEventListener("hashchange", () => listeners.forEach((l) => l()));

function get(): string {
  const h = window.location.hash.replace(/^#/, "") || "/console";
  return h;
}

export function useHashRoute(): string {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    get,
    get
  );
}

export function navigate(hash: string) {
  window.location.hash = hash.startsWith("/") ? hash : "/" + hash;
}

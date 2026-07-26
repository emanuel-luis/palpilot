import { useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";

export type ToastKind = "ok" | "err" | "warn";
export interface ToastItem { id: number; kind: ToastKind; msg: string; }

let seq = 1;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

function push(kind: ToastKind, msg: string) {
  const id = seq++;
  items = [...items, { id, kind, msg }].slice(-5);
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, kind === "err" ? 6000 : 3200);
}

export const toast = {
  ok:   (m: string) => push("ok", m),
  err:  (m: string) => push("err", m),
  warn: (m: string) => push("warn", m),
};

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => items,
    () => items
  );
  return (
    <div className="toast-stack" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          className={cn("toast", t.kind === "err" && "err", t.kind === "warn" && "warn")}
          role={t.kind === "err" ? "alert" : "status"}
          aria-live={t.kind === "err" ? "assertive" : "polite"}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}

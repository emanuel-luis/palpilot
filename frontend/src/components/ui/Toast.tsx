import { useEffect, useState } from "react";
import { t } from "@/i18n/en";

type Toast = { id: number; kind: "ok" | "err" | "info"; msg: string };

let seq = 1;
const listeners = new Set<(t: Toast[]) => void>();
let items: Toast[] = [];

function emit() { listeners.forEach((l) => l(items)); }

function push(kind: Toast["kind"], msg: string, ms = 4000) {
  const t: Toast = { id: seq++, kind, msg };
  items = [...items, t];
  emit();
  setTimeout(() => {
    items = items.filter((x) => x.id !== t.id);
    emit();
  }, ms);
}

export const toast = {
  ok: (m: string) => push("ok", m),
  err: (m: string) => push("err", m, 6000),
  info: (m: string) => push("info", m),
};

function dismiss(id: number) {
  items = items.filter((x) => x.id !== id);
  emit();
}

export function Toaster() {
  const [list, set] = useState<Toast[]>(items);
  useEffect(() => { listeners.add(set); return () => { listeners.delete(set); }; }, []);
  // Class names must match styles.css: `.toast-stack`, and `.toast.err` /
  // `.toast.warn` for the variants (there is no `.toast-ok` / `.toast-err`).
  return (
    <div className="toast-stack">
      {list.map((x) => (
        <div
          key={x.id}
          className={`toast${x.kind === "err" ? " err" : x.kind === "info" ? " warn" : ""}`}
          // Failures interrupt; successes wait their turn.
          role={x.kind === "err" ? "alert" : "status"}
          aria-live={x.kind === "err" ? "assertive" : "polite"}
        >
          <span>{x.msg}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => dismiss(x.id)} aria-label={t("common.dismiss")}>×</button>
        </div>
      ))}
    </div>
  );
}

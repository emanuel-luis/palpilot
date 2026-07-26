import { useEffect, useState } from "react";

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

export function Toaster() {
  const [list, set] = useState<Toast[]>(items);
  useEffect(() => { listeners.add(set); return () => { listeners.delete(set); }; }, []);
  return (
    <div className="toaster" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "err" ? "alert" : "status"}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// Toast host. Module-level queue so any view or store can notify without
// prop-drilling a handler down the tree.
//
// Accessibility is tone-dependent on purpose: failures interrupt (alert +
// assertive), successes wait their turn (status + polite). Announcing every
// "Saved." assertively would talk over whatever the user is doing.
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";

type Kind = "ok" | "err" | "info";
type Toast = { id: number; kind: Kind; msg: string };

let seq = 1;
const listeners = new Set<(t: Toast[]) => void>();
let items: Toast[] = [];

// Cap the stack: a failing poll could otherwise paper over the whole screen.
const MAX_VISIBLE = 4;

function emit() { listeners.forEach((l) => l(items)); }

function push(kind: Kind, msg: string, ms = 4000) {
  const t: Toast = { id: seq++, kind, msg };
  items = [...items, t].slice(-MAX_VISIBLE);
  emit();
  setTimeout(() => {
    items = items.filter((x) => x.id !== t.id);
    emit();
  }, ms);
}

function dismiss(id: number) {
  items = items.filter((x) => x.id !== id);
  emit();
}

export const toast = {
  ok: (m: string) => push("ok", m),
  err: (m: string) => push("err", m, 7000), // failures need longer to read
  info: (m: string) => push("info", m),
};

const TONE: Record<Kind, { border: string; icon: typeof Info; text: string }> = {
  ok: { border: "border-l-ok", icon: CheckCircle2, text: "text-ok" },
  err: { border: "border-l-danger", icon: AlertTriangle, text: "text-danger" },
  info: { border: "border-l-signal", icon: Info, text: "text-signal" },
};

export function Toaster() {
  const [list, set] = useState<Toast[]>(items);
  useEffect(() => { listeners.add(set); return () => { listeners.delete(set); }; }, []);

  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[100] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-5 sm:max-w-sm">
      {list.map((x) => {
        const tone = TONE[x.kind];
        const Icon = tone.icon;
        return (
          <div
            key={x.id}
            role={x.kind === "err" ? "alert" : "status"}
            aria-live={x.kind === "err" ? "assertive" : "polite"}
            className={cn(
              "pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border border-l-2 border-line/60 bg-surface-2 px-3.5 py-3 shadow-pop",
              "animate-fade-up",
              tone.border,
            )}
          >
            <Icon className={cn("mt-0.5 size-4 shrink-0", tone.text)} aria-hidden />
            <p className="min-w-0 flex-1 text-sm leading-snug">{x.msg}</p>
            <button
              type="button"
              onClick={() => dismiss(x.id)}
              aria-label="Dismiss"
              className="rounded p-0.5 text-faint transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

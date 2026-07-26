import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { t } from "@/i18n/en";
import { cn } from "@/lib/cn";

interface ConfirmSpec {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

let current: null | (ConfirmSpec & { resolve: (v: boolean) => void }) = null;
const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

export function confirm(spec: ConfirmSpec): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    current = { ...spec, resolve };
    emit();
  });
}

export function ConfirmHost() {
  const val = useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => current,
    () => current
  );
  const restoreRef = useRef<HTMLElement | null>(null);
  const [openedAt, setOpenedAt] = useState<number>(0);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (val) {
      restoreRef.current = document.activeElement as HTMLElement | null;
      setOpenedAt(Date.now());
      setTimeout(() => confirmRef.current?.focus(), 20);
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") close(false);
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    } else if (restoreRef.current) {
      restoreRef.current.focus?.();
      restoreRef.current = null;
    }
    return;
  }, [val, openedAt]);

  function close(v: boolean) {
    if (!current) return;
    const c = current;
    current = null;
    emit();
    c.resolve(v);
  }

  if (!val) return null;
  const title = val.title || t("common.confirm");
  const confirmLabel = val.confirmLabel || t("common.confirm");
  const cancelLabel = val.cancelLabel || t("common.cancel");
  return (
    <div className="dialog-scrim" onClick={(e) => e.target === e.currentTarget && close(false)}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h3 id="confirm-title">{title}</h3>
        <div className="dialog-body">{val.message}</div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => close(false)}>{cancelLabel}</button>
          <button
            ref={confirmRef}
            className={cn("btn", val.danger ? "btn-danger" : "btn-primary")}
            onClick={() => close(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

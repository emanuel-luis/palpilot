import { useEffect, useRef, useState } from "react";

type Opts = { title?: string; message: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean };
type Pending = Opts & { resolve: (v: boolean) => void };

let setter: ((p: Pending | null) => void) | null = null;

export function confirm(opts: Opts): Promise<boolean> {
  return new Promise((resolve) => {
    if (!setter) { resolve(window.confirm(opts.message)); return; }
    setter({ ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [p, setP] = useState<Pending | null>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setter = setP; return () => { setter = null; }; }, []);
  useEffect(() => {
    if (!p) return;
    okRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { p!.resolve(false); setP(null); }
      if (e.key === "Enter") { p!.resolve(true); setP(null); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [p]);
  if (!p) return null;
  return (
    <div className="modal-backdrop" onClick={() => { p.resolve(false); setP(null); }}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {p.title && <div className="modal-title">{p.title}</div>}
        <div className="modal-body">{p.message}</div>
        <div className="modal-actions">
          <button className="btn" onClick={() => { p.resolve(false); setP(null); }}>{p.cancelLabel || "Cancel"}</button>
          <button ref={okRef} className={p.danger ? "btn btn-danger" : "btn btn-primary"} onClick={() => { p.resolve(true); setP(null); }}>
            {p.confirmLabel || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

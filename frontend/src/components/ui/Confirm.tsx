// Promise-based dialog layer: confirm() for yes/no, prompt() for "type a name".
// Never window.confirm / window.prompt — those can't be styled, localised or made
// accessible, and a native prompt stacked on a styled confirm is two
// interruptions for one decision.
//
// Requests raised before ConfirmHost has mounted are QUEUED, not dropped and not
// handed to window.confirm: on first paint the host's effect hasn't run yet, and
// silently falling back would pop an unstyled browser dialog.
import { useEffect, useRef, useState } from "react";
import { t } from "@/i18n/en";

type InputSpec = { label: string; defaultValue?: string; placeholder?: string; required?: boolean };

type Opts = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** When set, the dialog renders a text field and prompt() returns its value. */
  input?: InputSpec;
};

type Pending = Opts & { resolve: (v: { ok: boolean; value: string }) => void };

let setter: ((p: Pending | null) => void) | null = null;
const queue: Pending[] = [];

function raise(opts: Opts): Promise<{ ok: boolean; value: string }> {
  return new Promise((resolve) => {
    const pending: Pending = { ...opts, resolve };
    if (setter) setter(pending);
    else queue.push(pending);
  });
}

/** Yes/no. Resolves true only if the user confirmed. */
export async function confirm(opts: Opts): Promise<boolean> {
  return (await raise(opts)).ok;
}

/** Text input. Resolves the trimmed string, or null if cancelled/left empty. */
export async function prompt(opts: Opts & { input: InputSpec }): Promise<string | null> {
  const r = await raise({ ...opts, input: { required: true, ...opts.input } });
  if (!r.ok) return null;
  const v = r.value.trim();
  return v || null;
}

const FOCUSABLE = 'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function ConfirmHost() {
  const [p, setP] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setter = setP;
    if (queue.length) setP(queue.shift()!); // flush anything raised pre-mount
    return () => { setter = null; };
  }, []);

  useEffect(() => { setValue(p?.input?.defaultValue ?? ""); }, [p]);

  function settle(ok: boolean, v: string) {
    const pending = p;
    if (queue.length) setP(queue.shift()!);
    else { setP(null); restoreRef.current?.focus?.(); restoreRef.current = null; }
    pending?.resolve({ ok, value: v });
  }

  useEffect(() => {
    if (!p) return;
    if (!restoreRef.current) restoreRef.current = document.activeElement as HTMLElement;
    (p.input ? inputRef.current : okRef.current)?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); settle(false, ""); return; }
      if (e.key !== "Tab") return;
      // The page behind the dialog is not inert, so keep Tab inside it.
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || !nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p]);

  if (!p) return null;
  const blocked = !!p.input?.required && !value.trim();

  return (
    <div className="dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) settle(false, ""); }}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={p.title || p.message}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {p.title && <h3>{p.title}</h3>}
        <div className="dialog-body">{p.message}</div>
        {p.input && (
          <div className="field" style={{ marginBottom: 20 }}>
            <label className="field-label" htmlFor="dialog-input">{p.input.label}</label>
            <input
              id="dialog-input"
              ref={inputRef}
              className="input"
              value={value}
              placeholder={p.input.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !blocked) { e.preventDefault(); settle(true, value); } }}
            />
          </div>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={() => settle(false, "")}>{p.cancelLabel || t("common.cancel")}</button>
          <button
            ref={okRef}
            className={p.danger ? "btn btn-danger" : "btn btn-primary"}
            disabled={blocked}
            onClick={() => settle(true, value)}
          >
            {p.confirmLabel || t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

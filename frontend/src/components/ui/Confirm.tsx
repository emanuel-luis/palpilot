// Promise-based dialog layer: confirm() for yes/no, prompt() for "type a name".
// Never window.confirm / window.prompt — those can't be styled, localised or made
// accessible, and a native prompt stacked on a styled confirm is two
// interruptions for one decision.
//
// Requests raised before ConfirmHost has mounted are QUEUED, not dropped and not
// handed to window.confirm: on first paint the host's effect hasn't run yet, and
// silently falling back would pop an unstyled browser dialog.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/en";
import { cn } from "@/lib/cn";

type InputSpec = { label: string; defaultValue?: string; placeholder?: string; required?: boolean };

type Opts = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** A second affirmative action, for decisions that genuinely have two ways
   *  forward (e.g. save now vs save and restart). Returned as "alt". */
  altLabel?: string;
  danger?: boolean;
  /** When set, the dialog renders a text field and prompt() returns its value. */
  input?: InputSpec;
};

export type Choice = "cancel" | "confirm" | "alt";

type Pending = Opts & { resolve: (v: { choice: Choice; value: string }) => void };

let setter: ((p: Pending | null) => void) | null = null;
const queue: Pending[] = [];

function raise(opts: Opts): Promise<{ choice: Choice; value: string }> {
  return new Promise((resolve) => {
    const pending: Pending = { ...opts, resolve };
    if (setter) setter(pending);
    else queue.push(pending);
  });
}

/** Yes/no. Resolves true only if the user confirmed. */
export async function confirm(opts: Opts): Promise<boolean> {
  return (await raise(opts)).choice === "confirm";
}

/** Three-way decision: which button was pressed. Use when there are genuinely
 *  two ways forward and forcing one into a checkbox would hide it. */
export async function choose(opts: Opts & { altLabel: string }): Promise<Choice> {
  return (await raise(opts)).choice;
}

/** Text input. Resolves the trimmed string, or null if cancelled/left empty. */
export async function prompt(opts: Opts & { input: InputSpec }): Promise<string | null> {
  const r = await raise({ ...opts, input: { required: true, ...opts.input } });
  if (r.choice !== "confirm") return null;
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

  function settle(choice: Choice, v: string) {
    const pending = p;
    if (queue.length) setP(queue.shift()!);
    else { setP(null); restoreRef.current?.focus?.(); restoreRef.current = null; }
    pending?.resolve({ choice, value: v });
  }

  useEffect(() => {
    if (!p) return;
    if (!restoreRef.current) restoreRef.current = document.activeElement as HTMLElement;
    (p.input ? inputRef.current : okRef.current)?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); settle("cancel", ""); return; }
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
    <div
      className="fixed inset-0 z-200 grid place-items-center bg-black/55 p-4 backdrop-blur-xs"
      onMouseDown={(e) => { if (e.target === e.currentTarget) settle("cancel", ""); }}
    >
      <div
        className="glass w-full max-w-md rounded-xl border border-line/70 p-5 shadow-pop animate-fade-up"
        role="dialog"
        aria-modal="true"
        aria-label={p.title || p.message}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          {p.danger ? (
            <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-danger/12 text-danger">
              <AlertTriangle className="size-4" />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            {p.title ? <h2 className="text-base font-semibold tracking-tight">{p.title}</h2> : null}
            {/* pre-line so callers can use blank lines to separate a consequence
                from the mitigation without needing markup. */}
            <p className={cn("whitespace-pre-line text-sm leading-relaxed text-muted", p.title && "mt-1.5")}>
              {p.message}
            </p>
          </div>
        </div>

        {p.input ? (
          <div className="mt-4">
            <label htmlFor="dialog-input" className="mb-1.5 block text-xs font-medium">
              {p.input.label}
            </label>
            <input
              id="dialog-input"
              ref={inputRef}
              className="h-9 w-full rounded-md border border-line bg-surface-2 px-3 text-sm placeholder:text-faint focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              value={value}
              placeholder={p.input.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !blocked) { e.preventDefault(); settle("confirm", value); } }}
            />
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => settle("cancel", "")}>
            {p.cancelLabel || t("common.cancel")}
          </Button>
          {p.altLabel ? (
            <Button variant="secondary" size="sm" onClick={() => settle("alt", value)}>
              {p.altLabel}
            </Button>
          ) : null}
          <Button
            ref={okRef}
            size="sm"
            variant={p.danger ? "danger" : "primary"}
            disabled={blocked}
            onClick={() => settle("confirm", value)}
          >
            {p.confirmLabel || t("common.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}

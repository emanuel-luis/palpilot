// PalWorldSettings.ini editor, grouped into tabs.
//
// The important product fact: Palworld reads this file once at process start, so
// EVERY change here needs a game restart to take effect. The save dialog says so
// rather than pretending some edits are live, and offers to do the restart safely.
//
// Edits accumulate locally and apply together — the previous editor posted per
// field, which meant a half-applied config if one call failed.
import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Save, Search, Undo2 } from "lucide-react";
import { useSettings, useSaveSettings, useResetSettings, useRestartGame, isOffline } from "@/hooks/queries";
import { SETTINGS_META, easeHint } from "@/data/settingsMeta";
import {
  SPECS, TAB_ORDER, TAB_META, LOAD_BEARING, tabFor, inferKind,
  parseNumeric, formatNumeric, rangeHint, type TabId,
} from "@/data/settingsSpecs";
import { session } from "@/stores/session";
import { apiPost } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/Confirm";
import { PageHeader, OfflineNotice } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tip } from "@/components/ui/tooltip";
import { deCamel } from "@/lib/format";
import { cn } from "@/lib/cn";

function labelFor(key: string) {
  return SETTINGS_META[key]?.label || deCamel(key);
}

type Draft = Record<string, string>;

/** Numeric input that refuses invalid characters as you type instead of
 *  "correcting" the value afterwards, and understands a comma decimal. */
function NumberField({
  id, value, onChange, spec, disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  spec?: { min?: number; max?: number; precision?: number };
  disabled?: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  const parsed = parseNumeric(text);
  const outOfRange =
    parsed != null &&
    ((spec?.min != null && parsed < spec.min) || (spec?.max != null && parsed > spec.max));
  const invalid = text.trim() !== "" && parsed == null;

  return (
    <input
      id={id}
      // `text`, not `number`: a number input silently discards what it cannot
      // parse, so the user never sees why their keystroke vanished.
      type="text"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      aria-invalid={invalid || outOfRange || undefined}
      onChange={(e) => {
        const next = e.target.value;
        // Reject anything that isn't building toward a number.
        if (next !== "" && !/^-?\d*[.,]?\d*$/.test(next)) return;
        setText(next);
        const n = parseNumeric(next);
        if (n != null) onChange(formatNumeric(n, spec?.precision ?? 6));
      }}
      onBlur={() => {
        const n = parseNumeric(text);
        if (n == null) { setText(value); return; }
        // Clamp only on blur, so typing "0.0001" isn't fought mid-keystroke.
        const clamped = Math.min(spec?.max ?? Infinity, Math.max(spec?.min ?? -Infinity, n));
        const out = formatNumeric(clamped, spec?.precision ?? 6);
        setText(out);
        onChange(out);
      }}
      className={cn(
        "num h-9 w-full rounded-md border bg-surface-2 px-3 font-mono text-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        invalid || outOfRange ? "border-danger" : "border-line",
      )}
    />
  );
}

function Field({
  fieldKey, value, original, onChange, canWrite,
}: {
  fieldKey: string;
  value: string;
  original: string;
  onChange: (v: string) => void;
  canWrite: boolean;
}) {
  const spec = SPECS[fieldKey];
  const kind = inferKind(fieldKey, original || value);
  const meta = SETTINGS_META[fieldKey];
  const dirty = value !== original;
  const id = `set-${fieldKey}`;
  const ease = meta ? easeHint(meta.ease) : "";
  const range = rangeHint(spec);
  const hasDefault = spec?.default != null;
  const isDefault = hasDefault && value === spec!.default;

  return (
    <div
      className={cn(
        "rounded-lg border p-4 transition-colors duration-fast",
        dirty ? "border-signal/50 bg-signal/[0.04]" : "border-line/60 bg-surface",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-medium">
            {labelFor(fieldKey)}
          </label>
          <div className="mt-0.5 font-mono text-2xs text-faint">{fieldKey}</div>
        </div>
        <div className="flex items-center gap-1.5">
          {dirty ? <Badge tone="info">modified</Badge> : null}
          {LOAD_BEARING.has(fieldKey) ? (
            <Tip label="This console talks to the game through this setting. Changing it can cut the connection until the next world switch.">
              <Badge tone="warn">load-bearing</Badge>
            </Tip>
          ) : null}
        </div>
      </div>

      <div className="mt-3">
        {kind === "bool" ? (
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              id={id}
              type="checkbox"
              className="size-4 accent-[hsl(var(--signal))]"
              checked={/^true$/i.test(value)}
              disabled={!canWrite}
              onChange={(e) => onChange(e.target.checked ? "True" : "False")}
            />
            <span className="text-sm text-muted">{/^true$/i.test(value) ? "On" : "Off"}</span>
          </label>
        ) : kind === "enum" ? (
          <select
            id={id}
            className="h-9 w-full rounded-md border border-line bg-surface-2 px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={value}
            disabled={!canWrite}
            onChange={(e) => onChange(e.target.value)}
          >
            {(spec?.options ?? [value]).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : kind === "int" || kind === "float" ? (
          <NumberField
            id={id}
            value={value}
            onChange={onChange}
            disabled={!canWrite}
            spec={{ min: spec?.min, max: spec?.max, precision: spec?.precision ?? (kind === "int" ? 0 : 6) }}
          />
        ) : (
          <input
            id={id}
            type={kind === "secret" ? "password" : "text"}
            autoComplete={kind === "secret" ? "new-password" : undefined}
            className="h-9 w-full rounded-md border border-line bg-surface-2 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={value}
            disabled={!canWrite}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>

      {meta?.desc ? <p className="mt-2 text-xs leading-relaxed text-muted">{meta.desc}</p> : null}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-faint">
        {range ? <span>Range {range}</span> : null}
        {hasDefault ? (
          <span className="num font-mono">
            Default {spec!.default === "" ? "(empty)" : spec!.default}
          </span>
        ) : null}
        {ease ? <span>{ease}</span> : null}

        <div className="ml-auto flex items-center gap-1">
          {dirty ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-2xs"
              onClick={() => onChange(original)}
            >
              <Undo2 className="!size-3" /> Undo
            </Button>
          ) : null}
          {canWrite ? (
            hasDefault ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-2xs"
                disabled={isDefault}
                onClick={() => onChange(spec!.default!)}
              >
                <RotateCcw className="!size-3" /> Default
              </Button>
            ) : (
              <Tip label="This build doesn't know this setting's shipped default, so it won't guess one.">
                <span className="cursor-help px-2 text-2xs text-faint/70">no known default</span>
              </Tip>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const q = useSettings();
  const save = useSaveSettings();
  const reset = useResetSettings();
  const restart = useRestartGame();
  const canWrite = session.can("settings");

  const [draft, setDraft] = useState<Draft>({});
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<TabId>("general");

  const loaded = q.data && !isOffline(q.data) ? (q.data as any) : null;
  const options: Draft = loaded?.options ?? {};

  useEffect(() => { if (loaded) setDraft({ ...loaded.options }); }, [loaded]);

  const changed = useMemo(() => {
    const out: Draft = {};
    for (const k of Object.keys(draft)) {
      if ((draft[k] ?? "") !== (options[k] ?? "")) out[k] = draft[k];
    }
    return out;
  }, [draft, options]);
  const changedKeys = Object.keys(changed);

  const byTab = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const groups = {} as Record<TabId, string[]>;
    for (const id of TAB_ORDER) groups[id] = [];
    for (const key of Object.keys(options)) {
      if (needle) {
        const meta = SETTINGS_META[key];
        const hit =
          key.toLowerCase().includes(needle) ||
          labelFor(key).toLowerCase().includes(needle) ||
          (meta?.desc ?? "").toLowerCase().includes(needle);
        if (!hit) continue;
      }
      groups[tabFor(key)].push(key);
    }
    for (const id of TAB_ORDER) groups[id].sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
    return groups;
  }, [options, search]);

  // When a search empties the current tab, move to one that has results rather
  // than showing a blank panel.
  useEffect(() => {
    if (!search.trim()) return;
    if (byTab[tab]?.length) return;
    const first = TAB_ORDER.find((id) => byTab[id].length);
    if (first) setTab(first);
  }, [search, byTab, tab]);

  if (isOffline(q.data)) {
    return (
      <>
        <PageHeader title="Server settings" />
        <OfflineNotice action="edit settings" />
      </>
    );
  }
  if (q.isLoading && !loaded) {
    return (
      <>
        <PageHeader title="Server settings" />
        <Skeleton className="h-10" />
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}
        </div>
      </>
    );
  }
  if (q.error || !loaded) {
    return (
      <>
        <PageHeader title="Server settings" />
        <Card>
          <CardContent className="space-y-3 text-center">
            <p className="text-sm text-muted">Couldn't load the settings.</p>
            <Button variant="secondary" size="sm" onClick={() => q.refetch()}>Try again</Button>
          </CardContent>
        </Card>
      </>
    );
  }

  async function applyChanges() {
    if (!changedKeys.length) { toast.info("Nothing changed."); return; }

    // Every key in this file is read at process start, so a restart is always
    // required for the change to mean anything. Say that, and offer to do it well.
    const answer = await confirm({
      title: `Apply ${changedKeys.length} change${changedKeys.length === 1 ? "" : "s"}?`,
      message:
        "Palworld reads its settings once when the server starts, so these take effect on the next restart.\n\n" +
        "A safe restart warns players, saves the world, waits, then restarts.",
      confirmLabel: "Save and safe restart",
      cancelLabel: "Cancel",
    });
    if (!answer) return;

    const r = await save.mutateAsync({ options: changed, restart: false });
    if (!r.ok) { toast.err(r.error || "Couldn't save the settings."); return; }
    toast.ok(`${changedKeys.length} setting${changedKeys.length === 1 ? "" : "s"} saved.`);

    // Announce → save → grace → restart. Best effort: a missing `commands`
    // permission shouldn't block the restart the user just asked for.
    if (session.can("commands")) {
      await apiPost("/api/rest/announce", { message: "Applying new server settings — restarting in 15 seconds." });
      await apiPost("/api/rest/save", {});
      await new Promise((res) => setTimeout(res, 15_000));
    }
    const rr = await restart.mutateAsync();
    if (!rr.ok) toast.err(rr.error || "Saved, but the restart failed. Restart from the Console.");
    else toast.ok("Restarted with the new settings.");
  }

  async function resetAll() {
    const ok = await confirm({
      title: "Reset every setting?",
      message:
        "This replaces the active save's settings with Palworld's defaults. " +
        "Server access (REST and admin) is preserved so this console keeps working.",
      confirmLabel: "Reset to defaults",
      danger: true,
    });
    if (!ok) return;
    const r = await reset.mutateAsync({ restart: false });
    if (!r.ok) { toast.err(r.error || "Couldn't reset."); return; }
    toast.ok("Settings reset to defaults. Restart to apply.");
    // /api/config/reset can answer ok:true WITH a non-null error — that means the
    // reset landed but its restart failed. Report both truthfully.
    const restartErr = (r.data as any)?.error;
    if (restartErr) toast.err(String(restartErr));
  }

  const applying = save.isPending || restart.isPending;

  return (
    <>
      <PageHeader
        title="Server settings"
        description="Applies to the active save — each save keeps its own copy. Change as many fields as you like, then apply them together."
        actions={
          canWrite ? (
            <>
              <Button variant="ghost" size="sm" onClick={resetAll} disabled={reset.isPending}>
                <RotateCcw /> Reset all
              </Button>
              <Button
                variant={changedKeys.length ? "primary" : "secondary"}
                size="sm"
                loading={applying}
                disabled={!changedKeys.length}
                onClick={applyChanges}
              >
                <Save /> Apply{changedKeys.length ? ` ${changedKeys.length}` : ""}
              </Button>
            </>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search all settings"
            aria-label="Search all settings"
            className="h-9 w-64 rounded-md border border-line bg-surface-2 pl-8 pr-3 text-sm placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        {changedKeys.length ? (
          <>
            <Badge tone="info">{changedKeys.length} unsaved</Badge>
            <Button variant="ghost" size="sm" onClick={() => setDraft({ ...options })}>
              <Undo2 /> Discard changes
            </Button>
          </>
        ) : null}
        <span className="num ml-auto font-mono text-2xs text-faint">
          {Object.keys(options).length} settings
        </span>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList>
          {TAB_ORDER.map((id) => {
            const count = byTab[id].length;
            const dirtyHere = changedKeys.filter((k) => tabFor(k) === id).length;
            return (
              <TabsTrigger key={id} value={id} disabled={count === 0}>
                {TAB_META[id].label}
                {dirtyHere ? (
                  <span className="ml-1.5 inline-block size-1.5 rounded-full bg-signal align-middle" aria-label={`${dirtyHere} modified`} />
                ) : count ? (
                  <span className="num ml-1.5 font-mono text-2xs text-faint">{count}</span>
                ) : null}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {TAB_ORDER.map((id) => (
          <TabsContent key={id} value={id}>
            <p className="mb-4 max-w-2xl text-xs text-muted">{TAB_META[id].description}</p>
            {byTab[id].length ? (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {byTab[id].map((key) => (
                  <Field
                    key={key}
                    fieldKey={key}
                    value={draft[key] ?? ""}
                    original={options[key] ?? ""}
                    canWrite={canWrite}
                    onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-faint">Nothing here matches that search.</p>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}

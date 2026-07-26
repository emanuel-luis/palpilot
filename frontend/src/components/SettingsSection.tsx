// PalWorldSettings.ini editor. Values come from GET /api/config merged with the
// game's effective settings; writes go to POST /api/config?restart= as
// { options: <only the changed keys> } or { raw }.
//
// The control type is derived from the VALUE at runtime — the metadata records
// only carry { label, desc, ease }.
import { useEffect, useMemo, useState } from "react";
import { useSettings, useSaveSettings, useResetSettings, isOffline } from "@/hooks/queries";
import {
  SETTINGS_META, SECTION_ORDER, SECTION_LABELS, KEY_TO_SECTION,
  SELECT_OPTIONS, SECRET_KEYS, easeHint,
} from "@/data/settingsMeta";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm } from "./ui/Confirm";
import { t } from "@/i18n/en";
import { deCamel } from "@/lib/format";

const BOOL_RE = /^(true|false)$/i;
const NUM_RE = /^-?\d+(\.\d+)?$/;

type Kind = "select" | "bool" | "number" | "secret" | "text";

function kindOf(key: string, value: string): Kind {
  if (SELECT_OPTIONS[key]) return "select";
  if (SECRET_KEYS.has(key)) return "secret";
  if (BOOL_RE.test(value)) return "bool";
  if (NUM_RE.test(value)) return "number";
  return "text";
}

function labelOf(key: string): string {
  return SETTINGS_META[key]?.label || deCamel(key);
}

export function SettingsSection() {
  const q = useSettings();
  const save = useSaveSettings();
  const reset = useResetSettings();
  const canWrite = session.can("settings");

  const [values, setValues] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState("");
  const [rawMode, setRawMode] = useState(false);
  const [search, setSearch] = useState("");
  const [restartAfter, setRestartAfter] = useState(false);

  const loaded: { options: Record<string, string>; raw: string; path: string } | null =
    q.data && !isOffline(q.data) ? (q.data as any) : null;

  useEffect(() => {
    if (loaded) { setValues({ ...loaded.options }); setRaw(loaded.raw); }
  }, [loaded]);

  const changed = useMemo(() => {
    const orig = loaded?.options || {};
    const out: Record<string, string> = {};
    for (const k of Object.keys(values)) {
      if ((values[k] ?? "") !== (orig[k] ?? "")) out[k] = values[k];
    }
    return out;
  }, [values, loaded]);

  const changedCount = Object.keys(changed).length;

  const groups = useMemo(() => {
    const s = search.trim().toLowerCase();
    const keys = Object.keys(loaded?.options || {}).filter((k) => {
      if (!s) return true;
      const meta = SETTINGS_META[k];
      return k.toLowerCase().includes(s)
        || labelOf(k).toLowerCase().includes(s)
        || (meta?.desc || "").toLowerCase().includes(s);
    });
    return SECTION_ORDER.map((id) => ({
      id,
      title: SECTION_LABELS[id],
      keys: keys.filter((k) => (KEY_TO_SECTION[k] || "other") === id).sort((a, b) => labelOf(a).localeCompare(labelOf(b))),
    })).filter((g) => g.keys.length > 0);
  }, [loaded, search]);

  if (q.isLoading) return <div className="field-hint">{t("common.loading")}</div>;
  if (isOffline(q.data)) return <div className="empty">{t("console.startFirst", { action: t("console.startFirstAction.settings") })}</div>;
  if (q.error || !loaded) {
    return (
      <div className="empty">
        {t("settings.loadFailed")}{" "}
        <button className="btn btn-sm" onClick={() => q.refetch()}>{t("common.retry")}</button>
      </div>
    );
  }

  async function onSave() {
    if (changedCount === 0) { toast.info(t("settings.nothingChanged")); return; }
    const ok = await confirm({
      message: t("settings.confirmSave", { count: changedCount }),
      confirmLabel: t("settings.save"),
      danger: restartAfter,
    });
    if (!ok) return;
    const r = await save.mutateAsync({ options: changed, restart: restartAfter });
    if (!r.ok) toast.err(r.error || t("settings.saveFailed"));
    else toast.ok(t("settings.saved", {
      count: changedCount,
      restart: restartAfter ? t("settings.savedRestart") : "",
    }));
  }

  async function onSaveRaw() {
    const ok = await confirm({
      message: t("settings.confirmRaw"),
      confirmLabel: t("settings.saveRaw"),
      danger: true,
    });
    if (!ok) return;
    const r = await save.mutateAsync({ raw, restart: restartAfter });
    if (!r.ok) toast.err(r.error || t("settings.saveFailed"));
    else toast.ok(t("settings.savedGeneric"));
  }

  async function onReset() {
    const ok = await confirm({
      title: t("settings.resetConfirmTitle"),
      message: t("settings.resetConfirm"),
      confirmLabel: t("settings.reset"),
      danger: true,
    });
    if (!ok) return;
    const r = await reset.mutateAsync({ restart: restartAfter });
    if (!r.ok) { toast.err(r.error || t("settings.resetFailed")); return; }
    // /api/config/reset can answer ok:true WITH a non-null error — that means the
    // reset landed but the restart failed, so report both truthfully.
    toast.ok(t("settings.resetDone"));
    const restartErr = (r.data as any)?.error;
    if (restartErr) toast.err(String(restartErr));
  }

  const options = loaded.options;

  function field(key: string) {
    const value = values[key] ?? "";
    const orig = options[key] ?? "";
    const dirty = value !== orig;
    const meta = SETTINGS_META[key];
    const kind = kindOf(key, orig || value);
    const id = `s-${key}`;
    const set = (v: string) => setValues((prev) => ({ ...prev, [key]: v }));
    const hint = meta ? easeHint(meta.ease) : "";

    return (
      <div key={key} className={dirty ? "field field-dirty" : "field"}>
        <label className="field-label" htmlFor={id}>
          {labelOf(key)}
          <span className="mono field-hint" style={{ marginLeft: 6, fontSize: 11 }}>{key}</span>
        </label>

        {kind === "select" ? (
          <select id={id} className="select" value={value} onChange={(e) => set(e.target.value)} disabled={!canWrite}>
            {SELECT_OPTIONS[key].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : kind === "bool" ? (
          <label className="switch">
            <input
              id={id}
              type="checkbox"
              checked={/^true$/i.test(value)}
              onChange={(e) => set(e.target.checked ? "True" : "False")}
              disabled={!canWrite}
            />
            <span className="knob" />
          </label>
        ) : kind === "number" ? (
          <input
            id={id} className="input mono" type="number" step="any" value={value}
            onChange={(e) => set(e.target.value)} disabled={!canWrite}
          />
        ) : (
          <input
            id={id} className="input" type={kind === "secret" ? "password" : "text"} value={value}
            autoComplete={kind === "secret" ? "new-password" : undefined}
            onChange={(e) => set(e.target.value)} disabled={!canWrite}
          />
        )}

        {meta?.desc && <div className="field-hint">{meta.desc}</div>}
        {hint && <div className="field-hint">{hint}</div>}
        {dirty && (
          <div className="field-hint mono" style={{ fontSize: 11, color: "var(--moss)" }}>
            {orig || "∅"} → {value || "∅"}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="row">
          <input
            className="input"
            placeholder={t("settings.filterPlaceholder")}
            aria-label={t("settings.filterPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <label className="row-tight" style={{ alignItems: "center" }}>
            <input type="checkbox" checked={rawMode} onChange={(e) => setRawMode(e.target.checked)} />
            <span>{t("settings.rawToggle")}</span>
          </label>
        </div>
        {canWrite && (
          <div className="row-tight">
            <label className="row-tight" style={{ alignItems: "center" }}>
              <input type="checkbox" checked={restartAfter} onChange={(e) => setRestartAfter(e.target.checked)} />
              <span>{t("settings.restartAfter")}</span>
            </label>
            {!rawMode && changedCount > 0 && (
              <span className="field-hint mono">{t("settings.dirty", { count: changedCount })}</span>
            )}
            <button className="btn btn-danger btn-sm" onClick={onReset} disabled={reset.isPending}>
              {t("settings.reset")}
            </button>
            <button className="btn btn-sm" onClick={() => q.refetch()} disabled={q.isFetching}>
              {t("common.reload")}
            </button>
            {rawMode ? (
              <button className="btn btn-primary" onClick={onSaveRaw} disabled={save.isPending}>
                {t("settings.saveRaw")}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={onSave} disabled={save.isPending || changedCount === 0}>
                {t("settings.save")}
              </button>
            )}
          </div>
        )}
      </div>

      {rawMode ? (
        <>
          <textarea
            className="textarea mono"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={22}
            spellCheck={false}
            disabled={!canWrite}
            aria-label={t("settings.raw")}
          />
          <div className="field-hint mono">{loaded.path}</div>
        </>
      ) : (
        <div className="stack-lg">
          {groups.map((g) => (
            <div key={g.id} className="panel">
              <div className="panel-header">
                <div className="panel-title">{g.title}</div>
                <span className="field-hint mono">{g.keys.length}</span>
              </div>
              <div className="panel-body">
                <div className="grid-settings">{g.keys.map(field)}</div>
              </div>
            </div>
          ))}
          {groups.length === 0 && <div className="empty">{t("common.empty")}</div>}
        </div>
      )}
    </div>
  );
}

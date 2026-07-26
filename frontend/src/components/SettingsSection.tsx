import { useMemo, useState } from "react";
import { useSettings } from "@/hooks/queries";
import { apiPost } from "@/lib/api";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm } from "./ui/Confirm";
import { t } from "@/i18n/en";
import { KEY_TO_SECTION, SECRET_KEYS, SECTION_LABELS, SECTION_ORDER, SELECT_OPTIONS, SETTINGS_META, easeHint } from "@/data/settingsMeta";
import { deCamel } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";

function detectType(key: string, val: any): "bool" | "num" | "select" | "secret" | "text" {
  if (SECRET_KEYS.has(key)) return "secret";
  if (SELECT_OPTIONS[key]) return "select";
  if (typeof val === "boolean") return "bool";
  if (typeof val === "number") return "num";
  if (typeof val === "string") {
    if (val === "True" || val === "False") return "bool";
    if (/^-?\d+(\.\d+)?$/.test(val)) return "num";
  }
  return "text";
}

function normalize(val: any, type: string): string {
  if (val == null) return "";
  if (type === "bool") {
    if (val === true || val === "True") return "True";
    if (val === false || val === "False") return "False";
  }
  return String(val);
}

export function SettingsSection() {
  const q = useSettings();
  const qc = useQueryClient();
  const canWrite = session.can("settings");
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [restart, setRestart] = useState(false);
  const [filter, setFilter] = useState("");
  const [rawOpen, setRawOpen] = useState(false);
  const [rawText, setRawText] = useState("");

  if (q.isLoading) return <div className="field-hint">{t("common.loading")}</div>;
  if (q.error) return <div className="empty">{t("settings.loadFailed")} <button className="btn btn-sm" onClick={() => q.refetch()}>{t("common.retry")}</button></div>;
  const { config, effective } = q.data!;

  // merge: use REST 'effective' for values; fall back to config.options for secret keys the REST omits
  const merged: Record<string, any> = { ...(config.options || {}), ...(effective || {}) };
  Object.keys(merged).forEach((k) => { if (Array.isArray(merged[k])) delete merged[k]; });

  const sections = useMemo(() => {
    const map: Record<string, string[]> = {};
    SECTION_ORDER.forEach((s) => (map[s] = []));
    Object.keys(merged).sort().forEach((k) => {
      const sec = KEY_TO_SECTION[k] || "other";
      (map[sec] = map[sec] || []).push(k);
    });
    if (filter) {
      const f = filter.toLowerCase();
      Object.keys(map).forEach((s) => {
        map[s] = map[s].filter((k) => {
          const meta = SETTINGS_META[k];
          const label = (meta?.label || deCamel(k)).toLowerCase();
          return k.toLowerCase().includes(f) || label.includes(f);
        });
      });
    }
    return map;
  }, [merged, filter]);

  function set(key: string, val: string) {
    setDirty((d) => ({ ...d, [key]: val }));
  }
  function current(key: string): string {
    const type = detectType(key, merged[key]);
    return dirty[key] !== undefined ? dirty[key] : normalize(merged[key], type);
  }
  const changedCount = Object.keys(dirty).filter((k) => normalize(merged[k], detectType(k, merged[k])) !== dirty[k]).length;

  async function save() {
    const options: Record<string, string> = {};
    Object.entries(dirty).forEach(([k, v]) => {
      const cur = normalize(merged[k], detectType(k, merged[k]));
      if (v !== cur) options[k] = v;
    });
    if (Object.keys(options).length === 0) { toast.warn(t("settings.nothingChanged")); return; }
    const r = await apiPost("/api/config", { options }, { query: `restart=${restart}` });
    if (!r.ok) { toast.err(r.error || t("settings.saveFailed")); return; }
    toast.ok(t("settings.saved", { count: Object.keys(options).length, restart: restart ? t("settings.savedRestart") : "" }));
    setDirty({});
    qc.invalidateQueries({ queryKey: ["settings"] });
  }
  async function reset() {
    const ok = await confirm({ title: t("settings.resetConfirmTitle"), message: t("settings.resetConfirm"), confirmLabel: t("settings.reset"), danger: true });
    if (!ok) return;
    const r = await apiPost("/api/config/reset", {}, { query: `restart=${restart}` });
    if (!r.ok && (r.data as any).reset !== true) { toast.err(r.error || t("settings.resetFailed")); return; }
    toast.ok(t("settings.resetDone")); setDirty({});
    qc.invalidateQueries({ queryKey: ["settings"] });
  }
  async function saveRaw() {
    const r = await apiPost("/api/config", { raw: rawText }, { query: `restart=${restart}` });
    if (!r.ok) toast.err(r.error || t("settings.saveFailed"));
    else { toast.ok(t("settings.savedGeneric")); qc.invalidateQueries({ queryKey: ["settings"] }); }
  }

  return (
    <div className="stack-lg">
      <div className="row">
        <input className="input" style={{ maxWidth: 300 }} placeholder={t("settings.filterPlaceholder")} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="spacer" />
        {canWrite && (
          <>
            <label className="row-tight" style={{ gap: 8 }}>
              <span className="switch"><input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} /><span className="knob" /></span>
              <span className="field-hint">{t("settings.restartAfter")}</span>
            </label>
            <button className="btn" onClick={reset}>{t("settings.reset")}</button>
            <button className="btn btn-primary" onClick={save} disabled={changedCount === 0}>
              {t("settings.save")} {changedCount ? `(${changedCount})` : ""}
            </button>
          </>
        )}
      </div>

      {SECTION_ORDER.map((sec) => {
        const keys = sections[sec];
        if (!keys || keys.length === 0) return null;
        return (
          <div key={sec} className="panel">
            <div className="panel-header"><div className="panel-title">{SECTION_LABELS[sec]}</div></div>
            <div className="panel-body">
              {keys.map((k) => (
                <SettingField key={k} k={k} value={current(k)} setValue={(v) => set(k, v)} disabled={!canWrite} original={merged[k]} />
              ))}
            </div>
          </div>
        );
      })}

      <div className="panel">
        <div className="panel-header" onClick={() => { setRawOpen((v) => !v); if (!rawOpen) setRawText(config.raw || ""); }} style={{ cursor: "pointer" }}>
          <div className="panel-title">{t("settings.raw")}</div>
          <span className="chev" />
        </div>
        {rawOpen && (
          <div className="panel-body stack">
            <div className="field-hint mono" style={{ fontSize: 11 }}>{config.path}</div>
            <textarea className="textarea mono" value={rawText} onChange={(e) => setRawText(e.target.value)} style={{ minHeight: 240 }} />
            {canWrite && <button className="btn btn-primary" style={{ alignSelf: "flex-start" }} onClick={saveRaw}>{t("settings.saveRaw")}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function SettingField({ k, value, setValue, disabled, original }: { k: string; value: string; setValue: (v: string) => void; disabled: boolean; original: any }) {
  const meta = SETTINGS_META[k];
  const label = meta?.label || deCamel(k);
  const desc = meta?.desc;
  const hint = meta ? easeHint(meta.ease) : "";
  const type = detectType(k, original);

  return (
    <div className="setting">
      <div className="setting-name">
        <div className="setting-label">{label}</div>
        <div className="setting-key mono">{k}</div>
        {desc && <div className="setting-desc">{desc}</div>}
        {hint && <span className="setting-ease">{hint}</span>}
      </div>
      <div>
        {type === "bool" ? (
          <label className="row-tight" style={{ gap: 8 }}>
            <span className="switch"><input type="checkbox" checked={value === "True"} disabled={disabled} onChange={(e) => setValue(e.target.checked ? "True" : "False")} /><span className="knob" /></span>
            <span className="mono field-hint">{value}</span>
          </label>
        ) : type === "select" ? (
          <select className="select" value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled}>
            {SELECT_OPTIONS[k].map((o) => <option key={o}>{o}</option>)}
          </select>
        ) : type === "num" ? (
          <input className="input mono" value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled} />
        ) : type === "secret" ? (
          <input className="input mono" type="password" value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled} />
        ) : (
          <input className="input" value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled} />
        )}
      </div>
    </div>
  );
}

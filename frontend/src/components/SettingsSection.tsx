import { useEffect, useMemo, useState } from "react";
import { useSettings, useSaveSettings } from "@/hooks/queries";
import { settingsMeta, settingsGroups } from "@/data/settingsMeta";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm } from "./ui/Confirm";
import { t } from "@/i18n/en";

export function SettingsSection() {
  const q = useSettings();
  const save = useSaveSettings();
  const canWrite = session.can("settings");
  const [values, setValues] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState("");
  const [rawMode, setRawMode] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (q.data) { setValues({ ...(q.data.values || {}) }); setRaw(q.data.raw || ""); }
  }, [q.data]);

  const changed = useMemo(() => {
    if (!q.data) return {} as Record<string, string>;
    const orig = q.data.values || {};
    const out: Record<string, string> = {};
    for (const k of Object.keys(values)) {
      if ((values[k] ?? "") !== (orig[k] ?? "")) out[k] = values[k];
    }
    return out;
  }, [values, q.data]);

  if (q.isLoading) return <div className="field-hint">{t("common.loading")}</div>;
  if (q.error) return <div className="empty">{t("settings.loadFailed")} <button className="btn btn-sm" onClick={() => q.refetch()}>{t("common.retry")}</button></div>;
  const data = q.data!;

  async function onSave() {
    const changes = Object.keys(changed);
    if (changes.length === 0) { toast.info(t("settings.noChanges")); return; }
    const ok = await confirm({
      message: t("settings.confirmSave", { count: changes.length }),
      confirmLabel: t("settings.save"), danger: true,
    });
    if (!ok) return;
    const r = await save.mutateAsync({ changes });
    if (!r.ok) toast.err(r.error || t("settings.saveFailed"));
    else toast.ok(t("settings.saved"));
  }
  async function onSaveRaw() {
    const ok = await confirm({ message: t("settings.confirmRaw"), confirmLabel: t("settings.save"), danger: true });
    if (!ok) return;
    const r = await save.mutateAsync({ raw });
    if (!r.ok) toast.err(r.error || t("settings.saveFailed"));
    else toast.ok(t("settings.saved"));
  }

  const changedCount = Object.keys(changed).length;

  return (
    <div className="stack-lg">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="row">
          <input className="input" placeholder={t("settings.search")} value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 260 }} />
          <label className="row-tight" style={{ alignItems: "center" }}>
            <input type="checkbox" checked={rawMode} onChange={(e) => setRawMode(e.target.checked)} />
            <span>{t("settings.rawToggle")}</span>
          </label>
        </div>
        {canWrite && (
          <div className="row-tight">
            {!rawMode && <span className="field-hint mono">{t("settings.dirty", { count: changedCount })}</span>}
            {!rawMode && <button className="btn btn-primary" onClick={onSave} disabled={save.isPending || changedCount === 0}>{t("settings.save")}</button>}
            {rawMode && <button className="btn btn-primary" onClick={onSaveRaw} disabled={save.isPending}>{t("settings.save")}</button>}
          </div>
        )}
      </div>

      {rawMode ? (
        <textarea className="raw-ini mono" value={raw} onChange={(e) => setRaw(e.target.value)} rows={22} disabled={!canWrite} />
      ) : (
        <div className="stack-lg">
          {settingsGroups.map((g) => {
            const items = g.keys.filter((k) => {
              const meta = settingsMeta[k];
              if (!meta) return false;
              if (!search) return true;
              const s = search.toLowerCase();
              return k.toLowerCase().includes(s) || meta.label.toLowerCase().includes(s) || (meta.description || "").toLowerCase().includes(s);
            });
            if (items.length === 0) return null;
            return (
              <div key={g.id} className="panel">
                <div className="panel-header"><div className="panel-title">{g.title}</div></div>
                <div className="panel-body">
                  <div className="grid-settings">
                    {items.map((k) => {
                      const meta = settingsMeta[k]!;
                      const value = values[k] ?? "";
                      const orig = data.values?.[k] ?? "";
                      const dirty = value !== orig;
                      return (
                        <div key={k} className={dirty ? "field field-dirty" : "field"}>
                          <label className="field-label" htmlFor={`s-${k}`}>
                            {meta.label} <span className="mono field-hint" style={{ marginLeft: 6, fontSize: 11 }}>{k}</span>
                          </label>
                          {meta.type === "bool" ? (
                            <select id={`s-${k}`} className="select" value={value} onChange={(e) => setValues({ ...values, [k]: e.target.value })} disabled={!canWrite}>
                              <option value="True">True</option>
                              <option value="False">False</option>
                            </select>
                          ) : meta.type === "enum" ? (
                            <select id={`s-${k}`} className="select" value={value} onChange={(e) => setValues({ ...values, [k]: e.target.value })} disabled={!canWrite}>
                              {meta.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : meta.type === "number" ? (
                            <input id={`s-${k}`} className="input mono" type="number" step={meta.step || 1} min={meta.min} max={meta.max}
                              value={value} onChange={(e) => setValues({ ...values, [k]: e.target.value })} disabled={!canWrite} />
                          ) : (
                            <input id={`s-${k}`} className="input" type="text" value={value} onChange={(e) => setValues({ ...values, [k]: e.target.value })} disabled={!canWrite} />
                          )}
                          {meta.description && <div className="field-hint">{meta.description}</div>}
                          {dirty && <div className="field-hint mono" style={{ fontSize: 11, color: "var(--accent)" }}>{orig || "∅"} → {value || "∅"}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

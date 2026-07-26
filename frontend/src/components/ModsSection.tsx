import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMods, isOffline } from "@/hooks/queries";
import { apiPost, apiDelete, apiUpload } from "@/lib/api";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm } from "./ui/Confirm";
import { t } from "@/i18n/en";
import { formatBytes, formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";

const MOD_MAX = 32 * 1024 * 1024;

export function ModsSection() {
  const q = useMods();
  const qc = useQueryClient();
  const canWrite = session.can("mods");
  const canRestart = session.can("settings");
  const [url, setUrl] = useState("");
  const [urlName, setUrlName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ue4ssUrl, setUe4ssUrl] = useState("");
  const [pendingChanges, setPendingChanges] = useState(false);

  if (q.isLoading) return <div className="field-hint">{t("common.loading")}</div>;
  if (isOffline(q.data)) {
    return <div className="empty">{t("console.startFirst", { action: t("console.startFirstAction.mods") })}</div>;
  }
  if (q.error || !q.data) {
    return (
      <div className="empty">
        {t("mods.loadFailed")}{" "}
        <button className="btn btn-sm" onClick={() => q.refetch()}>{t("common.retry")}</button>
      </div>
    );
  }
  const data: any = q.data;
  const mods: any[] = data.mods || [];
  // capabilities.ue4ss is false unless the VM runs the Proton runtime; pre-empt the
  // server's 409 instead of letting the user discover it the hard way.
  const ue4ssAvailable = !!data.capabilities?.ue4ss;

  async function installUrl() {
    if (!url.trim()) { toast.err(t("mods.urlRequired")); return; }
    setBusy("url");
    const r = await apiPost("/api/mods/url", { url: url.trim(), name: urlName.trim() || undefined });
    setBusy(null);
    if (!r.ok) toast.err(r.error || t("mods.installFailed"));
    else { toast.ok(t("mods.installDone", { name: (r.data as any).name })); setUrl(""); setUrlName(""); qc.invalidateQueries({ queryKey: ["mods"] }); setPendingChanges(true); }
  }
  async function installUpload(input: HTMLInputElement) {
    if (!file) { toast.err(t("mods.chooseFirst")); return; }
    if (!/\.(pak|zip)$/i.test(file.name)) { toast.err(t("mods.invalidType")); return; }
    if (file.size > MOD_MAX) { toast.err(t("mods.tooBig")); return; }
    setBusy("upload");
    const r = await apiUpload("/api/mods/upload", file, { query: `name=${encodeURIComponent(file.name)}` });
    setBusy(null);
    if (!r.ok) toast.err(r.error || t("mods.uploadFailed"));
    else { toast.ok(t("mods.uploadDone", { name: file.name })); setFile(null); input.value = ""; qc.invalidateQueries({ queryKey: ["mods"] }); setPendingChanges(true); }
  }
  async function toggle(m: any) {
    setBusy(`t-${m.name}`);
    const r = await apiPost(`/api/mods/${encodeURIComponent(m.name)}/${m.enabled ? "disable" : "enable"}`);
    setBusy(null);
    if (!r.ok) toast.err(r.error || t("mods.toggleFailed"));
    else { toast.ok(m.enabled ? t("mods.disableDone") : t("mods.enableDone")); qc.invalidateQueries({ queryKey: ["mods"] }); setPendingChanges(true); }
  }
  async function del(m: any) {
    const ok = await confirm({ message: t("mods.confirmRemove", { name: m.name }), confirmLabel: t("common.delete"), danger: true });
    if (!ok) return;
    setBusy(`d-${m.name}`);
    const r = await apiDelete(`/api/mods/${encodeURIComponent(m.name)}`);
    setBusy(null);
    if (!r.ok) toast.err(r.error || t("mods.deleteFailed"));
    else { toast.ok(t("mods.deleteDone")); qc.invalidateQueries({ queryKey: ["mods"] }); setPendingChanges(true); }
  }
  async function restart() {
    const ok = await confirm({ message: t("mods.confirmRestart"), confirmLabel: t("mods.restartNow"), danger: true });
    if (!ok) return;
    setBusy("restart");
    const r = await apiPost("/api/restart");
    setBusy(null);
    if (!r.ok) toast.err(r.error || t("mods.restartFailed"));
    else { toast.ok(t("mods.restarting")); setPendingChanges(false); }
  }
  async function ue4ss() {
    setBusy("ue4ss");
    const r = await apiPost("/api/mods/ue4ss/install", { url: ue4ssUrl || undefined });
    setBusy(null);
    if (!r.ok) toast.err(r.error || t("mods.ue4ssFailed"));
    else toast.ok(t("mods.ue4ssDone"));
  }

  return (
    <div className="stack-lg">
      <div className={cn("pill", ue4ssAvailable ? "pill-on" : "pill-warn")} style={{ alignSelf: "flex-start" }}>
        <span className="dot" />{ue4ssAvailable ? t("mods.runtimeProton") : t("mods.runtimeNative")}
      </div>
      {canWrite && (
        <div className="panel">
          <div className="panel-header"><div className="panel-title">{t("mods.installTitle")}</div></div>
          <div className="panel-body stack">
            <div className="field-hint">{t("mods.installHint")}</div>
            <div className="field">
              <label className="field-label">{t("mods.byUrl")}</label>
              <div className="row">
                <input className="input" style={{ flex: 2 }} placeholder={t("mods.urlPlaceholder")} value={url} onChange={(e) => setUrl(e.target.value)} />
                <input className="input" style={{ flex: 1 }} placeholder={t("mods.nameOptional")} value={urlName} onChange={(e) => setUrlName(e.target.value)} />
                <button className="btn btn-primary" onClick={installUrl} disabled={busy === "url"}>{t("mods.install")}</button>
              </div>
            </div>
            <div className="field">
              <label className="field-label">{t("mods.byUpload")}</label>
              <div className="row">
                <input type="file" accept=".pak,.zip" onChange={(e) => setFile(e.target.files?.[0] || null)} id="mod-file" />
                <button className="btn btn-primary" onClick={() => installUpload(document.getElementById("mod-file") as HTMLInputElement)} disabled={busy === "upload" || !file}>{t("mods.upload")}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">{t("mods.installed", { count: mods.length })}</div>
          {pendingChanges && canRestart && (
            <button className="btn btn-sm btn-primary" onClick={restart} disabled={busy === "restart"}>{t("mods.restartToApply")} · {t("mods.restartNow")}</button>
          )}
        </div>
        <div className="panel-body">
          {mods.length === 0 ? <div className="empty">{t("mods.noMods")}</div> : (
            <div className="table-scroll">
              <table className="table">
                <thead><tr>
                  <th>{t("mods.colName")}</th><th style={{ width: 80 }}>{t("mods.colType")}</th>
                  <th style={{ width: 100 }}>{t("mods.colStatus")}</th><th style={{ width: 100 }}>{t("mods.colSize")}</th>
                  <th style={{ width: 140 }}>{t("mods.colInstalledAt")}</th>
                  {canWrite && <th style={{ width: 200 }}>{t("mods.colActions")}</th>}
                </tr></thead>
                <tbody>
                  {mods.map((m: any) => (
                    <tr key={m.name}>
                      <td className="mono" style={{ fontSize: 13 }}>{m.name}</td>
                      <td><span className="pill">{m.type}</span></td>
                      <td><span className={cn("pill", m.enabled ? "pill-on" : "pill-off")}><span className="dot" />{m.enabled ? t("mods.enabled") : t("mods.disabled")}</span></td>
                      <td className="mono">{formatBytes(m.size)}</td>
                      <td>{formatDate(m.installed_at)}</td>
                      {canWrite && (
                        <td><div className="row-tight">
                          <button className="btn btn-sm" onClick={() => toggle(m)} disabled={busy === `t-${m.name}`}>{m.enabled ? t("mods.disable") : t("mods.enable")}</button>
                          <button className="btn btn-sm btn-danger" onClick={() => del(m)} disabled={busy === `d-${m.name}`}>{t("mods.remove")}</button>
                        </div></td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {canWrite && (
        <div className="panel">
          <div className="panel-header"><div className="panel-title">{t("mods.ue4ssTitle")}</div></div>
          <div className="panel-body stack">
            <div className="field-hint">{ue4ssAvailable ? t("mods.ue4ssHint") : t("mods.ue4ssUnavailable")}</div>
            <div className="row">
              <input className="input" placeholder={t("mods.ue4ssUrl")} value={ue4ssUrl} onChange={(e) => setUe4ssUrl(e.target.value)} disabled={!ue4ssAvailable} />
              <button className="btn btn-primary" onClick={ue4ss} disabled={!ue4ssAvailable || busy === "ue4ss"}>{t("mods.ue4ssInstall")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

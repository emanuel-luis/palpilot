import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSaves, useSaveBackups } from "@/hooks/queries";
import { apiPost, apiDelete, apiDownload, apiGet, apiUpload } from "@/lib/api";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm } from "./ui/Confirm";
import { t } from "@/i18n/en";
import { formatBytes, formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";

export function SavesSection() {
  const q = useSaves();
  const qc = useQueryClient();
  const canWrite = session.can("saves");
  const [newName, setNewName] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  if (q.isLoading) return <div className="field-hint">{t("common.loading")}</div>;
  if (q.error) return <div className="empty">{t("saves.loadFailed")} <button className="btn btn-sm" onClick={() => q.refetch()}>{t("common.retry")}</button></div>;
  const data = q.data!;

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try { await fn(); } finally { setBusy(null); }
  }

  async function create() {
    if (!newName.trim()) { toast.err(t("saves.enterName")); return; }
    await withBusy("create", async () => {
      const r = await apiPost("/api/saves", { name: newName.trim() });
      if (!r.ok) toast.err(r.error || t("saves.createFailed"));
      else { toast.ok(t("saves.slotCreated", { name: newName.trim() })); setNewName(""); qc.invalidateQueries({ queryKey: ["saves"] }); }
    });
  }
  async function activate(s: any) {
    const ok = await confirm({ message: t("saves.confirmActivate", { name: s.name }), confirmLabel: t("saves.activate"), danger: true });
    if (!ok) return;
    await withBusy(`activate-${s.guid}`, async () => {
      const r = await apiPost(`/api/saves/${s.guid}/activate`, {}, { query: "restart=true" });
      if (!r.ok) toast.err(r.error || t("saves.activateFailed"));
      else { toast.ok(t("saves.activateDone", { name: s.name })); qc.invalidateQueries({ queryKey: ["saves"] }); }
    });
  }
  async function backup(s: any) {
    await withBusy(`backup-${s.guid}`, async () => {
      const r = await apiPost(`/api/saves/${s.guid}/backup`);
      if (!r.ok) toast.err(r.error || t("saves.backupFailed"));
      else { toast.ok(t("saves.backupDone")); qc.invalidateQueries({ queryKey: ["saves"] }); qc.invalidateQueries({ queryKey: ["backups", s.guid] }); }
    });
  }
  async function del(s: any) {
    const ok = await confirm({ message: t("saves.confirmDelete", { name: s.name }), confirmLabel: t("common.delete"), danger: true });
    if (!ok) return;
    await withBusy(`del-${s.guid}`, async () => {
      const r = await apiDelete(`/api/saves/${s.guid}`);
      if (!r.ok) toast.err(r.error || t("saves.deleteFailed"));
      else { toast.ok(t("saves.deleteDone")); qc.invalidateQueries({ queryKey: ["saves"] }); }
    });
  }
  async function download(s: any) {
    await withBusy(`dl-${s.guid}`, async () => {
      toast.ok(t("saves.downloadPreparing"));
      const r = await apiDownload(`/api/saves/${s.guid}/download`, `${s.name}.tar.gz`);
      if (!r.ok) toast.err(r.error || t("saves.downloadFailed"));
    });
  }
  async function rename(s: any) {
    const name = window.prompt(t("saves.renameTitle", { name: s.name }), s.name);
    if (!name || name === s.name) return;
    await withBusy(`rn-${s.guid}`, async () => {
      const r = await apiPost(`/api/saves/${s.guid}/rename`, { name });
      if (!r.ok) toast.err(r.error || t("saves.renameFailed"));
      else { toast.ok(t("saves.renameDone", { name })); qc.invalidateQueries({ queryKey: ["saves"] }); }
    });
  }
  async function clone(s: any) {
    const name = window.prompt(t("saves.cloneTitle", { name: s.name }), `${s.name} copy`);
    if (!name) return;
    await withBusy(`cl-${s.guid}`, async () => {
      const r = await apiPost(`/api/saves/${s.guid}/clone`, { name });
      if (!r.ok) toast.err(r.error || t("saves.cloneFailed"));
      else { toast.ok(t("saves.cloneDone", { name })); qc.invalidateQueries({ queryKey: ["saves"] }); }
    });
  }

  return (
    <div className="stack-lg">
      {canWrite && (
        <div className="row">
          <input className="input" style={{ maxWidth: 260 }} placeholder={t("saves.slotNamePlaceholder")} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn btn-primary" onClick={create} disabled={busy === "create"}>{t("saves.create")}</button>
          <div className="spacer" />
          <button className="btn" onClick={() => setImportOpen(true)}>{t("saves.import")}</button>
        </div>
      )}
      {importOpen && <ImportDialog onClose={() => { setImportOpen(false); qc.invalidateQueries({ queryKey: ["saves"] }); }} />}

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>{t("saves.colName")}</th>
              <th className="mono">{t("saves.colGuid")}</th>
              <th style={{ width: 100 }}>{t("saves.colSize")}</th>
              <th style={{ width: 140 }}>{t("saves.colLastBackup")}</th>
              <th style={{ width: 260 }}>{t("saves.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {data.slots.length === 0 && <tr><td colSpan={5}><div className="empty">{t("saves.noSaves")}</div></td></tr>}
            {data.slots.map((s: any) => (
              <>
                <tr key={s.guid}>
                  <td>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <strong>{s.name}</strong>
                      {s.active && <span className="pill pill-on"><span className="dot" />{t("saves.active")}</span>}
                      {s.empty && <span className="pill">{t("saves.empty")}</span>}
                      {s.pending && <span className="pill pill-warn"><span className="dot" />{t("saves.pending")}</span>}
                    </div>
                  </td>
                  <td className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>{s.guid}</td>
                  <td className="mono">{formatBytes(s.size)}</td>
                  <td>{s.last_backup ? formatDate(s.last_backup) : "—"}</td>
                  <td>
                    <div className="row-tight">
                      {canWrite && !s.active && <button className="btn btn-sm btn-primary" onClick={() => activate(s)} disabled={busy?.startsWith("activate")}>{t("saves.activate")}</button>}
                      {canWrite && <button className="btn btn-sm" onClick={() => backup(s)} disabled={busy?.startsWith("backup")}>{t("saves.backup")}</button>}
                      <button className="btn btn-sm btn-ghost" onClick={() => setExpanded(expanded === s.guid ? null : s.guid)}>
                        {expanded === s.guid ? t("saves.hideBackups") : t("saves.showBackups")}
                      </button>
                      {canWrite && <button className="btn btn-sm btn-ghost" onClick={() => clone(s)}>{t("saves.clone")}</button>}
                      {canWrite && <button className="btn btn-sm btn-ghost" onClick={() => rename(s)}>{t("saves.rename")}</button>}
                      <button className="btn btn-sm btn-ghost" onClick={() => download(s)} disabled={busy === `dl-${s.guid}`}>{t("saves.download")}</button>
                      {canWrite && !s.active && <button className="btn btn-sm btn-danger" onClick={() => del(s)}>{t("common.delete")}</button>}
                    </div>
                  </td>
                </tr>
                {expanded === s.guid && (
                  <tr key={s.guid + "-b"}>
                    <td colSpan={5} style={{ background: "var(--paper)" }}>
                      <BackupList guid={s.guid} slotName={s.name} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BackupList({ guid, slotName }: { guid: string; slotName: string }) {
  const q = useSaveBackups(guid);
  const qc = useQueryClient();
  const canWrite = session.can("saves");
  const [busy, setBusy] = useState<string | null>(null);

  if (q.isLoading) return <div className="field-hint" style={{ padding: 12 }}>{t("saves.loadingBackups")}</div>;
  if (q.error) return <div className="empty">{t("saves.backupsLoadFailed")}</div>;
  const backups = q.data || [];
  if (backups.length === 0) return <div className="empty">{t("saves.noBackups")}</div>;

  async function restore(b: any, asNew: boolean) {
    const msg = asNew ? t("saves.confirmRestoreAsNew", { file: b.file }) : t("saves.confirmRestore", { file: b.file, name: slotName });
    let name: string | null = null;
    if (asNew) {
      name = window.prompt(t("saves.restoreAsNewName"), `${slotName} restored`);
      if (!name) return;
    }
    const ok = await confirm({ message: msg, confirmLabel: t("saves.restore"), danger: true });
    if (!ok) return;
    setBusy(b.ref);
    const r = await apiPost(`/api/saves/${guid}/restore`, asNew ? { ref: b.ref, as_new_slot: true, name } : { ref: b.ref });
    setBusy(null);
    if (!r.ok) toast.err(r.error || t("saves.restoreFailed"));
    else { toast.ok(t("saves.restoreDone")); qc.invalidateQueries({ queryKey: ["saves"] }); }
  }
  async function download(b: any) {
    setBusy(`dl-${b.ref}`);
    const r = await apiDownload(`/api/saves/${guid}/backups/${b.ref}/download`, b.file);
    setBusy(null);
    if (!r.ok) toast.err(r.error || t("saves.downloadFailed"));
  }

  return (
    <div style={{ padding: "10px 6px" }}>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: "40%" }}>{t("saves.colFile")}</th>
            <th style={{ width: 90 }}>{t("saves.colSize")}</th>
            <th style={{ width: 160 }}>{t("saves.colLocation")}</th>
            <th style={{ width: 140 }}>{t("saves.colCreated")}</th>
            <th>{t("saves.colActions")}</th>
          </tr>
        </thead>
        <tbody>
          {backups.map((b: any) => (
            <tr key={b.ref}>
              <td className="mono" style={{ fontSize: 13 }}>{b.file}</td>
              <td className="mono">{formatBytes(b.size)}</td>
              <td>
                <span className={cn("pill", b.location === "remote" ? "pill-on" : "pill-off")} title={b.uri || ""}>
                  {b.location === "remote" ? "☁ " + t("saves.locationRemote") : "▣ " + t("saves.locationLocal")}
                </span>
              </td>
              <td>{formatDate(b.created)}</td>
              <td>
                <div className="row-tight">
                  {canWrite && <button className="btn btn-sm" onClick={() => restore(b, false)} disabled={busy === b.ref}>{t("saves.restore")}</button>}
                  {canWrite && <button className="btn btn-sm btn-ghost" onClick={() => restore(b, true)} disabled={busy === b.ref}>{t("saves.restoreAsNew")}</button>}
                  <button className="btn btn-sm btn-ghost" onClick={() => download(b)} disabled={busy === `dl-${b.ref}`}>{t("saves.download")}</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [pct, setPct] = useState(0);
  const [running, setRunning] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);

  async function start() {
    if (!file) return;
    setRunning(true); setPct(0);
    const init = await apiPost<{ upload_id: string; part_max_bytes: number; max_bytes: number }>(
      "/api/saves/upload",
      { filename: file.name, name: name || file.name.replace(/\.(tar\.gz|tgz|zip)$/i, "") }
    );
    if (!init.ok) { toast.err(init.error || t("saves.importFailed")); setRunning(false); return; }
    const { upload_id, part_max_bytes, max_bytes } = init.data;
    if (file.size > max_bytes) {
      toast.err(t("saves.tooBig", { max: formatBytes(max_bytes) }));
      await apiDelete(`/api/saves/upload/${upload_id}`);
      setRunning(false); return;
    }
    setCancelId(upload_id);
    let sent = 0, idx = 0;
    while (sent < file.size) {
      const end = Math.min(sent + part_max_bytes, file.size);
      const slice = file.slice(sent, end);
      let attempts = 0;
      while (true) {
        const r = await apiUpload(`/api/saves/upload/${upload_id}/part`, slice, { query: `index=${idx}` });
        if (r.ok) break;
        if (r.status === 409 && attempts < 2) { attempts++; continue; }
        toast.err(r.error || t("saves.importFailed"));
        await apiDelete(`/api/saves/upload/${upload_id}`);
        setRunning(false); return;
      }
      sent = end; idx++; setPct(Math.round((sent / file.size) * 100));
    }
    const fin = await apiPost(`/api/saves/upload/${upload_id}/finish`, { name: name || file.name });
    setRunning(false); setCancelId(null);
    if (!fin.ok) toast.err(fin.error || t("saves.importFailed"));
    else { toast.ok(t("saves.importDone", { name: (fin.data as any).name })); onClose(); }
  }
  async function cancel() {
    if (cancelId) await apiDelete(`/api/saves/upload/${cancelId}`);
    setRunning(false); toast.warn(t("saves.importCancelled")); onClose();
  }

  return (
    <div className="dialog-scrim" onClick={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true">
        <h3>{t("saves.importTitle")}</h3>
        <p className="field-hint" style={{ marginBottom: 16 }}>{t("saves.importHint")}</p>
        <div className="stack">
          <div className="field">
            <label className="field-label">{t("saves.import")}</label>
            <input type="file" accept=".tar.gz,.tgz,.zip" onChange={(e) => setFile(e.target.files?.[0] || null)} disabled={running} />
          </div>
          <div className="field">
            <label className="field-label">{t("saves.importAsName")}</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={file?.name || ""} disabled={running} />
          </div>
          {running && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="field-hint mono">{t("saves.importUploading", { file: file?.name || "", pct })}</div>
              <div className="progress"><div className="progress-bar" style={{ width: `${pct}%` }} /></div>
            </div>
          )}
        </div>
        <div className="dialog-actions" style={{ marginTop: 20 }}>
          {running ? (
            <button className="btn btn-danger" onClick={cancel}>{t("saves.importCancel")}</button>
          ) : (
            <>
              <button className="btn" onClick={onClose}>{t("common.cancel")}</button>
              <button className="btn btn-primary" onClick={start} disabled={!file}>{t("saves.import")}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSaves, useActivateSave, useDeleteSave, useRenameSave, useBackupSave, useRestoreBackup } from "@/hooks/queries";
import { apiPost } from "@/lib/api";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm } from "./ui/Confirm";
import { t } from "@/i18n/en";
import { formatBytes, formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";

const PART = 24 * 1024 * 1024;

export function SavesSection() {
  const q = useSaves();
  const qc = useQueryClient();
  const canWrite = session.can("saves");
  const activate = useActivateSave();
  const del = useDeleteSave();
  const rename = useRenameSave();
  const backup = useBackupSave();
  const restore = useRestoreBackup();

  const [uploading, setUploading] = useState<{ pct: number; label: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (q.isLoading) return <div className="field-hint">{t("common.loading")}</div>;
  if (q.error) return <div className="empty">{t("saves.loadFailed")} <button className="btn btn-sm" onClick={() => q.refetch()}>{t("common.retry")}</button></div>;
  const data = q.data!;
  const slots: any[] = data.slots || [];
  const active = data.active_id;

  async function onActivate(s: any) {
    if (s.id === active) return;
    const ok = await confirm({ message: t("saves.confirmActivate", { name: s.name }), confirmLabel: t("saves.activate"), danger: false });
    if (!ok) return;
    const r = await activate.mutateAsync(s.id);
    if (!r.ok) toast.err(r.error || t("saves.activateFailed"));
    else toast.ok(t("saves.activated", { name: s.name }));
  }
  async function onDelete(s: any) {
    if (s.id === active) { toast.err(t("saves.cantDeleteActive")); return; }
    const ok = await confirm({ message: t("saves.confirmDelete", { name: s.name }), confirmLabel: t("common.delete"), danger: true });
    if (!ok) return;
    const r = await del.mutateAsync(s.id);
    if (!r.ok) toast.err(r.error || t("saves.deleteFailed"));
    else toast.ok(t("saves.deleted"));
  }
  async function onRename(s: any) {
    const name = window.prompt(t("saves.renamePrompt"), s.name);
    if (!name || name === s.name) return;
    const r = await rename.mutateAsync({ id: s.id, name });
    if (!r.ok) toast.err(r.error || t("saves.renameFailed"));
    else toast.ok(t("saves.renamed"));
  }
  async function onBackup(s: any) {
    const r = await backup.mutateAsync(s.id);
    if (!r.ok) toast.err(r.error || t("saves.backupFailed"));
    else toast.ok(t("saves.backupCreated"));
  }
  async function onRestore(s: any, b: string) {
    const ok = await confirm({ message: t("saves.confirmRestore", { name: s.name, backup: b }), confirmLabel: t("saves.restore"), danger: true });
    if (!ok) return;
    const r = await restore.mutateAsync({ id: s.id, backup: b });
    if (!r.ok) toast.err(r.error || t("saves.restoreFailed"));
    else toast.ok(t("saves.restored"));
  }

  async function onUpload(file: File) {
    if (!/\.(zip|tar\.gz|tgz)$/i.test(file.name)) { toast.err(t("saves.invalidType")); return; }
    setUploading({ pct: 0, label: t("saves.uploadStarting") });
    const init = await apiPost<{ upload_id: string }>("/api/saves/upload", { filename: file.name, size: file.size });
    if (!init.ok) { setUploading(null); toast.err(init.error || t("saves.uploadFailed")); return; }
    const uploadId = init.data.upload_id;
    const total = Math.ceil(file.size / PART);
    for (let i = 0; i < total; i++) {
      const chunk = file.slice(i * PART, Math.min(file.size, (i + 1) * PART));
      const fd = new FormData();
      fd.append("part", chunk, `${file.name}.part${i}`);
      const r = await apiPost(`/api/saves/upload/${uploadId}/part?index=${i}`, fd);
      if (!r.ok) {
        setUploading(null);
        if (r.status === 409) toast.err(t("saves.uploadPartFailedRetry"));
        else toast.err(r.error || t("saves.uploadFailed"));
        return;
      }
      setUploading({ pct: Math.round(((i + 1) / total) * 100), label: t("saves.uploadingPart", { i: i + 1, n: total }) });
    }
    const fin = await apiPost(`/api/saves/upload/${uploadId}/finish`);
    setUploading(null);
    if (!fin.ok) toast.err(fin.error || t("saves.finishFailed"));
    else { toast.ok(t("saves.imported")); qc.invalidateQueries({ queryKey: ["saves"] }); }
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="stack-lg">
      {canWrite && (
        <div className="panel">
          <div className="panel-header"><div className="panel-title">{t("saves.importTitle")}</div></div>
          <div className="panel-body stack">
            <div className="field-hint">{t("saves.importHint")}</div>
            <div className="row">
              <input ref={fileRef} type="file" accept=".zip,.tar.gz,.tgz" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} disabled={!!uploading} />
              {uploading && <div className="field-hint mono">{uploading.label} ({uploading.pct}%)</div>}
            </div>
            {uploading && <div className="progress" role="progressbar" aria-valuenow={uploading.pct}><div className="progress-bar" style={{ width: `${uploading.pct}%` }} /></div>}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("saves.slotsTitle", { count: slots.length })}</div></div>
        <div className="panel-body">
          {slots.length === 0 ? (
            <div className="empty">{t("saves.noSlots")}</div>
          ) : (
            <div className="stack">
              {slots.map((s) => (
                <div key={s.id} className={cn("save-slot", s.id === active && "active")}>
                  <div className="save-slot-head">
                    <div>
                      <div className="save-slot-name">{s.name}
                        {s.id === active && <span className="pill pill-on" style={{ marginLeft: 8, fontSize: 11 }}>{t("saves.activeBadge")}</span>}
                      </div>
                      <div className="field-hint mono" style={{ fontSize: 11 }}>{s.id} · {formatBytes(s.size)} · {t("saves.updated")} {formatDate(s.updated_at)}</div>
                    </div>
                    {canWrite && (
                      <div className="row-tight">
                        <button className="btn btn-sm" onClick={() => onActivate(s)} disabled={s.id === active || activate.isPending}>{t("saves.activate")}</button>
                        <button className="btn btn-sm" onClick={() => onBackup(s)}>{t("saves.backup")}</button>
                        <button className="btn btn-sm" onClick={() => onRename(s)}>{t("common.rename")}</button>
                        <button className="btn btn-sm btn-danger" onClick={() => onDelete(s)} disabled={s.id === active}>{t("common.delete")}</button>
                      </div>
                    )}
                  </div>
                  {s.backups?.length > 0 && (
                    <div className="save-backups">
                      <div className="field-hint" style={{ marginBottom: 6 }}>{t("saves.backups", { count: s.backups.length })}</div>
                      <div className="row-tight" style={{ flexWrap: "wrap", gap: 6 }}>
                        {s.backups.map((b: any) => (
                          <div key={b.name} className="backup-chip">
                            <span className="mono" style={{ fontSize: 11 }}>{b.name}</span>
                            <span className="field-hint" style={{ fontSize: 11 }}>{formatBytes(b.size)}</span>
                            {canWrite && <button className="btn btn-sm" onClick={() => onRestore(s, b.name)}>{t("saves.restore")}</button>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

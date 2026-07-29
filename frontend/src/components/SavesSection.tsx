// Save slots: create, import, clone, rename, activate, back up, restore, delete,
// download. Slots are keyed by `guid` (there is no `id`), the active slot comes
// from the payload's top-level `active`, and backups live behind their own
// per-slot endpoint rather than on the slot object.
import { useState } from "react";
import {
  useSaves, useBackups, useCreateSave, useCloneSave, useRenameSave,
  useActivateSave, useBackupSave, useRestoreBackup, useDeleteSave, isOffline,
  useGameVersion, useSetSaveVersion,
} from "@/hooks/queries";
import { apiPost, apiDelete, apiUpload, apiDownload } from "@/lib/api";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm, prompt } from "./ui/Confirm";
import { t } from "@/i18n/en";
import { formatBytes, formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";
import { navigate } from "@/hooks/useHashRoute";

const ARCHIVE_RE = /\.(zip|tgz|tar\.gz)$/i;
const PART_RETRIES = 3;

type UploadState = { pct: number; label: string; cancel: boolean } | null;

/** Strip one archive extension for a sensible default slot name. */
function baseName(filename: string): string {
  return filename.replace(/\.(tar\.gz|tgz|zip)$/i, "");
}

export function SavesSection() {
  const q = useSaves();
  const canWrite = session.can("saves");

  const create = useCreateSave();
  const clone = useCloneSave();
  const rename = useRenameSave();
  const activate = useActivateSave();
  const backup = useBackupSave();
  const restore = useRestoreBackup();
  const del = useDeleteSave();
  // The version a save runs on is part of the save, so it is edited here rather
  // than on the Game version page (which owns the server-wide auto-update
  // policy). Pinning needs the same `saves` permission as the rest of this page.
  const version = useGameVersion();
  const setVersion = useSetSaveVersion();
  const installedBuild: string | null =
    !isOffline(version.data) ? ((version.data as any)?.installed?.buildid || null) : null;

  const [newName, setNewName] = useState("");
  const [openGuid, setOpenGuid] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadState>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const backups = useBackups(openGuid);

  if (q.isLoading) return <div className="field-hint">{t("common.loading")}</div>;
  if (isOffline(q.data)) {
    return <div className="empty">{t("console.startFirst", { action: t("console.startFirstAction.saves") })}</div>;
  }
  if (q.error || !q.data) {
    return (
      <div className="empty">
        {t("saves.loadFailed")}{" "}
        <button className="btn btn-sm" onClick={() => q.refetch()}>{t("common.retry")}</button>
      </div>
    );
  }

  const data: any = q.data;
  const slots: any[] = data.slots || [];
  const active: string = data.active || "";

  // ----------------------------------------------------------------- actions

  async function onCreate() {
    const name = newName.trim();
    if (!name) { toast.err(t("saves.enterName")); return; }
    const r = await create.mutateAsync(name);
    if (!r.ok) toast.err(r.error || t("saves.createFailed"));
    else { toast.ok(t("saves.slotCreated", { name: (r.data as any)?.name || name })); setNewName(""); }
  }

  async function onActivate(s: any) {
    if (s.guid === active) { toast.info(t("saves.alreadyActive")); return; }
    const ok = await confirm({
      message: t("saves.confirmActivate", { name: s.name }),
      confirmLabel: t("saves.activate"),
      danger: true,
    });
    if (!ok) return;
    const r = await activate.mutateAsync(s.guid);
    if (!r.ok) { toast.err(r.error || t("saves.activateFailed")); return; }
    // The no-op branch answers { active, note: "already active" } and nothing else.
    if ((r.data as any)?.note === "already active") toast.info(t("saves.alreadyActive"));
    else toast.ok(t("saves.activateDone", { name: s.name }));
  }

  async function onDelete(s: any) {
    if (s.guid === active) { toast.err(t("saves.cantDeleteActive")); return; }
    const ok = await confirm({
      message: t("saves.confirmDelete", { name: s.name }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    const r = await del.mutateAsync(s.guid);
    if (!r.ok) toast.err(r.error || t("saves.deleteFailed"));
    else toast.ok(t("saves.deleteDone"));
  }

  async function onRename(s: any) {
    const name = await prompt({
      title: t("saves.renameTitle", { name: s.name }),
      message: t("saves.slotName"),
      input: { label: t("saves.slotName"), defaultValue: s.name },
      confirmLabel: t("common.save"),
    });
    if (!name || name === s.name) return;
    const r = await rename.mutateAsync({ guid: s.guid, name });
    if (!r.ok) toast.err(r.error || t("saves.renameFailed"));
    else toast.ok(t("saves.renameDone", { name: (r.data as any)?.name || name }));
  }

  async function onClone(s: any) {
    const name = await prompt({
      title: t("saves.cloneTitle", { name: s.name }),
      message: t("saves.slotName"),
      input: { label: t("saves.slotName"), defaultValue: `${s.name} copy` },
      confirmLabel: t("saves.clone"),
    });
    if (!name) return;
    const r = await clone.mutateAsync({ guid: s.guid, name });
    if (!r.ok) { toast.err(r.error || t("saves.cloneFailed")); return; }
    toast.ok(t("saves.cloneDone", { name: (r.data as any)?.name || name }));
    // Cloning the ACTIVE slot returns a note warning the copy is the last saved state.
    const note = (r.data as any)?.note;
    if (note) toast.info(String(note));
  }

  async function onBackup(s: any) {
    const r = await backup.mutateAsync(s.guid);
    if (!r.ok) { toast.err(r.error || t("saves.backupFailed")); return; }
    toast.ok(t("saves.backupDone"));
    // GCS upload can fail without failing the backup itself.
    const remoteErr = (r.data as any)?.remote_error;
    if (remoteErr) toast.info(String(remoteErr));
  }

  async function onRestore(s: any, b: any, asNew: boolean) {
    let name: string | null = null;
    if (asNew) {
      name = await prompt({
        title: t("saves.restoreAsNew"),
        message: t("saves.confirmRestoreAsNew", { file: b.file }),
        input: { label: t("saves.restoreAsNewName"), defaultValue: `${s.name} restored` },
        confirmLabel: t("saves.restoreAsNew"),
        danger: true,
      });
      if (!name) return;
    } else {
      const ok = await confirm({
        message: t("saves.confirmRestore", { file: b.file, name: s.name }),
        confirmLabel: t("saves.restore"),
        danger: true,
      });
      if (!ok) return;
    }
    const r = await restore.mutateAsync({ guid: s.guid, ref: b.ref, asNewSlot: asNew, name: name || undefined });
    if (!r.ok) toast.err(r.error || t("saves.restoreFailed"));
    else toast.ok(t("saves.restoreDone"));
  }

  async function onTogglePin(s: any) {
    const isPinned = s.version?.mode === "pinned";
    if (isPinned) {
      const ok = await confirm({
        message: t("saves.unpinHint", { name: s.name }),
        confirmLabel: t("saves.unpin"),
      });
      if (!ok) return;
      const r = await setVersion.mutateAsync({ guid: s.guid, mode: "latest" });
      if (!r.ok) toast.err(r.error || t("saves.pinFailed"));
      else toast.ok(t("saves.unpinDone"));
      return;
    }
    const ok = await confirm({
      title: t("saves.pinTitle", { name: s.name }),
      // No buildid in the body: the agent pins whatever is installed right now,
      // which is the only build guaranteed to be reinstallable later.
      message: t("saves.pinHint", { buildid: installedBuild || t("common.unknown") }),
      confirmLabel: t("saves.pin"),
    });
    if (!ok) return;
    const r = await setVersion.mutateAsync({ guid: s.guid, mode: "pinned" });
    if (!r.ok) toast.err(r.error || t("saves.pinFailed"));
    else toast.ok(t("saves.pinDone", { buildid: (r.data as any)?.buildid || installedBuild || "" }));
  }

  async function onDownloadSlot(s: any) {
    setDownloading(`slot-${s.guid}`);
    toast.info(t("saves.downloadPreparing"));
    // The server strips Content-Disposition, so the filename is ours to supply.
    const r = await apiDownload(`/api/saves/${encodeURIComponent(s.guid)}/download`, `${s.name}.tar.gz`);
    setDownloading(null);
    if (!r.ok) toast.err(r.error || t("saves.downloadFailed"));
  }

  async function onDownloadBackup(s: any, b: any) {
    setDownloading(`backup-${b.ref}`);
    toast.info(t("saves.downloadPreparing"));
    const r = await apiDownload(
      `/api/saves/${encodeURIComponent(s.guid)}/backups/${encodeURIComponent(b.ref)}/download`,
      b.file,
    );
    setDownloading(null);
    if (!r.ok) toast.err(r.error || t("saves.downloadFailed"));
  }

  // ------------------------------------------------------------ chunked import

  async function onPickFile(file: File, input: HTMLInputElement) {
    // Always clear the element so re-picking the same file fires onChange again.
    input.value = "";
    if (!ARCHIVE_RE.test(file.name)) { toast.err(t("saves.invalidType")); return; }

    const slotName = await prompt({
      title: t("saves.importTitle"),
      message: t("saves.import") + ` — ${file.name}`,
      input: { label: t("saves.importAsName"), defaultValue: baseName(file.name) },
      confirmLabel: t("saves.import"),
    });
    if (!slotName) return;

    setUpload({ pct: 0, label: t("saves.uploadStarting"), cancel: false });

    const init = await apiPost<{ upload_id: string; part_max_bytes: number; max_bytes: number }>(
      "/api/saves/upload",
      { filename: file.name, name: slotName },
    );
    if (!init.ok) { setUpload(null); toast.err(init.error || t("saves.importFailed")); return; }

    const uploadId = init.data.upload_id;
    // Never hardcode these — the server owns both limits.
    const partSize = init.data.part_max_bytes || 24 * 1024 * 1024;
    const maxBytes = init.data.max_bytes;

    const abort = async () => { await apiDelete(`/api/saves/upload/${encodeURIComponent(uploadId)}`); };

    if (maxBytes && file.size > maxBytes) {
      setUpload(null);
      await abort();
      toast.err(t("saves.tooBig", { max: formatBytes(maxBytes) }));
      return;
    }

    const total = Math.max(1, Math.ceil(file.size / partSize));
    for (let i = 0; i < total; i++) {
      let sent = false;
      for (let attempt = 0; attempt < PART_RETRIES && !sent; attempt++) {
        const chunk = file.slice(i * partSize, Math.min(file.size, (i + 1) * partSize));
        // Raw bytes, octet-stream. Never FormData — the agent appends the body verbatim.
        const r = await apiUpload(
          `/api/saves/upload/${encodeURIComponent(uploadId)}/part`,
          chunk,
          { query: `index=${i}` },
        );
        if (r.ok) { sent = true; break; }
        // A 409 means our index drifted; the server truncated back to the last
        // good offset, so re-sending THIS index is safe.
        if (r.status === 409 && attempt < PART_RETRIES - 1) {
          setUpload({ pct: Math.round((i / total) * 100), label: t("saves.uploadRetrying", { i: i + 1 }), cancel: false });
          continue;
        }
        setUpload(null);
        await abort();
        toast.err(r.error || t("saves.importFailed"));
        return;
      }
      if (!sent) { setUpload(null); await abort(); toast.err(t("saves.importFailed")); return; }

      setUpload((prev) => {
        if (prev?.cancel) return prev;
        return { pct: Math.round(((i + 1) / total) * 100), label: t("saves.uploadingPart", { i: i + 1, n: total }), cancel: false };
      });
    }

    setUpload({ pct: 100, label: t("saves.uploadFinishing"), cancel: false });
    const fin = await apiPost<{ guid: string; name: string; size: number; note?: string }>(
      `/api/saves/upload/${encodeURIComponent(uploadId)}/finish`,
      { name: slotName },
    );
    setUpload(null);
    if (!fin.ok) { toast.err(fin.error || t("saves.importFailed")); return; }
    toast.ok(t("saves.importDone", { name: fin.data.name || slotName }));
    if (fin.data.note) toast.info(fin.data.note);
  }

  // ------------------------------------------------------------------- render

  return (
    <div className="stack-lg">
      {canWrite && (
        <div className="panel">
          <div className="panel-header"><div className="panel-title">{t("saves.createTitle")}</div></div>
          <div className="panel-body stack">
            <div className="field-hint">{t("saves.createHint")}</div>
            <div className="row">
              <input
                className="input"
                style={{ maxWidth: 260 }}
                placeholder={t("saves.slotNamePlaceholder")}
                aria-label={t("saves.slotName")}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") onCreate(); }}
              />
              <button className="btn btn-primary" onClick={onCreate} disabled={create.isPending}>
                {t("saves.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {canWrite && (
        <div className="panel">
          <div className="panel-header"><div className="panel-title">{t("saves.importTitle")}</div></div>
          <div className="panel-body stack">
            <div className="field-hint">{t("saves.importHint")}</div>
            <div className="row">
              <input
                type="file"
                accept=".zip,.tar.gz,.tgz"
                disabled={!!upload}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickFile(f, e.target); }}
              />
              {upload && <div className="field-hint mono">{upload.label} ({upload.pct}%)</div>}
            </div>
            {upload && (
              <div
                className="progress"
                role="progressbar"
                aria-valuenow={upload.pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-live="polite"
              >
                <div className="progress-bar" style={{ width: `${upload.pct}%` }} />
              </div>
            )}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">{t("saves.listTitle", { count: slots.length })}</div>
        </div>
        <div className="panel-body">
          {slots.length === 0 ? (
            <div className="empty">{t("saves.noSaves")}</div>
          ) : (
            <div className="stack">
              {slots.map((s) => {
                const isActive = s.guid === active || s.active === true;
                const open = openGuid === s.guid;
                return (
                  <div key={s.guid} className={cn("save-slot", isActive && "active")}>
                    <div className="save-slot-head">
                      <div>
                        <div className="save-slot-name">
                          {s.name}
                          {isActive && <span className="pill pill-on" style={{ marginLeft: 8, fontSize: 11 }}>{t("saves.active")}</span>}
                          {s.pending && <span className="pill pill-warn" style={{ marginLeft: 6, fontSize: 11 }}>{t("saves.pending")}</span>}
                          {s.empty && !s.pending && <span className="pill pill-off" style={{ marginLeft: 6, fontSize: 11 }}>{t("saves.empty")}</span>}
                        </div>
                        <div className="field-hint mono" style={{ fontSize: 11 }}>
                          {s.guid} · {formatBytes(s.size)} · {t("saves.colLastBackup")}{" "}
                          {s.last_backup ? formatDate(s.last_backup) : "—"}
                          {" · "}
                          {s.version?.mode === "pinned"
                            ? t("saves.versionPinned", { buildid: s.version.buildid })
                            : t("saves.versionLatest")}
                        </div>
                      </div>
                      <div className="row-tight">
                        <button
                          className="btn btn-sm"
                          onClick={() => navigate(`/settings/${encodeURIComponent(s.guid)}`)}
                          title={
                            isActive
                              ? "Edit this world's settings (it is the running one)"
                              : "Edit this world's own settings — applied when you activate it"
                          }
                        >
                          {t("settings.title")}
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => setOpenGuid(open ? null : s.guid)}
                          aria-expanded={open}
                        >
                          {open ? t("saves.hideBackups") : t("saves.showBackups")}
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => onDownloadSlot(s)}
                          disabled={s.empty || downloading === `slot-${s.guid}`}
                        >
                          {t("saves.download")}
                        </button>
                        {canWrite && (
                          <>
                            <button
                              className="btn btn-sm"
                              onClick={() => onActivate(s)}
                              disabled={isActive || activate.isPending}
                            >{t("saves.activate")}</button>
                            <button
                              className="btn btn-sm"
                              onClick={() => onBackup(s)}
                              disabled={s.empty || backup.isPending}
                            >{t("saves.backup")}</button>
                            <button
                              className="btn btn-sm"
                              onClick={() => onTogglePin(s)}
                              disabled={setVersion.isPending || (!installedBuild && s.version?.mode !== "pinned")}
                              title={
                                s.version?.mode === "pinned"
                                  ? t("saves.unpinHint", { name: s.name })
                                  : t("saves.pinHint", { buildid: installedBuild || "?" })
                              }
                            >
                              {s.version?.mode === "pinned" ? t("saves.unpin") : t("saves.pin")}
                            </button>
                            <button className="btn btn-sm" onClick={() => onClone(s)} disabled={clone.isPending}>
                              {t("saves.clone")}
                            </button>
                            <button className="btn btn-sm" onClick={() => onRename(s)} disabled={rename.isPending}>
                              {t("saves.rename")}
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => onDelete(s)}
                              disabled={isActive || del.isPending}
                            >{t("common.delete")}</button>
                          </>
                        )}
                      </div>
                    </div>

                    {open && (
                      <div className="save-backups">
                        {backups.isLoading ? (
                          <div className="field-hint">{t("saves.loadingBackups")}</div>
                        ) : backups.error || isOffline(backups.data) ? (
                          <div className="field-hint">
                            {t("saves.backupsLoadFailed")}{" "}
                            <button className="btn btn-sm" onClick={() => backups.refetch()}>{t("common.retry")}</button>
                          </div>
                        ) : ((backups.data as any)?.backups || []).length === 0 ? (
                          <div className="field-hint">{t("saves.noBackups")}</div>
                        ) : (
                          <div className="table-scroll">
                            <table className="table">
                              <thead>
                                <tr>
                                  <th>{t("saves.colFile")}</th>
                                  <th>{t("saves.colLocation")}</th>
                                  <th>{t("saves.colSize")}</th>
                                  <th>{t("saves.colCreated")}</th>
                                  <th style={{ width: 220 }}>{t("saves.colActions")}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {((backups.data as any).backups as any[]).map((b) => (
                                  <tr key={b.ref}>
                                    <td className="mono" style={{ fontSize: 12 }}>{b.file}</td>
                                    <td>
                                      <span className={cn("pill", b.location === "remote" ? "pill-on" : "pill-off")}>
                                        {b.location === "remote" ? t("saves.locationRemote") : t("saves.locationLocal")}
                                      </span>
                                    </td>
                                    <td className="mono">{formatBytes(b.size)}</td>
                                    <td className="mono">{formatDate(b.created)}</td>
                                    <td>
                                      <div className="row-tight">
                                        <button
                                          className="btn btn-sm"
                                          onClick={() => onDownloadBackup(s, b)}
                                          disabled={downloading === `backup-${b.ref}`}
                                        >{t("saves.download")}</button>
                                        {canWrite && (
                                          <>
                                            <button
                                              className="btn btn-sm btn-danger"
                                              onClick={() => onRestore(s, b, false)}
                                              disabled={restore.isPending}
                                            >{t("saves.restore")}</button>
                                            <button
                                              className="btn btn-sm"
                                              onClick={() => onRestore(s, b, true)}
                                              disabled={restore.isPending}
                                            >{t("saves.restoreAsNew")}</button>
                                          </>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

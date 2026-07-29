// Game version: what build is installed, what Steam is serving, whether this
// server follows it automatically, and which builds can still be reinstalled.
//
// Two things are deliberately separate here. The auto-update switch is a SERVER
// policy (perm: settings). Pinning is a SAVE property (perm: saves) and lives
// per slot on the Saves page — this page only shows the active save's pin and
// the builds you could pin to, because a pin that can't be reinstalled is a
// promise the server can't keep.
import { useState } from "react";
import {
  useGameVersion, useCheckUpdate, useApplyUpdate, useUpdatePolicy, useSetSaveVersion, isOffline,
} from "@/hooks/queries";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm } from "./ui/Confirm";
import { t } from "@/i18n/en";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Timestamps arrive in two shapes: the agent's `2026-07-29_08-00-00` sidecar
 *  stamps and plain ISO strings. Show them, don't guess-parse them. */
function stamp(v: unknown): string {
  if (!v) return "—";
  const s = String(v);
  const iso = s.includes("T") ? Date.parse(s) : NaN;
  return Number.isNaN(iso) ? s.replace("_", " ") : formatDate(Math.floor(iso / 1000));
}

export function UpdatesSection() {
  const q = useGameVersion();
  const check = useCheckUpdate();
  const apply = useApplyUpdate();
  const policy = useUpdatePolicy();
  const setVersion = useSetSaveVersion();
  const canWrite = session.can("settings");
  const canPin = session.can("saves");
  const [busyBuild, setBusyBuild] = useState<string | null>(null);

  if (q.isLoading) return <div className="field-hint">{t("common.loading")}</div>;
  if (isOffline(q.data)) {
    return <div className="empty">{t("console.startFirst", { action: t("console.startFirstAction.settings") })}</div>;
  }
  if (q.error || !q.data) {
    return (
      <div className="empty">
        {t("updates.loadFailed")}{" "}
        <button className="btn btn-sm" onClick={() => q.refetch()}>{t("common.retry")}</button>
      </div>
    );
  }

  const d: any = q.data;
  const installed: string | null = d.installed?.buildid || null;
  const latest: string | null = d.latest?.buildid || null;
  const target: string | null = d.target?.buildid || null;
  const pinned = d.active?.mode === "pinned";
  const job = d.job || {};
  const running = job.state === "running";
  const builds: any[] = d.builds || [];

  async function onToggleAuto(next: boolean) {
    const r = await policy.mutateAsync(next);
    if (!r.ok) toast.err(r.error || t("updates.policyFailed"));
    else toast.ok(t("updates.policySaved"));
  }

  async function onCheck() {
    const r = await check.mutateAsync();
    if (!r.ok) toast.err(r.error || t("updates.checkFailed"));
  }

  async function onApply(buildid: string) {
    const ok = await confirm({
      title: t("updates.confirmApplyTitle"),
      message: t("updates.confirmApply", { buildid }),
      confirmLabel: t("updates.apply"),
      danger: true,
    });
    if (!ok) return;
    setBusyBuild(buildid);
    // "latest" as the target, not the buildid, when that is what we want: the
    // agent then runs `app_update` instead of a manifest-exact reinstall.
    const r = await apply.mutateAsync({ target: buildid === latest && !pinned ? "latest" : buildid });
    setBusyBuild(null);
    if (!r.ok) toast.err(r.error || t("updates.applyFailed"));
    else toast.ok(t("updates.applyStarted"));
  }

  async function onPinActive() {
    if (!d.active?.guid) return;
    const r = await setVersion.mutateAsync({ guid: d.active.guid, mode: "pinned" });
    if (!r.ok) toast.err(r.error || t("saves.pinFailed"));
    else toast.ok(t("saves.pinDone", { buildid: (r.data as any)?.buildid || installed || "" }));
  }

  async function onUnpinActive() {
    if (!d.active?.guid) return;
    const r = await setVersion.mutateAsync({ guid: d.active.guid, mode: "latest" });
    if (!r.ok) toast.err(r.error || t("saves.pinFailed"));
    else toast.ok(t("saves.unpinDone"));
  }

  return (
    <div className="stack-lg">
      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("updates.title")}</div></div>
        <div className="panel-body stack">
          <div className="field-hint">{t("updates.hint")}</div>

          <div className="row">
            <div className="field" style={{ maxWidth: 220 }}>
              <label className="field-label">{t("updates.installed")}</label>
              <div className="mono">{installed || t("common.unknown")}</div>
              <div className="field-hint" style={{ fontSize: 11 }}>{stamp(d.installed?.updated)}</div>
            </div>
            <div className="field" style={{ maxWidth: 220 }}>
              <label className="field-label">{t("updates.latest")}</label>
              <div className="mono">{latest || t("common.unknown")}</div>
              <div className="field-hint" style={{ fontSize: 11 }}>
                {d.latest?.checked ? t("updates.checked", { when: stamp(d.latest.checked) }) : t("updates.never")}
              </div>
            </div>
            <div className="field" style={{ maxWidth: 220 }}>
              <label className="field-label">{t("updates.target")}</label>
              <div className="mono">
                {target || t("common.unknown")}
                {pinned && <span className="pill pill-warn" style={{ marginLeft: 8, fontSize: 11 }}>{t("saves.versionPinned", { buildid: target || "" })}</span>}
              </div>
            </div>
          </div>

          {/* State line: one sentence that says what is true right now. */}
          {running ? (
            <div className="field-hint mono" aria-live="polite">
              {t("updates.jobRunning", { phase: job.phase || "…" })}
            </div>
          ) : d.up_to_date ? (
            <div className="field-hint">{t("updates.upToDate")}</div>
          ) : target ? (
            <div className="field-hint">{t("updates.behind", { buildid: target })}</div>
          ) : null}
          {pinned && <div className="field-hint">{t("updates.pinnedNotice", { buildid: target || "" })}</div>}
          {job.state === "error" && job.error && (
            <div className="field-hint">{t("updates.jobFailed", { error: String(job.error) })}</div>
          )}
          {d.latest?.error && <div className="field-hint">{String(d.latest.error)}</div>}

          <div className="row-tight">
            {canWrite && (
              <>
                <button className="btn btn-sm" onClick={onCheck} disabled={check.isPending || running}>
                  {check.isPending ? t("updates.checking") : t("updates.check")}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => onApply(target || latest || "")}
                  disabled={running || d.up_to_date || !(target || latest)}
                >
                  {running ? t("updates.applying") : t("updates.apply")}
                </button>
              </>
            )}
            {canPin && d.active?.guid && (
              pinned ? (
                <button className="btn btn-sm" onClick={onUnpinActive} disabled={setVersion.isPending}>
                  {t("saves.unpin")}
                </button>
              ) : (
                <button className="btn btn-sm" onClick={onPinActive} disabled={setVersion.isPending || !installed}>
                  {t("updates.pinActive")}
                </button>
              )
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("updates.autoUpdate")}</div></div>
        <div className="panel-body stack">
          <div className="field-hint">{t("updates.autoUpdateHint")}</div>
          <label className="row-tight" style={{ alignItems: "center" }}>
            <input
              type="checkbox"
              checked={!!d.policy?.auto_update}
              disabled={!canWrite || policy.isPending}
              onChange={(e) => onToggleAuto(e.target.checked)}
            />
            <span>{d.policy?.auto_update ? t("updates.autoUpdateOn") : t("updates.autoUpdateOff")}</span>
          </label>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("updates.builds")}</div></div>
        <div className="panel-body stack">
          <div className="field-hint">{t("updates.buildsHint")}</div>
          {builds.length === 0 ? (
            <div className="empty">{t("updates.noBuilds")}</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("updates.colBuild")}</th>
                    <th>{t("updates.colSeen")}</th>
                    <th>{t("updates.colSource")}</th>
                    <th style={{ width: 140 }}>{t("saves.colActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {builds.map((b) => (
                    <tr key={b.buildid}>
                      <td className="mono">
                        {b.buildid}
                        {b.buildid === installed && (
                          <span className={cn("pill", "pill-on")} style={{ marginLeft: 8, fontSize: 11 }}>
                            {t("updates.installed")}
                          </span>
                        )}
                      </td>
                      <td className="mono">{stamp(b.first_seen)}</td>
                      <td>{b.source || "—"}</td>
                      <td>
                        {canWrite && (
                          <button
                            className="btn btn-sm"
                            onClick={() => onApply(b.buildid)}
                            disabled={running || b.buildid === installed || busyBuild === b.buildid}
                          >
                            {t("updates.install")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { apiPost } from "@/lib/api";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm } from "./ui/Confirm";
import { t } from "@/i18n/en";

export function CommandsSection() {
  const canRestart = session.can("settings");
  const [msg, setMsg] = useState("");
  const [uid, setUid] = useState("");
  const [reason, setReason] = useState("");
  const [wait, setWait] = useState(30);
  const [stopMsg, setStopMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, path: string, body: any, label: string) {
    setBusy(key);
    const r = await apiPost(path, body);
    setBusy(null);
    if (!r.ok) toast.err(r.error || t("commands.fail"));
    else toast.ok(t("commands.ok", { cmd: label }));
  }
  async function announce() {
    if (!msg.trim()) { toast.err(t("commands.needMessage")); return; }
    await run("announce", "/api/rest/announce", { message: msg }, "announce");
  }
  async function mod(action: "kick" | "ban" | "unban") {
    if (!uid.trim()) { toast.err(t("commands.needUserId")); return; }
    const body = action === "unban" ? { userid: uid } : { userid: uid, message: reason || action };
    await run(action, `/api/rest/${action}`, body, action);
  }
  async function saveWorld() { await run("save", "/api/rest/save", {}, "save"); }
  // POST /api/restart is a `settings` route, not `commands` — this whole section is
  // mounted behind `commands`, so a moderator would otherwise see a button that
  // can only ever 403.
  async function restart() {
    if (!canRestart) return;
    const ok = await confirm({ message: t("commands.restartConfirm"), confirmLabel: t("commands.restart"), danger: true });
    if (!ok) return;
    await run("restart", "/api/restart", {}, "restart");
  }
  async function stop() {
    const ok = await confirm({ message: t("commands.stopConfirm", { seconds: wait }), confirmLabel: t("commands.stop"), danger: true });
    if (!ok) return;
    await run("stop", "/api/rest/shutdown", { waittime: wait, message: stopMsg || t("commands.stopPlaceholder") }, "shutdown");
  }
  async function forceStop() {
    const ok = await confirm({ message: t("commands.forceStopConfirm"), confirmLabel: t("commands.forceStop"), danger: true });
    if (!ok) return;
    await run("stop", "/api/rest/stop", {}, "stop");
  }

  return (
    <div className="stack-lg">
      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("commands.announceTitle")}</div></div>
        <div className="panel-body stack">
          <div className="field"><label className="field-label">{t("commands.announceMessage")}</label>
            <input className="input" value={msg} onChange={(e) => setMsg(e.target.value)} /></div>
          <div><button className="btn btn-primary" onClick={announce} disabled={busy === "announce"}>{t("commands.announce")}</button></div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("commands.modTitle")}</div></div>
        <div className="panel-body stack">
          <div className="row">
            <div className="field" style={{ flex: 2 }}><label className="field-label">{t("commands.userId")}</label>
              <input className="input mono" value={uid} onChange={(e) => setUid(e.target.value)} placeholder={t("commands.userIdPlaceholder")} /></div>
            <div className="field" style={{ flex: 3 }}><label className="field-label">{t("commands.reason")}</label>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          </div>
          <div className="row">
            <button className="btn" onClick={() => mod("kick")} disabled={busy === "kick"}>{t("commands.kick")}</button>
            <button className="btn btn-danger" onClick={() => mod("ban")} disabled={busy === "ban"}>{t("commands.ban")}</button>
            <button className="btn" onClick={() => mod("unban")} disabled={busy === "unban"}>{t("commands.unban")}</button>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("commands.worldTitle")}</div></div>
        <div className="panel-body"><button className="btn" onClick={saveWorld} disabled={busy === "save"}>{t("commands.saveWorld")}</button></div>
      </div>
      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("commands.powerTitle")}</div></div>
        <div className="panel-body stack">
          <div className="field-hint">{t("commands.powerNote")}</div>
          {canRestart && (
            <div className="row"><button className="btn" onClick={restart} disabled={busy === "restart"}>{t("commands.restart")}</button></div>
          )}
          <div className="row">
            <div className="field" style={{ maxWidth: 140 }}><label className="field-label">{t("commands.waitSeconds")}</label>
              <input className="input mono" type="number" min={0} value={wait} onChange={(e) => setWait(Number(e.target.value) || 0)} /></div>
            <div className="field" style={{ flex: 1 }}><label className="field-label">{t("commands.stopMessage")}</label>
              <input className="input" value={stopMsg} onChange={(e) => setStopMsg(e.target.value)} placeholder={t("commands.stopPlaceholder")} /></div>
          </div>
          <div className="row">
            <button className="btn btn-danger" onClick={stop} disabled={busy === "stop"}>{t("commands.stop")}</button>
            <button className="btn btn-danger" onClick={forceStop} disabled={busy === "stop"}>{t("commands.forceStop")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

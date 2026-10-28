// In-game commands. Everything here acts on the game process only — the VM keeps
// running and keeps billing — which the page says out loud, because "stop server"
// meaning two different things is the easiest mistake to make in this product.
import { useState } from "react";
import { Ban, Bell, LogOut, RotateCcw, Save, ShieldCheck, Square, UserCheck } from "lucide-react";
import { apiPost } from "@/lib/api";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm } from "./ui/Confirm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n/en";
import { cn } from "@/lib/cn";

const inputCls =
  "h-9 w-full rounded-md border border-line bg-surface-2 px-3 text-sm placeholder:text-faint " +
  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

function Labelled({
  label, hint, children, className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-2xs text-faint">{hint}</span> : null}
    </label>
  );
}

export function CommandsSection() {
  // POST /api/restart is a `settings` route, not `commands` — this whole section is
  // mounted behind `commands`, so a moderator would otherwise see a button that
  // can only ever 403.
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
    setMsg("");
  }

  async function mod(action: "kick" | "ban" | "unban") {
    if (!uid.trim()) { toast.err(t("commands.needUserId")); return; }
    if (action === "ban") {
      const ok = await confirm({
        title: t("commands.ban"),
        message: `Ban ${uid}? They can't rejoin until you unban them.`,
        confirmLabel: t("commands.ban"),
        danger: true,
      });
      if (!ok) return;
    }
    const body = action === "unban" ? { userid: uid } : { userid: uid, message: reason || action };
    await run(action, `/api/rest/${action}`, body, action);
  }

  async function saveWorld() { await run("save", "/api/rest/save", {}, "save"); }

  async function restart() {
    if (!canRestart) return;
    const ok = await confirm({
      title: t("commands.restart"),
      message: t("commands.restartConfirm"),
      confirmLabel: t("commands.restart"),
      danger: true,
    });
    if (!ok) return;
    await run("restart", "/api/restart", {}, "restart");
  }

  async function stop() {
    const ok = await confirm({
      title: t("commands.stop"),
      message: t("commands.stopConfirm", { seconds: wait }),
      confirmLabel: t("commands.stop"),
      danger: true,
    });
    if (!ok) return;
    await run("stop", "/api/rest/shutdown", { waittime: wait, message: stopMsg || t("commands.stopPlaceholder") }, "shutdown");
  }

  async function forceStop() {
    const ok = await confirm({
      title: t("commands.forceStop"),
      message: t("commands.forceStopConfirm"),
      confirmLabel: t("commands.forceStop"),
      danger: true,
    });
    if (!ok) return;
    await run("stop", "/api/rest/stop", {}, "stop");
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* ---------------------------------------------------------- announce */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("commands.announceTitle")}</CardTitle>
            <CardDescription>Shown to everyone currently connected.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Labelled label={t("commands.announceMessage")}>
            <input
              className={inputCls}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") announce(); }}
              placeholder="Server restarting in 10 minutes"
            />
          </Labelled>
          <Button variant="primary" size="sm" loading={busy === "announce"} onClick={announce}>
            <Bell /> {t("commands.announce")}
          </Button>
        </CardContent>
      </Card>

      {/* -------------------------------------------------------- moderation */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("commands.modTitle")}</CardTitle>
            <CardDescription>
              By user ID. The Players page does the same thing by name.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Labelled label={t("commands.userId")}>
              <input
                className={cn(inputCls, "num font-mono")}
                value={uid}
                onChange={(e) => setUid(e.target.value)}
                placeholder={t("commands.userIdPlaceholder")}
              />
            </Labelled>
            <Labelled label={t("commands.reason")} hint="Shown to the player where the game supports it.">
              <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Labelled>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" loading={busy === "kick"} onClick={() => mod("kick")}>
              <LogOut /> {t("commands.kick")}
            </Button>
            <Button variant="danger" size="sm" loading={busy === "ban"} onClick={() => mod("ban")}>
              <Ban /> {t("commands.ban")}
            </Button>
            <Button variant="ghost" size="sm" loading={busy === "unban"} onClick={() => mod("unban")}>
              <UserCheck /> {t("commands.unban")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------- world */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("commands.worldTitle")}</CardTitle>
            <CardDescription>
              Force a save now. The world also autosaves on its own schedule.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Button variant="secondary" size="sm" loading={busy === "save"} onClick={saveWorld}>
            <Save /> {t("commands.saveWorld")}
          </Button>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------- power */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("commands.powerTitle")}</CardTitle>
            <CardDescription>{t("commands.powerNote")}</CardDescription>
          </div>
          <Badge tone="warn">game only</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {canRestart ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" loading={busy === "restart"} onClick={restart}>
                <RotateCcw /> {t("commands.restart")}
              </Button>
              <span className="text-2xs text-faint">Comes back by itself.</span>
            </div>
          ) : (
            <p className="text-2xs text-faint">
              Restarting the game needs the “edit settings” permission.
            </p>
          )}

          {/* Heading before the fields it explains — the previous layout put the
              inputs above their own title. */}
          <div className="space-y-3 border-t border-line/60 pt-4">
            <div>
              <h4 className="text-sm font-medium">{t("commands.stop")}</h4>
              <p className="mt-0.5 text-2xs text-muted">
                Stops the game gracefully after the wait below. The VM stays on, so this does not
                stop billing — use the power button on the Console for that.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
              <Labelled label={t("commands.waitSeconds")}>
                <input
                  className={cn(inputCls, "num font-mono")}
                  type="number"
                  min={0}
                  value={wait}
                  onChange={(e) => setWait(Number(e.target.value) || 0)}
                />
              </Labelled>
              <Labelled label={t("commands.stopMessage")}>
                <input
                  className={inputCls}
                  value={stopMsg}
                  onChange={(e) => setStopMsg(e.target.value)}
                  placeholder={t("commands.stopPlaceholder")}
                />
              </Labelled>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" size="sm" loading={busy === "stop"} onClick={stop}>
                <Square /> {t("commands.stop")}
              </Button>
              <Button variant="ghost" size="sm" onClick={forceStop}>
                <ShieldCheck /> {t("commands.forceStop")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

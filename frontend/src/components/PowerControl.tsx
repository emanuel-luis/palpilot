// The signature element — a physical-feeling power button + status ring +
// three instrument gauges. This is where the 2–3 minute wait becomes legible.

import { cn } from "@/lib/cn";
import { t } from "@/i18n/en";
import { formatDuration } from "@/lib/format";
import { GameState } from "./StatusPills";
import { session } from "@/stores/session";
import { confirm } from "./ui/Confirm";
import { toast } from "./ui/Toast";
import { useStartVm, useStopVm } from "@/hooks/queries";
import { useEffect, useState } from "react";

interface Props {
  vmStatus: string;
  gameState: GameState;
  serverName?: string;
  metrics?: { currentplayernum: number; maxplayernum: number; uptime: number; days: number } | null;
  ip: string;
  port: string;
}

function PowerGlyph() {
  return (
    <svg className="power-glyph" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3v9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M6.5 7A8 8 0 1 0 17.5 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function PowerControl({ vmStatus, gameState, serverName, metrics, ip, port }: Props) {
  const canPower = session.can("power");
  const startM = useStartVm();
  const stopM = useStopVm();

  const transitional = /STAGING|PROVISIONING|STOPPING|REPAIRING|SUSPEND/i.test(vmStatus);
  const busy = startM.isPending || stopM.isPending || transitional;

  const [pressStart, setPressStart] = useState<number | null>(null);
  useEffect(() => {
    if (gameState === "starting" && pressStart == null) setPressStart(Date.now());
    if (gameState === "online" || gameState === "offline") setPressStart(null);
  }, [gameState]);

  const state = gameState === "online" ? "on" : gameState === "starting" ? "starting" : "off";

  async function onClick() {
    if (!canPower) { toast.warn(t("console.hero.noPower")); return; }
    if (busy) return;
    if (gameState === "offline") {
      const r = await startM.mutateAsync();
      if (!r.ok) toast.err(r.error || t("console.hero.startFailed"));
      else toast.ok(t("console.hero.startingHint"));
    } else if (gameState === "online") {
      const ok = await confirm({
        title: t("console.hero.stop"),
        message: t("console.hero.confirmStop"),
        confirmLabel: t("console.hero.stop"),
        danger: true,
      });
      if (!ok) return;
      const r = await stopM.mutateAsync();
      if (!r.ok) toast.err(r.error || t("console.hero.stopFailed"));
      else toast.ok(t("console.hero.stoppingHint"));
    }
  }

  const label =
    gameState === "online" ? t("console.hero.stop")
    : gameState === "starting" ? t("console.hero.restarting")
    : transitional ? t("console.hero.transitioning", { status: vmStatus })
    : t("console.hero.start");

  const hint =
    gameState === "online" ? t("console.hero.onlineHint")
    : gameState === "starting" ? t("console.hero.startingHint")
    : transitional ? t("console.hero.transitioning", { status: vmStatus })
    : t("console.hero.offlineHint");

  const players = metrics ? `${metrics.currentplayernum} / ${metrics.maxplayernum}` : "—";
  const uptime = metrics ? formatDuration(metrics.uptime) : "—";
  const day = metrics ? String(metrics.days) : "—";
  const addr = ip ? `${ip}:${port || "8211"}` : "";

  async function copyAddr() {
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      toast.ok(t("console.join.copied"));
    } catch {
      const ta = document.createElement("textarea");
      ta.value = addr; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast.ok(t("console.join.copied")); }
      catch { toast.err(t("console.join.copyFailed")); }
      ta.remove();
    }
  }

  return (
    <div className="power-console">
      <button
        className={cn("power-btn", `state-${state}`)}
        onClick={onClick}
        disabled={!canPower || busy}
        aria-label={label}
        title={canPower ? label : t("console.hero.noPower")}
      >
        <span className="power-ring" aria-hidden />
        <PowerGlyph />
      </button>
      <div className="power-meta">
        <div className="power-servername">{serverName || t("console.hero.title")}</div>
        <div className="power-state-line">
          <strong style={{ color: "var(--ink)" }}>{label}</strong>
          <span>·</span>
          <span>{hint}</span>
        </div>

        <div className="gauges">
          <div>
            <div className="gauge-label">{t("console.gauges.players")}</div>
            <div className={cn("gauge-value", !metrics && "dim")}>{players}</div>
          </div>
          <div>
            <div className="gauge-label">{t("console.gauges.uptime")}</div>
            <div className={cn("gauge-value mono", !metrics && "dim")}>{uptime}</div>
          </div>
          <div>
            <div className="gauge-label">{t("console.gauges.day")}</div>
            <div className={cn("gauge-value mono", !metrics && "dim")}>{day}</div>
          </div>
        </div>

        <button
          className="join"
          onClick={copyAddr}
          disabled={!addr}
          aria-label={addr ? `${t("console.join.label")}: ${addr}. ${t("console.join.hint")}` : t("console.join.unknown")}
        >
          <span className="join-label">{t("console.join.label")}</span>
          <span className="join-addr mono">{addr || t("console.join.unknown")}</span>
          <span className="join-hint">{addr ? t("console.join.hint") : ""}</span>
        </button>
      </div>
    </div>
  );
}

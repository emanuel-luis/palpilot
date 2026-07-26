// The Console hero: power button, live state, three gauges, join address.
// Markup matches styles.css (.power-console / .power-btn / .power-ring /
// .power-glyph / .power-meta / .gauges / .join).
//
// Deliberately NOT gated on `view`: `power` is the only permission a user needs
// to turn the machine on, and gating the hero on `view` left power-only users
// staring at an empty page.
import { useState } from "react";
import { usePower } from "@/hooks/queries";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm } from "./ui/Confirm";
import { t } from "@/i18n/en";
import { formatDuration } from "@/lib/format";
import { GameState } from "./StatusPills";
import { cn } from "@/lib/cn";

// Wire names, verbatim from the game's REST API: all lowercase, no underscores.
type Metrics = {
  serverfps?: number;
  serverframetime?: number;
  currentplayernum?: number;
  maxplayernum?: number;
  uptime?: number;
  days?: number;
};

const DASH = "—";

export function PowerControl({ vmStatus, gameState, serverName, metrics, ip, port, playerCount }: {
  vmStatus: string;
  gameState: GameState;
  serverName?: string;
  metrics: Metrics | null;
  ip?: string;
  port?: string;
  playerCount?: number;
}) {
  const canPower = session.can("power");
  const power = usePower();
  const [copied, setCopied] = useState(false);

  const busy = gameState === "starting" || gameState === "stopping" || power.isPending;
  // .power-btn state modifiers in styles.css are on/off/starting.
  const stateClass = gameState === "online" ? "state-on" : gameState === "offline" ? "state-off" : "state-starting";

  const label =
    gameState === "online" ? t("console.hero.stop")
    : gameState === "starting" ? t("status.game.starting")
    : gameState === "stopping" ? t("status.game.stopping")
    : t("console.hero.start");

  const stateLine =
    gameState === "online" ? t("console.hero.onlineHint")
    : gameState === "starting" ? t("console.hero.startingHint")
    : gameState === "stopping" ? t("console.hero.stoppingHint")
    : t("console.hero.offlineHint");

  async function click() {
    if (!canPower || busy) return;
    if (gameState === "online") {
      const n = playerCount ?? 0;
      const ok = await confirm({
        title: t("console.hero.confirmStopTitle"),
        message: n > 0 ? t("console.hero.confirmStopPlayers", { count: n }) : t("console.hero.confirmStop"),
        confirmLabel: t("console.hero.stop"),
        danger: true,
      });
      if (!ok) return;
      const r = await power.mutateAsync("stop");
      if (!r.ok) toast.err(r.error || t("console.hero.stopFailed"));
      else toast.ok(t("console.hero.stoppingHint"));
    } else if (gameState === "offline") {
      const r = await power.mutateAsync("start");
      if (!r.ok) {
        if (r.status === 409) toast.err(t("console.hero.alreadyOn"));
        else toast.err(r.error || t("console.hero.startFailed"));
      } else toast.ok(t("console.hero.startingHint"));
    }
  }

  const address = ip ? `${ip}:${port || "8211"}` : "";

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // Clipboard API needs a secure context; fall back to a scratch textarea.
      try {
        const ta = document.createElement("textarea");
        ta.value = address;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      } catch {
        toast.err(t("console.join.copyFailed"));
        return;
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
    toast.ok(t("console.join.copied"));
  }

  const online = gameState === "online";
  const players = online && metrics
    ? `${metrics.currentplayernum ?? 0}/${metrics.maxplayernum ?? 0}`
    : DASH;
  const uptime = online && metrics?.uptime != null ? formatDuration(metrics.uptime) : DASH;
  const day = online && metrics?.days != null ? String(metrics.days) : DASH;

  return (
    <div>
      <div className="power-console">
        <button
          className={cn("power-btn", stateClass)}
          disabled={!canPower || busy}
          onClick={click}
          aria-label={label}
          title={canPower ? label : t("console.hero.noPower")}
        >
          <span className="power-ring" aria-hidden />
          <span className="power-glyph" aria-hidden>{online ? "■" : "⏻"}</span>
        </button>
        <div className="power-meta">
          <div className="power-servername">{serverName || t("app.name")}</div>
          <div className="power-state-line">
            <strong>{label}</strong>
            <span className="mono">{vmStatus || t("common.unknown")}</span>
          </div>
          <div className="field-hint">{stateLine}</div>
          {!canPower && <div className="field-hint">{t("console.hero.noPower")}</div>}
        </div>
      </div>

      <div className="gauges">
        <div>
          <div className="gauge-label">{t("console.gauges.players")}</div>
          <div className={cn("gauge-value", !online && "dim")}>{players}</div>
        </div>
        <div>
          <div className="gauge-label">{t("console.gauges.uptime")}</div>
          <div className={cn("gauge-value", !online && "dim")}>{uptime}</div>
        </div>
        <div>
          <div className="gauge-label">{t("console.gauges.day")}</div>
          <div className={cn("gauge-value", !online && "dim")}>{day}</div>
        </div>
      </div>

      <button
        type="button"
        className="join"
        onClick={copyAddress}
        disabled={!address}
        aria-label={`${t("console.join.label")}: ${address || t("console.join.unknown")}`}
      >
        <span className="join-label">{t("console.join.label")}</span>
        <span className="join-addr">{address || t("console.join.unknown")}</span>
        <span className="join-hint">{copied ? `✓ ${t("console.join.copied")}` : t("console.join.hint")}</span>
      </button>
    </div>
  );
}

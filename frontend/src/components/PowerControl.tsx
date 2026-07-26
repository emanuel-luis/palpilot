import { useOverview, usePower } from "@/hooks/queries";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm } from "./ui/Confirm";
import { t } from "@/i18n/en";
import { GameState } from "./StatusPills";
import { cn } from "@/lib/cn";

type Metrics = { server_fps?: number; server_frame_time?: number; max_player_num?: number; current_player_num?: number };

export function PowerControl({ vmStatus, gameState, serverName, metrics, ip, port }: {
  vmStatus: string; gameState: GameState; serverName?: string; metrics: Metrics | null; ip?: string; port?: string;
}) {
  const canPower = session.can("power");
  const power = usePower();
  const ov = useOverview();

  const transitioning = gameState === "starting" || gameState === "stopping";
  const label = gameState === "online" ? t("power.stop")
    : gameState === "starting" ? t("power.starting")
    : gameState === "stopping" ? t("power.stopping")
    : t("power.start");

  async function click() {
    if (!canPower || transitioning) return;
    if (gameState === "online") {
      const players = (ov.data?.data as any)?.server?.players?.length || 0;
      const ok = await confirm({
        title: t("power.stopTitle"),
        message: players > 0 ? t("power.stopConfirmPlayers", { count: players }) : t("power.stopConfirm"),
        confirmLabel: t("power.stop"), danger: true,
      });
      if (!ok) return;
      const r = await power.mutateAsync("stop");
      if (!r.ok) toast.err(r.error || t("power.stopFailed"));
      else toast.ok(t("power.stopStarted"));
    } else if (gameState === "offline") {
      const r = await power.mutateAsync("start");
      if (!r.ok) {
        if (r.status === 409) toast.err(t("power.alreadyOn"));
        else toast.err(r.error || t("power.startFailed"));
      } else toast.ok(t("power.startStarted"));
    }
  }

  const fps = metrics?.server_fps;
  const ft = metrics?.server_frame_time;
  const current = metrics?.current_player_num ?? 0;
  const max = metrics?.max_player_num ?? 0;

  return (
    <div className="power">
      <div className="power-left">
        <button className={cn("power-btn", `state-${gameState}`)}
          disabled={!canPower || transitioning}
          onClick={click}
          aria-label={label} title={label}>
          <span className="power-btn-ring" aria-hidden />
          <span className="power-btn-glyph" aria-hidden>{gameState === "online" ? "■" : "▶"}</span>
        </button>
        <div className="power-status">
          <div className="power-status-label">{label}</div>
          <div className="field-hint mono">{vmStatus}</div>
        </div>
      </div>
      <div className="power-right">
        <div className="metric">
          <div className="metric-label">{t("metric.name")}</div>
          <div className="metric-value" style={{ fontFamily: "inherit", fontSize: 18 }}>{serverName || "—"}</div>
        </div>
        <div className="metric">
          <div className="metric-label">{t("metric.players")}</div>
          <div className="metric-value">{gameState === "online" ? `${current}/${max}` : "—"}</div>
        </div>
        <div className="metric">
          <div className="metric-label">{t("metric.fps")}</div>
          <div className="metric-value">{fps != null ? Math.round(fps) : "—"}</div>
        </div>
        <div className="metric">
          <div className="metric-label">{t("metric.frameMs")}</div>
          <div className="metric-value">{ft != null ? ft.toFixed(1) : "—"}</div>
        </div>
        <div className="metric">
          <div className="metric-label">{t("metric.endpoint")}</div>
          <div className="metric-value" style={{ fontSize: 16 }}>{ip ? `${ip}:${port || "8211"}` : "—"}</div>
        </div>
      </div>
    </div>
  );
}

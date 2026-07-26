import { cn } from "@/lib/cn";
import { t } from "@/i18n/en";

export type GameState = "offline" | "starting" | "online";

export function deriveGameState(vmStatus: string, hasInfo: boolean): GameState {
  if (vmStatus !== "RUNNING") return "offline";
  if (!hasInfo) return "starting";
  return "online";
}

interface Props {
  vmStatus: string;
  gameState: GameState;
}

export function StatusPills({ vmStatus, gameState }: Props) {
  const vmOn = vmStatus === "RUNNING";
  const vmTransitional = /STAGING|PROVISIONING|STOPPING|REPAIRING|SUSPEND/i.test(vmStatus);
  const vmClass = vmOn ? "pill-on" : vmTransitional ? "pill-warn" : "pill-off";
  const vmText = (t as any)(`status.vm.${vmStatus}`) !== `status.vm.${vmStatus}` ? (t as any)(`status.vm.${vmStatus}`) : vmStatus;

  const gameCls = gameState === "online" ? "pill-on" : gameState === "starting" ? "pill-warn" : "pill-off";
  const gameText = t(`status.game.${gameState}` as any);

  return (
    <div className="row-tight" style={{ gap: 8 }}>
      <span className={cn("pill", vmClass)} title={t("header.vmTooltip")} aria-label={`${t("header.vmLabel")} ${vmText}`}>
        <span className="dot" />
        <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>{t("header.vmLabel")}</span>
        <span>{vmText}</span>
      </span>
      <span className={cn("pill", gameCls)} title={t("header.serverTooltip")} aria-label={`${t("header.serverLabel")} ${gameText}`}>
        <span className="dot" />
        <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>{t("header.serverLabel")}</span>
        <span>{gameText}</span>
      </span>
    </div>
  );
}

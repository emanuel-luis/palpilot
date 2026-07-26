import { t } from "@/i18n/en";
import { cn } from "@/lib/cn";

export type GameState = "offline" | "starting" | "online" | "stopping";

export function deriveGameState(vmStatus: string, hasInfo: boolean): GameState {
  const s = (vmStatus || "").toUpperCase();
  if (s === "RUNNING" && hasInfo) return "online";
  if (s === "PROVISIONING" || s === "STAGING" || (s === "RUNNING" && !hasInfo)) return "starting";
  if (s === "STOPPING" || s === "SUSPENDING" || s === "REPAIRING") return "stopping";
  return "offline";
}

const VM_LABEL: Record<string, string> = {
  TERMINATED: "vm.off", RUNNING: "vm.on",
  PROVISIONING: "vm.starting", STAGING: "vm.starting", REPAIRING: "vm.starting",
  STOPPING: "vm.stopping", SUSPENDING: "vm.stopping",
};

export function StatusPills({ vmStatus, gameState }: { vmStatus: string; gameState: GameState }) {
  const vmKey = VM_LABEL[(vmStatus || "").toUpperCase()] || "vm.unknown";
  const vmTone = vmKey === "vm.on" ? "pill-on" : vmKey === "vm.off" ? "pill-off" : "pill-warn";
  const gameTone = gameState === "online" ? "pill-on" : gameState === "offline" ? "pill-off" : "pill-warn";
  return (
    <div className="row-tight">
      <span className={cn("pill", vmTone)}><span className="dot" />{t("statusLabel.vm")}: {t(vmKey as any)}</span>
      <span className={cn("pill", gameTone)}><span className="dot" />{t("statusLabel.game")}: {t(`game.${gameState}` as any)}</span>
    </div>
  );
}

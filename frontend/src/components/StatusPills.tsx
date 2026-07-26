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

// en.ts keys `status.vm.*` are keyed by the RAW GCE status string the coordinator
// returns, so look them up directly rather than through an intermediate slug.
const VM_STATES = [
  "RUNNING", "TERMINATED", "STAGING", "PROVISIONING",
  "STOPPING", "REPAIRING", "SUSPENDING", "SUSPENDED",
] as const;

function vmLabel(raw: string): string {
  const s = (raw || "").toUpperCase();
  return (VM_STATES as readonly string[]).includes(s)
    ? t(`status.vm.${s}` as any)
    : t("common.unknown");
}

export function StatusPills({ vmStatus, gameState }: { vmStatus: string; gameState: GameState }) {
  const s = (vmStatus || "").toUpperCase();
  const vmTone = s === "RUNNING" ? "pill-on" : s === "TERMINATED" || !s ? "pill-off" : "pill-warn";
  const gameTone = gameState === "online" ? "pill-on" : gameState === "offline" ? "pill-off" : "pill-warn";
  return (
    <div className="row-tight">
      <span className={cn("pill", vmTone)} title={t("header.vmTooltip")}>
        <span className="dot" />{t("header.vmLabel")}: {vmLabel(vmStatus)}
      </span>
      <span className={cn("pill", gameTone)} title={t("header.serverTooltip")}>
        <span className="dot" />{t("header.serverLabel")}: {t(`status.game.${gameState}` as any)}
      </span>
    </div>
  );
}

import { useOverview } from "@/hooks/queries";
import { StatusPills, deriveGameState } from "@/components/StatusPills";
import { PowerControl } from "@/components/PowerControl";
import { PlayersTable } from "@/components/PlayersTable";
import { Section } from "@/components/Section";
import { SavesSection } from "@/components/SavesSection";
import { SettingsSection } from "@/components/SettingsSection";
import { ModsSection } from "@/components/ModsSection";
import { CommandsSection } from "@/components/CommandsSection";
import { WatchdogSection } from "@/components/WatchdogSection";
import { session, useSession } from "@/stores/session";
import { t } from "@/i18n/en";

export function ConsoleView() {
  const q = useOverview();
  useSession();

  const body: any = q.data?.data || {};
  // /api/overview answers 200-with-ok:false when the cloud status check fails, and
  // that branch carries no `server` key at all — so trust data.ok, not res.ok, and
  // don't invent "TERMINATED" for a status we simply don't know (a power-only user
  // has no `view` permission and gets a 403 here).
  const known = q.data?.ok === true;
  const vm = body.vm || {};
  const vmStatus: string = known || body.vm ? vm.status || "" : "";
  const server = body.server;
  const gameState = deriveGameState(vmStatus, !!server?.info);
  const online = gameState === "online";
  const players: any[] = server?.players || [];

  const lock = (action: string) => (!online ? t("console.startFirst", { action }) : undefined);

  return (
    <div className="stack-lg">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{t("nav.console")}</h1>
        <StatusPills vmStatus={vmStatus} gameState={gameState} />
      </div>

      {/* Ungated on purpose: `power` alone must be enough to reach this. */}
      <PowerControl
        vmStatus={vmStatus}
        gameState={gameState}
        serverName={server?.info?.servername}
        metrics={server?.metrics || null}
        ip={vm.ip}
        port={vm.game_port}
        playerCount={players.length}
      />

      {session.can("view") && (
        <Section title={`${t("console.sections.players")} · ${online ? players.length : 0}`}>
          <PlayersTable players={players} serverOn={online} />
        </Section>
      )}
      {session.can("view") && (
        <Section title={t("console.sections.saves")} locked={lock(t("console.startFirstAction.saves"))}>
          <SavesSection />
        </Section>
      )}
      {session.can("view") && (
        <Section title={t("console.sections.settings")} defaultOpen={false} locked={lock(t("console.startFirstAction.settings"))}>
          <SettingsSection />
        </Section>
      )}
      {session.can("view") && (
        <Section title={t("console.sections.mods")} defaultOpen={false} locked={lock(t("console.startFirstAction.mods"))}>
          <ModsSection />
        </Section>
      )}
      {session.can("commands") && (
        <Section title={t("console.sections.commands")} defaultOpen={false} locked={lock(t("console.startFirstAction.commands"))}>
          <CommandsSection />
        </Section>
      )}
      {/* Watchdog config lives in cloud storage, so it works while the VM is off. */}
      {session.can("view") && (
        <Section title={t("console.sections.watchdog")} defaultOpen={false}>
          <WatchdogSection />
        </Section>
      )}
    </div>
  );
}

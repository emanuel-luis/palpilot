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
  const data: any = (q.data?.data as any) || { vm: { status: "TERMINATED", ip: "", game_port: "8211" }, server: null };
  const vm = data.vm || { status: "TERMINATED" };
  const server = data.server;
  const gameState = deriveGameState(vm.status, !!server?.info);
  const online = gameState === "online";
  const lock = (action: string) => !online && t("console.startFirst", { action });

  return (
    <div className="stack-lg">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{t("nav.console")}</h1>
        <StatusPills vmStatus={vm.status} gameState={gameState} />
      </div>
      <PowerControl vmStatus={vm.status} gameState={gameState} serverName={server?.info?.servername} metrics={server?.metrics || null} ip={vm.ip} port={vm.game_port} />
      {session.can("view") && (
        <Section title={`${t("console.sections.players")}${server?.players ? ` · ${server.players.length}` : ""}`}>
          <PlayersTable players={server?.players || []} serverOn={online} />
        </Section>
      )}
      {session.can("view") && <Section title={t("console.sections.saves")} locked={lock(t("console.sections.saves"))}><SavesSection /></Section>}
      {session.can("view") && <Section title={t("console.sections.settings")} defaultOpen={false} locked={lock(t("console.sections.settings"))}><SettingsSection /></Section>}
      {session.can("view") && <Section title={t("console.sections.mods")} defaultOpen={false} locked={lock(t("console.sections.mods"))}><ModsSection /></Section>}
      {session.can("commands") && <Section title={t("console.sections.commands")} defaultOpen={false} locked={lock(t("console.sections.commands"))}><CommandsSection /></Section>}
      {session.can("view") && <Section title={t("console.sections.watchdog")} defaultOpen={false}><WatchdogSection /></Section>}
    </div>
  );
}

import { useOverview, useSaves, isOffline } from "@/hooks/queries";
import { deriveGameState } from "@/components/StatusPills";
import { IgnitionModule } from "@/components/console/IgnitionModule";
import { PlayersTable } from "@/components/PlayersTable";
import { Section } from "@/components/Section";
import { SavesSection } from "@/components/SavesSection";
import { SettingsSection } from "@/components/SettingsSection";
import { ModsSection } from "@/components/ModsSection";
import { CommandsSection } from "@/components/CommandsSection";
import { WatchdogSection } from "@/components/WatchdogSection";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { session, useSession } from "@/stores/session";
import { t } from "@/i18n/en";

export function ConsoleView() {
  const q = useOverview();
  const saves = useSaves();
  useSession();

  const body: any = q.data?.data || {};
  // /api/overview answers 200-with-ok:false when the cloud status check fails,
  // and that branch carries no `server` key — so trust data.ok, not res.ok, and
  // don't invent "TERMINATED" for a status we simply don't know (a power-only
  // user has no `view` permission and gets a 403 here).
  const vm = body.vm || {};
  const vmStatus: string = body.vm ? vm.status || "" : "";
  const server = body.server;
  const metrics = server?.metrics;
  const gameState = deriveGameState(vmStatus, !!server?.info);
  const online = gameState === "online";
  const players: any[] = server?.players || [];

  const activeSave = !isOffline(saves.data)
    ? (saves.data as any)?.slots?.find((s: any) => s.active)?.name
    : undefined;

  const lock = (action: string) => (!online ? t("console.startFirst", { action }) : undefined);

  return (
    <>
      <IgnitionModule
        vmStatus={vmStatus}
        gameState={gameState}
        serverName={server?.info?.servername || activeSave}
        uptime={metrics?.uptime ?? null}
        players={metrics?.currentplayernum ?? (online ? players.length : null)}
        maxPlayers={metrics?.maxplayernum ?? null}
        day={metrics?.days ?? null}
        ip={vm.ip}
        port={vm.game_port}
      />

      {session.can("view") ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Players{online ? <span className="ml-2 font-mono text-xs text-faint">{players.length}</span> : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <PlayersTable players={players} serverOn={online} />
          </CardContent>
        </Card>
      ) : null}

      {/* Not yet migrated to the token system — these still render through the
          legacy stylesheet while each one is redesigned in turn. */}
      {session.can("view") ? (
        <Section title={t("console.sections.saves")} locked={lock(t("console.startFirstAction.saves"))}>
          <SavesSection />
        </Section>
      ) : null}
      {session.can("view") ? (
        <Section title={t("console.sections.settings")} defaultOpen={false} locked={lock(t("console.startFirstAction.settings"))}>
          <SettingsSection />
        </Section>
      ) : null}
      {session.can("view") ? (
        <Section title={t("console.sections.mods")} defaultOpen={false} locked={lock(t("console.startFirstAction.mods"))}>
          <ModsSection />
        </Section>
      ) : null}
      {session.can("commands") ? (
        <Section title={t("console.sections.commands")} defaultOpen={false} locked={lock(t("console.startFirstAction.commands"))}>
          <CommandsSection />
        </Section>
      ) : null}
      {/* Watchdog config lives in cloud storage, so it works while the VM is off. */}
      {session.can("view") ? (
        <Section title={t("console.sections.watchdog")} defaultOpen={false}>
          <WatchdogSection />
        </Section>
      ) : null}
    </>
  );
}

// Thin page wrappers around the section components that have not been redesigned
// yet. They still render through the legacy stylesheet; splitting them into pages
// first means the routing and information architecture are correct now, and each
// section can be restyled in place afterwards without moving anything.
import { PageHeader, OfflineNotice } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { useOverview } from "@/hooks/queries";
import { deriveGameState } from "@/components/StatusPills";
import { PlayersTable } from "@/components/PlayersTable";
import { SavesSection } from "@/components/SavesSection";
import { SettingsSection } from "@/components/SettingsSection";
import { ModsSection } from "@/components/ModsSection";
import { CommandsSection } from "@/components/CommandsSection";
import { WatchdogSection } from "@/components/WatchdogSection";

function useServerState() {
  const q = useOverview();
  const body: any = q.data?.data || {};
  const vm = body.vm || {};
  const server = body.server;
  const gameState = deriveGameState(vm.status || "", !!server?.info);
  return { gameState, online: gameState === "online", server, vm };
}

export function PlayersPage() {
  const { online, server } = useServerState();
  const players: any[] = server?.players || [];
  return (
    <>
      <PageHeader
        title="Players"
        description="Everyone connected right now. Moderation needs the commands permission."
      />
      <Card>
        <CardContent className="pt-4">
          <PlayersTable players={players} serverOn={online} />
        </CardContent>
      </Card>
    </>
  );
}

export function CommandsPage() {
  const { online } = useServerState();
  return (
    <>
      <PageHeader
        title="Commands"
        description="In-game actions. These affect the game process only — the VM keeps running, and keeps billing."
      />
      {online ? <CommandsSection /> : <OfflineNotice action="send commands" />}
    </>
  );
}

export function SavesPage() {
  const { online } = useServerState();
  return (
    <>
      <PageHeader
        title="Saves"
        description="Each save keeps its own settings and mods, and they travel with it when you clone or switch. Backups live under the save they belong to."
      />
      {online ? <SavesSection /> : <OfflineNotice action="manage saves" />}
    </>
  );
}

export function SettingsPage() {
  const { online } = useServerState();
  return (
    <>
      <PageHeader
        title="Server settings"
        description="PalWorldSettings.ini for the active save. Edit as many fields as you like, then apply them together."
      />
      {online ? <SettingsSection /> : <OfflineNotice action="edit settings" />}
    </>
  );
}

export function ModsPage() {
  const { online } = useServerState();
  return (
    <>
      <PageHeader
        title="Mods"
        description="Native .pak and LogicMods always work. Script mods need the Proton runtime, which is an infrastructure setting."
      />
      {online ? <ModsSection /> : <OfflineNotice action="manage mods" />}
    </>
  );
}

export function WatchdogPage() {
  return (
    <>
      <PageHeader
        title="Automatic shutdown"
        description="Powers the VM off once it has been empty for the grace period. This is the mechanism that keeps the bill small."
      />
      <Card>
        <CardContent>
          {/* Config lives in cloud storage, not on the VM, so this keeps working
              while the server is off. */}
          <WatchdogSection />
        </CardContent>
      </Card>
    </>
  );
}

// The landing page. Now that saves/settings/mods/commands have their own routes,
// Console is deliberately narrow: the ignition module, who's online, and a way
// into the places you'd go next. The most common session is open it, press power,
// copy the address, close the tab — so nothing else competes with that.
import { ArrowRight } from "lucide-react";
import { useOverview, useSaves, isOffline } from "@/hooks/queries";
import { deriveGameState } from "@/components/StatusPills";
import { IgnitionModule } from "@/components/console/IgnitionModule";
import { PlayersTable } from "@/components/PlayersTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { session, useSession } from "@/stores/session";
import { navigate } from "@/hooks/useHashRoute";

const SHORTCUTS: { label: string; route: string; perm: string; hint: string }[] = [
  { label: "Saves", route: "/saves", perm: "view", hint: "Switch, clone or import a world" },
  { label: "Server settings", route: "/settings", perm: "view", hint: "Rates, difficulty, limits" },
  { label: "Mods", route: "/mods", perm: "view", hint: "Install and toggle mods" },
  { label: "Logs", route: "/logs", perm: "view", hint: "Tail the server output" },
];

export function ConsoleView() {
  const q = useOverview();
  const saves = useSaves();
  useSession();

  const body: any = q.data?.data || {};
  // /api/overview answers 200-with-ok:false when the cloud status check fails,
  // and that branch carries no `server` key — so don't invent "TERMINATED" for a
  // status we simply don't know (a power-only user gets a 403 here).
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
              Players
              {online ? <span className="num ml-2 font-mono text-xs text-faint">{players.length}</span> : null}
            </CardTitle>
            {online && players.length ? (
              <Button variant="ghost" size="sm" onClick={() => navigate("/players")}>
                Manage <ArrowRight />
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="pt-0">
            <PlayersTable players={players} serverOn={online} />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SHORTCUTS.filter((s) => session.can(s.perm)).map((s) => (
          <button
            key={s.route}
            type="button"
            onClick={() => navigate(s.route)}
            className="group rounded-xl border border-line/60 bg-surface p-4 text-left shadow-soft transition-all duration-fast hover:border-signal/50 hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{s.label}</span>
              <ArrowRight className="size-4 text-faint transition-transform duration-fast group-hover:translate-x-0.5 group-hover:text-signal" aria-hidden />
            </div>
            <p className="mt-1 text-xs text-muted">{s.hint}</p>
          </button>
        ))}
      </div>
    </>
  );
}

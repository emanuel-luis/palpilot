// Dashboard shell: fixed sidebar, sticky topbar, scrolling content.
//
// The nav is the product's map, so it states the truth about what exists. Items
// whose backend isn't built are rendered `unavailable` — visible, focusable,
// explained on hover — rather than hidden (which hides the roadmap) or live
// (which fakes capability). Permission-gated items are hidden outright, because
// a control you can never use is noise, not information.
import { useEffect, useMemo, useState } from "react";
import {
  Activity, Archive, ClipboardList, Gauge, HardDriveDownload, Menu, Moon, Save,
  LogOut, ScrollText, Settings2, ShieldCheck, Sun, Terminal, UserRound, Users, X,
} from "lucide-react";
import { session, useSession } from "@/stores/session";
import { apiPost } from "@/lib/api";
import { navigate, useHashRoute } from "@/hooks/useHashRoute";
import { resolvedTheme, toggleTheme } from "@/lib/theme";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tip, TooltipProvider } from "@/components/ui/tooltip";
import type { GameState } from "@/components/StatusPills";

export type NavItem = {
  id: string;
  route: string;
  label: string;
  icon: typeof Gauge;
  /** Any one of these grants access. Empty = always visible. */
  perms: string[];
  /** Set when the feature has no backend yet; explains itself on hover. */
  unavailable?: string;
};

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Operate",
    items: [
      { id: "console", route: "/console", label: "Console", icon: Gauge, perms: ["view", "power"] },
      { id: "players", route: "/players", label: "Players", icon: Users, perms: ["view"] },
      { id: "commands", route: "/commands", label: "Commands", icon: Terminal, perms: ["commands"] },
    ],
  },
  {
    group: "World",
    items: [
      { id: "saves", route: "/saves", label: "Saves", icon: Save, perms: ["view"] },
      { id: "backups", route: "/backups", label: "Backups", icon: Archive, perms: ["view"] },
      { id: "settings", route: "/settings", label: "Server settings", icon: Settings2, perms: ["view"] },
      { id: "mods", route: "/mods", label: "Mods", icon: HardDriveDownload, perms: ["view"] },
    ],
  },
  {
    group: "Observe",
    items: [
      { id: "performance", route: "/performance", label: "Performance", icon: Activity, perms: ["view"] },
      { id: "logs", route: "/logs", label: "Logs", icon: ScrollText, perms: ["view"] },
      {
        id: "scheduler", route: "/scheduler", label: "Scheduler", icon: ClipboardList, perms: ["view"],
        unavailable: "Scheduled tasks need somewhere to store them. Not built yet.",
      },
    ],
  },
  {
    group: "Administration",
    items: [
      { id: "users", route: "/users", label: "Users & roles", icon: ShieldCheck, perms: ["users"] },
    ],
  },
];

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate: () => void }) {
  const Icon = item.icon;
  const body = (
    <a
      href={`#${item.route}`}
      aria-current={active ? "page" : undefined}
      aria-disabled={item.unavailable ? true : undefined}
      onClick={(e) => {
        e.preventDefault();
        if (item.unavailable) return;
        navigate(item.route);
        onNavigate();
      }}
      className={cn(
        "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-fast",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-signal/12 font-medium text-fg shadow-[inset_2px_0_0_0_hsl(var(--signal))]"
          : "text-muted hover:bg-surface-2 hover:text-fg",
        item.unavailable && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{item.label}</span>
      {item.unavailable ? <span className="ml-auto text-2xs uppercase text-faint">soon</span> : null}
    </a>
  );
  return item.unavailable ? <Tip label={item.unavailable}>{body}</Tip> : body;
}

export function AppShell({
  children,
  vmStatus,
  gameState,
  serverName,
  activeSave,
}: {
  children: React.ReactNode;
  vmStatus: string;
  gameState: GameState;
  serverName?: string;
  activeSave?: string;
}) {
  const s = useSession();
  const route = useHashRoute();
  const [drawer, setDrawer] = useState(false);
  const [, forceTheme] = useState(0);

  // Close the mobile drawer on route change so navigating doesn't leave it open.
  useEffect(() => setDrawer(false), [route]);

  const groups = useMemo(
    () =>
      NAV.map((g) => ({
        ...g,
        items: g.items.filter((i) => !i.perms.length || i.perms.some((p) => session.can(p))),
      })).filter((g) => g.items.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.perms, s.ready],
  );

  const tone = gameState === "online" ? "ok" : gameState === "offline" ? "neutral" : "warn";
  const stateLabel =
    gameState === "online" ? "Online"
    : gameState === "starting" ? "Starting"
    : gameState === "stopping" ? "Stopping"
    : "Offline";

  const dark = resolvedTheme() === "dark";

  return (
    <TooltipProvider delayDuration={250}>
      <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
        {/* ---------------------------------------------------------- sidebar */}
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col border-r border-line/60 bg-surface/80 backdrop-blur",
            "transition-transform duration-slow ease-out lg:static lg:translate-x-0",
            drawer ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex h-14 items-center gap-2 px-4">
            <span aria-hidden className="grid size-7 place-items-center rounded-md bg-signal/15 text-signal">
              <Gauge className="size-4" />
            </span>
            <span className="text-sm font-semibold tracking-tight">PalPilot</span>
            <Button
              size="icon"
              variant="ghost"
              className="ml-auto lg:hidden"
              aria-label="Close navigation"
              onClick={() => setDrawer(false)}
            >
              <X />
            </Button>
          </div>

          <nav className="flex-1 space-y-5 overflow-y-auto px-2 pb-4 scroll-y">
            {groups.map((g) => (
              <div key={g.group}>
                <div className="eyebrow px-3 pb-1">{g.group}</div>
                <div className="space-y-0.5">
                  {g.items.map((item) => (
                    <NavLink
                      key={item.id}
                      item={item}
                      active={route.startsWith(item.route)}
                      onNavigate={() => setDrawer(false)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </nav>

          {/* The cost lever, stated once where it can't be missed. */}
          <div className="border-t border-line/60 px-4 py-3 text-2xs leading-relaxed text-faint">
            Compute bills only while the VM runs. It powers itself off when empty.
          </div>
        </aside>

        {drawer ? (
          <div
            className="fixed inset-0 z-30 bg-black/50 lg:hidden"
            onClick={() => setDrawer(false)}
            aria-hidden
          />
        ) : null}

        {/* ------------------------------------------------------------ main */}
        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line/60 bg-bg/85 px-4 backdrop-blur">
            <Button
              size="icon"
              variant="ghost"
              className="lg:hidden"
              aria-label="Open navigation"
              aria-expanded={drawer}
              onClick={() => setDrawer(true)}
            >
              <Menu />
            </Button>

            {/* Two states, never conflated: the machine you pay for, and the game
                players connect to. The game needs ~2min after the VM is up. */}
            <Tip label={`Palworld process — what players connect to. VM: ${vmStatus || "unknown"}`}>
              <Badge tone={tone as never} dot pulse={gameState !== "online" && gameState !== "offline"}>
                {stateLabel}
              </Badge>
            </Tip>

            <div className="hidden min-w-0 sm:block">
              <div className="truncate text-sm font-medium">{serverName || "PalPilot"}</div>
              {activeSave ? (
                <div className="truncate text-2xs text-faint">
                  <span className="eyebrow">save</span> {activeSave}
                </div>
              ) : null}
            </div>

            <div className="ml-auto flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
                onClick={() => { toggleTheme(); forceTheme((v) => v + 1); }}
              >
                {dark ? <Sun /> : <Moon />}
              </Button>
              <Tip label="Account, password and sessions">
                <Button variant="ghost" size="sm" onClick={() => navigate("/account")}>
                  <UserRound /> <span className="hidden sm:inline">{s.user || "account"}</span>
                </Button>
              </Tip>
              <Tip label="Sign out of this device">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Sign out"
                  onClick={async () => {
                    // Best effort: the token is stateless, so drop it locally
                    // whatever the server says.
                    await apiPost("/api/logout");
                    session.clear();
                  }}
                >
                  <LogOut />
                </Button>
              </Tip>
            </div>
          </header>

          <main className="min-w-0 flex-1 px-4 py-5 lg:px-6">
            <div className="mx-auto w-full max-w-[1200px] space-y-5">{children}</div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

export { NAV };

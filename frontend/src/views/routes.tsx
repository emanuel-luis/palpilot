// Route table. One place that maps a hash route to a page, the permission that
// guards it, and how it loads.
//
// Every page except Console is lazy: the multi-file build (see vite.config.ts)
// finally makes code splitting possible, so a user who only ever presses the
// power button never downloads the settings editor or the log terminal. Console
// is eager because it is the landing page — lazy-loading it would put a spinner
// in front of the first thing everyone sees.
import { lazy } from "react";
import { ConsoleView } from "@/views/Console";

export type RouteDef = {
  route: string;
  /** Any one of these grants access. Empty = any authenticated user. */
  perms: string[];
  Component: React.ComponentType;
};

const Players = lazy(() => import("@/views/pages/sections").then((m) => ({ default: m.PlayersPage })));
const Commands = lazy(() => import("@/views/pages/sections").then((m) => ({ default: m.CommandsPage })));
const Saves = lazy(() => import("@/views/pages/sections").then((m) => ({ default: m.SavesPage })));
const Settings = lazy(() => import("@/views/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const Mods = lazy(() => import("@/views/pages/sections").then((m) => ({ default: m.ModsPage })));
const Watchdog = lazy(() => import("@/views/pages/sections").then((m) => ({ default: m.WatchdogPage })));
const Logs = lazy(() => import("@/views/pages/LogsPage").then((m) => ({ default: m.LogsPage })));
const Performance = lazy(() => import("@/views/pages/PerformancePage").then((m) => ({ default: m.PerformancePage })));
const Users = lazy(() => import("@/views/Users").then((m) => ({ default: m.UsersView })));
const Account = lazy(() => import("@/views/Account").then((m) => ({ default: m.AccountView })));

// Order matters: matched by prefix, longest first, so /settings never shadows
// something nested under it later.
export const ROUTES: RouteDef[] = [
  { route: "/console", perms: ["view", "power"], Component: ConsoleView },
  { route: "/players", perms: ["view"], Component: Players },
  { route: "/commands", perms: ["commands"], Component: Commands },
  { route: "/saves", perms: ["view"], Component: Saves },
  { route: "/settings", perms: ["view"], Component: Settings },
  { route: "/mods", perms: ["view"], Component: Mods },
  { route: "/watchdog", perms: ["view"], Component: Watchdog },
  { route: "/performance", perms: ["view"], Component: Performance },
  { route: "/logs", perms: ["view"], Component: Logs },
  { route: "/users", perms: ["users"], Component: Users },
  { route: "/account", perms: [], Component: Account },
];

export function matchRoute(path: string): RouteDef | undefined {
  return [...ROUTES]
    .sort((a, b) => b.route.length - a.route.length)
    .find((r) => path === r.route || path.startsWith(`${r.route}/`));
}

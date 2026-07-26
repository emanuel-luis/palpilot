// Mock state. Mutating handlers write here; a "reset" wipes back to seed.

export type Slot = {
  guid: string; name: string; created: number; active: boolean;
  size: number; empty: boolean; last_backup: number | null;
  pending?: boolean;
};
export type Backup = {
  ref: string; file: string; size: number; created: number;
  location: "local" | "remote"; uri?: string;
};
export type ModRow = {
  name: string; type: "pak" | "logic" | "ue4ss";
  size: number; enabled: boolean; source_url?: string; installed_at: number;
};
export type Player = {
  name: string; accountName: string; playerId: string; userId: string;
  ip: string; ping: number; level: number;
  location_x: number; location_y: number;
};
export type UserRow = {
  username: string; role: string; perms: string[]; effective_perms: string[];
  password?: string;
};
export type RoleRow = { name: string; perms: string[]; builtin: boolean };

const ALL_PERMS = ["view", "power", "saves", "mods", "settings", "watchdog", "commands", "users"];
const ROLE_BUNDLES: Record<string, string[]> = {
  owner: [...ALL_PERMS],
  operator: ["view","power","saves","mods","settings","watchdog","commands"],
  moderator: ["view","commands"],
  viewer: ["view"],
};

function seed() {
  const now = Math.floor(Date.now() / 1000);
  return {
    vm: { status: "TERMINATED" as string, ip: "203.0.113.42", game_port: "8211" },
    server: null as null | { info: any; metrics: any; players: Player[] },
    watchdog: { poll_seconds: 60, grace_seconds: 1800 },
    saves: {
      active: "world-a",
      slots: [
        { guid: "world-a", name: "Season 2 — main", created: now - 86400 * 45, active: true, size: 512_034_112, empty: false, last_backup: now - 3600 * 5 },
        { guid: "world-b", name: "Sandbox testing", created: now - 86400 * 12, active: false, size: 218_912_000, empty: false, last_backup: now - 86400 },
        { guid: "world-c", name: "Fresh start", created: now - 86400 * 2, active: false, size: 0, empty: true, last_backup: null },
      ] as Slot[],
    },
    backups: {
      "world-a": [
        { ref: "b1", file: "world-a-2026-07-25-14-05.tar.gz", size: 512_000_000, created: now - 3600 * 5, location: "local" as const },
        { ref: "b2", file: "world-a-2026-07-24-14-05.tar.gz", size: 501_000_000, created: now - 3600 * 29, location: "local" as const },
        { ref: "b3", file: "world-a-2026-07-20-14-05.tar.gz", size: 480_000_000, created: now - 86400 * 5, location: "remote" as const, uri: "gs://palpilot-backups/world-a/…" },
      ] as Backup[],
      "world-b": [
        { ref: "b4", file: "world-b-2026-07-25-09-00.tar.gz", size: 210_000_000, created: now - 86400, location: "local" as const },
      ] as Backup[],
      "world-c": [] as Backup[],
    } as Record<string, Backup[]>,
    mods: {
      dir: "/home/steam/…/Pal/Content/Paks/~mods",
      runtime_mode: "native" as "native" | "proton",
      capabilities: { pak: true, logic: true, ue4ss: false },
      mods: [
        { name: "BiggerBackpack.pak", type: "pak" as const, size: 2_400_000, enabled: true, installed_at: now - 86400 * 10 },
        { name: "PalListPlus.pak", type: "pak" as const, size: 5_100_000, enabled: false, source_url: "https://example.com/pallistplus.pak", installed_at: now - 86400 * 4 },
      ] as ModRow[],
    },
    config: {
      raw: "; PalWorldSettings.ini\n[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(...)\n",
      options: {
        Difficulty: "Casual", DeathPenalty: "None",
        bHardcore: "False", bPalLost: "False",
        ExpRate: "1.500000", PalCaptureRate: "1.500000", PalSpawnNumRate: "1.000000",
        WorkSpeedRate: "2.000000", DayTimeSpeedRate: "1.000000", NightTimeSpeedRate: "1.500000",
        PlayerDamageRateAttack: "1.500000", PlayerDamageRateDefense: "0.800000",
        PlayerStomachDecreaceRate: "0.700000", PlayerStaminaDecreaceRate: "0.700000",
        PlayerAutoHPRegeneRate: "1.500000", PlayerAutoHpRegeneRateInSleep: "2.000000",
        PalDamageRateAttack: "1.500000", PalDamageRateDefense: "0.800000",
        PalStomachDecreaceRate: "0.700000", PalStaminaDecreaceRate: "0.700000",
        PalAutoHPRegeneRate: "1.500000", PalAutoHpRegeneRateInSleep: "2.000000",
        PalEggDefaultHatchingTime: "2.000000",
        CollectionDropRate: "2.000000", CollectionObjectHpRate: "0.800000",
        CollectionObjectRespawnSpeedRate: "1.500000", EnemyDropItemRate: "1.500000",
        DropItemMaxNum: "3000", DropItemAliveMaxHours: "6.000000",
        SupplyDropSpan: "150",
        BuildObjectDamageRate: "0.500000", BuildObjectDeteriorationDamageRate: "0.000000",
        BaseCampMaxNum: "4", BaseCampWorkerMaxNum: "20",
        bEnableInvaderEnemy: "True", EnablePredatorBossPal: "True",
        bEnableFastTravel: "True", bEnableAimAssistPad: "True", bEnableAimAssistKeyboard: "True",
        autoSaveSpan: "30", bIsUseBackupSaveData: "True",
        bIsPvP: "False", bEnablePlayerToPlayerDamage: "False", bEnableFriendlyFire: "False",
        ServerName: "Season 2 — friends only",
        ServerDescription: "Casual co-op.",
        ServerPlayerMaxNum: "16", CoopPlayerMaxNum: "4",
        ServerPassword: "", AdminPassword: "•••••••",
        PublicPort: "8211", PublicIP: "", Region: "",
        bUseAuth: "True", bIsMultiplay: "True",
        BanListURL: "https://api.palworldgame.com/api/banlist.txt",
        RESTAPIEnabled: "True", RESTAPIPort: "8212",
        RCONEnabled: "False", RCONPort: "25575",
        LogFormatType: "Text",
        CrossplayPlatforms: "(Steam,Xbox,PS5,Mac)",
      } as Record<string, string>,
      path: "/home/steam/Steam/…/PalWorldSettings.ini",
    },
    users: [
      { username: "owner", role: "owner", perms: [], effective_perms: ROLE_BUNDLES.owner },
      { username: "alex",  role: "operator", perms: [], effective_perms: ROLE_BUNDLES.operator },
      { username: "sam",   role: "moderator", perms: [], effective_perms: ROLE_BUNDLES.moderator },
      { username: "guest", role: "viewer", perms: [], effective_perms: ROLE_BUNDLES.viewer },
    ] as UserRow[],
    roles: [
      { name: "owner", perms: [...ROLE_BUNDLES.owner], builtin: true },
      { name: "operator", perms: [...ROLE_BUNDLES.operator], builtin: true },
      { name: "moderator", perms: [...ROLE_BUNDLES.moderator], builtin: true },
      { name: "viewer", perms: [...ROLE_BUNDLES.viewer], builtin: true },
    ] as RoleRow[],
    all_perms: ALL_PERMS,
    role_bundles: ROLE_BUNDLES,
    uploads: {} as Record<string, { name: string; filename: string; parts: number; bytes: number }>,
    // simulated player roster (used when knobs.showPlayers is true and vm is on)
    playersSample: [
      { name: "PalMaster", accountName: "palmaster", playerId: "p1", userId: "steam_11111111", ip: "10.0.0.4",  ping: 42, level: 34, location_x: 12.4, location_y: -8.9 },
      { name: "Foxy",      accountName: "foxy",      playerId: "p2", userId: "steam_22222222", ip: "10.0.0.5",  ping: 61, level: 22, location_x: 4.1,  location_y: 18.2 },
      { name: "Kite",      accountName: "kite",      playerId: "p3", userId: "steam_33333333", ip: "10.0.0.6",  ping: 88, level: 41, location_x: -3.5, location_y: 22.1 },
    ] as Player[],
  };
}

export let fixtures = seed();
export function resetFixtures() { fixtures = seed(); }

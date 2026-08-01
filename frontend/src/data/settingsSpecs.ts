// Per-field editing rules for PalWorldSettings.ini: which tab a key belongs to,
// its shipped default, and its valid range and precision.
//
// None of this comes from the API. `POST /api/config/reset` resets the WHOLE file
// and there is no per-key default anywhere, so this table is authored here and is
// the only source of "Default: 1.0" and "Range: 0.1–10". That has a consequence
// the UI must respect: a key missing from SPECS has NO known default, so its
// reset control is disabled and says why, rather than guessing a value and
// writing it into someone's live server.
//
// Upper bounds are deliberately NOT enforced. Palworld's documented ranges are
// practical advice, not hard limits, and the console used to clamp to them —
// silently rewriting a rate of 50 down to 20. So `max` is now set only where a
// larger value is unusable rather than merely unusual: the port fields, which
// cannot exceed 65535. `min` stays everywhere it guards a value the game
// rejects outright (a port below 1024, a negative rate).

export type FieldKind = "bool" | "enum" | "int" | "float" | "text" | "secret";

export interface FieldSpec {
  kind: FieldKind;
  /** The value a fresh PalWorldSettings.ini ships with, as a string. */
  default?: string;
  min?: number;
  max?: number;
  /** Decimal places accepted. 0 => integer. */
  precision?: number;
  /** Options for `enum`. */
  options?: string[];
}

export const TAB_ORDER = [
  "general",
  "gameplay",
  "world",
  "players",
  "combat",
  "pals",
  "resources",
  "structures",
  "performance",
  "admin",
] as const;

export type TabId = (typeof TAB_ORDER)[number];

export const TAB_META: Record<TabId, { label: string; description: string }> = {
  general: {
    label: "General",
    description: "How the server presents itself in the browser, and who may join.",
  },
  gameplay: {
    label: "Gameplay",
    description: "Overall difficulty and what happens when you die.",
  },
  world: {
    label: "World",
    description: "Day length, saving, and world-level toggles.",
  },
  players: {
    label: "Players",
    description: "Survival pressure on players: hunger, stamina and healing.",
  },
  combat: {
    label: "Combat & PvP",
    description: "Damage multipliers and whether players can hurt each other.",
  },
  pals: {
    label: "Pals",
    description: "Capture odds, spawn density, and how your Pals fare.",
  },
  resources: {
    label: "Resources",
    description: "Gathering yields, drops and supply drops.",
  },
  structures: {
    label: "Base building",
    description: "Base limits, durability and decay.",
  },
  performance: {
    label: "Performance",
    description: "Limits that trade world richness for frame time.",
  },
  admin: {
    label: "Admin & API",
    description: "Credentials and the interfaces this console depends on.",
  },
};

/** Key -> tab. Anything unmapped lands in "general". */
export const KEY_TAB: Record<string, TabId> = {
  ServerName: "general", ServerDescription: "general", ServerPlayerMaxNum: "general",
  CoopPlayerMaxNum: "general", ServerPassword: "general", PublicPort: "general",
  PublicIP: "general", Region: "general", bUseAuth: "general", bIsMultiplay: "general",
  BanListURL: "general", CrossplayPlatforms: "general", bShowPlayerList: "general",

  Difficulty: "gameplay", DeathPenalty: "gameplay", bHardcore: "gameplay", bPalLost: "gameplay",
  ExpRate: "gameplay", bEnableFastTravel: "gameplay", bEnableAimAssistPad: "gameplay",
  bEnableAimAssistKeyboard: "gameplay", bCharacterRecreateInHardcore: "gameplay",

  DayTimeSpeedRate: "world", NightTimeSpeedRate: "world", autoSaveSpan: "world",
  bIsUseBackupSaveData: "world", bEnableInvaderEnemy: "world", EnablePredatorBossPal: "world",
  RandomizerType: "world", RandomizerSeed: "world", bIsRandomizerPalLevelRandom: "world",

  PlayerStomachDecreaceRate: "players", PlayerStaminaDecreaceRate: "players",
  PlayerAutoHPRegeneRate: "players", PlayerAutoHpRegeneRateInSleep: "players",

  PlayerDamageRateAttack: "combat", PlayerDamageRateDefense: "combat",
  bIsPvP: "combat", bEnablePlayerToPlayerDamage: "combat", bEnableFriendlyFire: "combat",

  PalCaptureRate: "pals", PalSpawnNumRate: "pals", PalDamageRateAttack: "pals",
  PalDamageRateDefense: "pals", PalStomachDecreaceRate: "pals", PalStaminaDecreaceRate: "pals",
  PalAutoHPRegeneRate: "pals", PalAutoHpRegeneRateInSleep: "pals", PalEggDefaultHatchingTime: "pals",

  CollectionDropRate: "resources", CollectionObjectHpRate: "resources",
  CollectionObjectRespawnSpeedRate: "resources", EnemyDropItemRate: "resources",
  DropItemAliveMaxHours: "resources", SupplyDropSpan: "resources", WorkSpeedRate: "resources",

  BuildObjectDamageRate: "structures", BuildObjectDeteriorationDamageRate: "structures",
  BaseCampMaxNum: "structures", BaseCampWorkerMaxNum: "structures",

  DropItemMaxNum: "performance", ServerReplicatePawnCullDistance: "performance",
  ChatPostLimitPerMinute: "performance",

  AdminPassword: "admin", RESTAPIEnabled: "admin", RESTAPIPort: "admin",
  RCONEnabled: "admin", RCONPort: "admin", LogFormatType: "admin", bAllowClientMod: "admin",
};

const RATE = { kind: "float" as const, default: "1.000000", min: 0.1, precision: 6 };

export const SPECS: Record<string, FieldSpec> = {
  // --- general
  ServerName: { kind: "text", default: "Default Palworld Server" },
  ServerDescription: { kind: "text", default: "" },
  ServerPlayerMaxNum: { kind: "int", default: "32", min: 1, precision: 0 },
  CoopPlayerMaxNum: { kind: "int", default: "4", min: 1, precision: 0 },
  ServerPassword: { kind: "secret", default: "" },
  PublicPort: { kind: "int", default: "8211", min: 1024, max: 65535, precision: 0 },
  PublicIP: { kind: "text", default: "" },
  Region: { kind: "text", default: "" },
  bUseAuth: { kind: "bool", default: "True" },
  bIsMultiplay: { kind: "bool", default: "False" },
  BanListURL: { kind: "text", default: "https://api.palworldgame.com/api/banlist.txt" },
  bShowPlayerList: { kind: "bool", default: "False" },

  // --- gameplay
  Difficulty: { kind: "enum", default: "None", options: ["None", "Casual", "Normal", "Hard"] },
  DeathPenalty: { kind: "enum", default: "All", options: ["None", "Item", "ItemAndEquipment", "All"] },
  bHardcore: { kind: "bool", default: "False" },
  bPalLost: { kind: "bool", default: "False" },
  ExpRate: RATE,
  bEnableFastTravel: { kind: "bool", default: "True" },
  bEnableAimAssistPad: { kind: "bool", default: "True" },
  bEnableAimAssistKeyboard: { kind: "bool", default: "False" },
  bCharacterRecreateInHardcore: { kind: "bool", default: "False" },

  // --- world
  DayTimeSpeedRate: RATE,
  NightTimeSpeedRate: RATE,
  autoSaveSpan: { kind: "float", default: "30.000000", min: 1, precision: 6 },
  bIsUseBackupSaveData: { kind: "bool", default: "True" },
  bEnableInvaderEnemy: { kind: "bool", default: "True" },
  EnablePredatorBossPal: { kind: "bool", default: "True" },

  // --- players
  PlayerStomachDecreaceRate: RATE,
  PlayerStaminaDecreaceRate: RATE,
  PlayerAutoHPRegeneRate: RATE,
  PlayerAutoHpRegeneRateInSleep: RATE,

  // --- combat
  PlayerDamageRateAttack: RATE,
  PlayerDamageRateDefense: RATE,
  bIsPvP: { kind: "bool", default: "False" },
  bEnablePlayerToPlayerDamage: { kind: "bool", default: "False" },
  bEnableFriendlyFire: { kind: "bool", default: "False" },

  // --- pals
  PalCaptureRate: RATE,
  PalSpawnNumRate: RATE,
  PalDamageRateAttack: RATE,
  PalDamageRateDefense: RATE,
  PalStomachDecreaceRate: RATE,
  PalStaminaDecreaceRate: RATE,
  PalAutoHPRegeneRate: RATE,
  PalAutoHpRegeneRateInSleep: RATE,
  PalEggDefaultHatchingTime: { kind: "float", default: "72.000000", min: 0, precision: 6 },

  // --- resources
  CollectionDropRate: RATE,
  CollectionObjectHpRate: RATE,
  CollectionObjectRespawnSpeedRate: RATE,
  EnemyDropItemRate: RATE,
  DropItemAliveMaxHours: { kind: "float", default: "1.000000", min: 0, precision: 6 },
  SupplyDropSpan: { kind: "int", default: "180", min: 0, precision: 0 },
  WorkSpeedRate: RATE,

  // --- structures
  BuildObjectDamageRate: RATE,
  BuildObjectDeteriorationDamageRate: { kind: "float", default: "1.000000", min: 0, precision: 6 },
  BaseCampMaxNum: { kind: "int", default: "128", min: 1, precision: 0 },
  BaseCampWorkerMaxNum: { kind: "int", default: "15", min: 1, precision: 0 },

  // --- performance
  DropItemMaxNum: { kind: "int", default: "3000", min: 100, precision: 0 },
  ChatPostLimitPerMinute: { kind: "int", default: "10", min: 1, precision: 0 },

  // --- admin
  AdminPassword: { kind: "secret", default: "" },
  RESTAPIEnabled: { kind: "bool", default: "False" },
  RESTAPIPort: { kind: "int", default: "8212", min: 1024, max: 65535, precision: 0 },
  RCONEnabled: { kind: "bool", default: "False" },
  RCONPort: { kind: "int", default: "25575", min: 1024, max: 65535, precision: 0 },
  LogFormatType: { kind: "enum", default: "Text", options: ["Text", "Json"] },
  bAllowClientMod: { kind: "bool", default: "False" },
};

/**
 * Keys this console must not let you break, because the panel talks to the game
 * through them. Editable, but warned about — bootstrap() re-asserts them on the
 * next slot switch anyway, so a mistake here is recoverable but confusing.
 */
export const LOAD_BEARING = new Set(["RESTAPIEnabled", "RESTAPIPort", "AdminPassword"]);

export function tabFor(key: string): TabId {
  return KEY_TAB[key] ?? "general";
}

/** Derive a kind when the key isn't in SPECS, from the value the server sent. */
export function inferKind(key: string, value: string): FieldKind {
  const spec = SPECS[key];
  if (spec) return spec.kind;
  if (/^(true|false)$/i.test(value)) return "bool";
  if (/^-?\d+$/.test(value)) return "int";
  if (/^-?\d+\.\d+$/.test(value)) return "float";
  if (/password/i.test(key)) return "secret";
  return "text";
}

/**
 * Locale-independent numeric parse. `parseFloat` on a comma decimal silently
 * truncates ("1,5" -> 1), which would quietly halve a rate, so a comma is
 * normalised to a dot and anything else non-numeric is rejected outright.
 */
export function parseNumeric(raw: string): number | null {
  const s = raw.trim().replace(",", ".");
  if (!s || !/^-?\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Format a number back into the ini's style (Palworld writes 6 decimals). */
export function formatNumeric(n: number, precision = 6): string {
  return precision > 0 ? n.toFixed(precision) : String(Math.round(n));
}

export function rangeHint(spec?: FieldSpec): string {
  if (!spec || (spec.min == null && spec.max == null)) return "";
  if (spec.min != null && spec.max != null) return `${spec.min} to ${spec.max}`;
  if (spec.min != null) return `${spec.min} or higher`;
  return `up to ${spec.max}`;
}

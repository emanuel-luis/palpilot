// Friendly names, descriptions, and "easier direction" for PalWorldSettings.ini
// keys. Keys not present get a de-camel-cased fallback label (see format.deCamel).
// Grouping is by MEANING, not by prefix — the old first-match-wins cascade
// dumped every "…Rate" key into the wrong bucket. Update `SETTINGS_META`
// alongside `SECTION_ORDER` / `KEY_TO_SECTION` when adding keys.

export type Ease = "higher" | "lower" | "on" | "off" | "";
export interface SettingMeta { label: string; desc: string; ease: Ease }

export const SETTINGS_META: Record<string, SettingMeta> = {
  // overall
  Difficulty: { label: "Difficulty", desc: "Overall difficulty preset. Casual is the most forgiving; Hard makes enemies tougher and survival harsher.", ease: "" },
  DeathPenalty: { label: "Death penalty", desc: "What you lose when you die. None = keep everything (easiest); All = drop items, equipment and Pals.", ease: "" },
  bHardcore: { label: "Hardcore mode", desc: "Permadeath for players. Off is far more forgiving.", ease: "off" },
  bPalLost: { label: "Lose Pals on death", desc: "Pals die permanently on death (hardcore). Off keeps your Pals.", ease: "off" },
  // progression
  ExpRate: { label: "EXP rate", desc: "Multiplies all XP gained by players and Pals. Level up faster.", ease: "higher" },
  PalCaptureRate: { label: "Pal capture rate", desc: "How likely a capture attempt succeeds. Easier to catch Pals.", ease: "higher" },
  PalSpawnNumRate: { label: "Wild Pal spawns", desc: "How many wild Pals spawn. More Pals to catch — but also more to fight.", ease: "" },
  WorkSpeedRate: { label: "Base work speed", desc: "How fast Pals do base work (crafting, building, farming). Everything gets built sooner.", ease: "higher" },
  DayTimeSpeedRate: { label: "Day length speed", desc: "How fast daytime passes. Higher = shorter days.", ease: "" },
  NightTimeSpeedRate: { label: "Night length speed", desc: "How fast night passes. Higher = shorter, less dangerous nights.", ease: "higher" },
  // player survival
  PlayerDamageRateAttack: { label: "Your attack damage", desc: "Damage YOU deal. Fights end faster.", ease: "higher" },
  PlayerDamageRateDefense: { label: "Damage you take", desc: "Damage you TAKE. Lower means you're tankier.", ease: "lower" },
  PlayerStomachDecreaceRate: { label: "Your hunger rate", desc: "How fast your hunger drops. Lower = eat less often.", ease: "lower" },
  PlayerStaminaDecreaceRate: { label: "Your stamina drain", desc: "How fast your stamina drains when running/climbing. Lower = sprint longer.", ease: "lower" },
  PlayerAutoHPRegeneRate: { label: "Your HP regen", desc: "How fast your health regenerates. Higher = heal faster.", ease: "higher" },
  PlayerAutoHpRegeneRateInSleep: { label: "Your HP regen (sleeping)", desc: "Health regenerated while sleeping. Higher = wake up healthier.", ease: "higher" },
  // pal survival
  PalDamageRateAttack: { label: "Pal attack damage", desc: "Damage YOUR Pals deal. Your team hits harder.", ease: "higher" },
  PalDamageRateDefense: { label: "Damage your Pals take", desc: "Damage your Pals TAKE. Lower keeps them alive longer.", ease: "lower" },
  PalStomachDecreaceRate: { label: "Pal hunger rate", desc: "How fast your Pals get hungry. Lower = feed them less.", ease: "lower" },
  PalStaminaDecreaceRate: { label: "Pal stamina drain", desc: "How fast your Pals' stamina drains. Lower = they last longer.", ease: "lower" },
  PalAutoHPRegeneRate: { label: "Pal HP regen", desc: "How fast your Pals heal. Higher = recover faster.", ease: "higher" },
  PalAutoHpRegeneRateInSleep: { label: "Pal HP regen (Palbox)", desc: "Pal health regenerated while in the Palbox/sleeping. Higher = heal faster.", ease: "higher" },
  PalEggDefaultHatchingTime: { label: "Egg hatch time", desc: "Hours needed to hatch an egg. Lower = eggs hatch sooner.", ease: "lower" },
  // gathering
  CollectionDropRate: { label: "Gathering yield", desc: "How much you get from gathering (wood, ore, etc.). More resources per hit.", ease: "higher" },
  CollectionObjectHpRate: { label: "Resource node health", desc: "Health of gatherable nodes (trees, rocks). Lower = harvest them faster.", ease: "lower" },
  CollectionObjectRespawnSpeedRate: { label: "Resource respawn speed", desc: "How quickly harvested nodes regrow. Higher = resources come back sooner.", ease: "higher" },
  EnemyDropItemRate: { label: "Enemy loot amount", desc: "Loot dropped by defeated enemies/Pals. Higher = more rewards.", ease: "higher" },
  DropItemMaxNum: { label: "Max dropped items", desc: "Max dropped items allowed in the world at once. Mostly a performance limit.", ease: "" },
  DropItemAliveMaxHours: { label: "Dropped item lifetime", desc: "How long dropped items stay before vanishing. Higher = more time to recover a death drop.", ease: "higher" },
  SupplyDropSpan: { label: "Supply drop interval", desc: "Minutes between airborne supply drops. Lower = free supplies more often.", ease: "lower" },
  // base building
  BuildObjectDamageRate: { label: "Structure damage taken", desc: "Damage your base structures take. Lower = sturdier base.", ease: "lower" },
  BuildObjectDeteriorationDamageRate: { label: "Base decay rate", desc: "How fast base structures decay and need repair. Lower (or 0) = little/no upkeep.", ease: "lower" },
  BaseCampMaxNum: { label: "Max base camps", desc: "How many base camps you can own. More bases = more room to build.", ease: "higher" },
  BaseCampWorkerMaxNum: { label: "Max base workers", desc: "Max Pals working at a base. More workers = more gets done.", ease: "higher" },
  // world threats
  bEnableInvaderEnemy: { label: "Base raids", desc: "Raids where enemies attack your base. Off = no raids.", ease: "off" },
  EnablePredatorBossPal: { label: "Predator boss Pals", desc: "Rare, very strong Predator boss Pals roam the world. Off = fewer nasty surprises.", ease: "off" },
  // convenience
  bEnableFastTravel: { label: "Fast travel", desc: "Allow fast travel between unlocked points. On = less walking.", ease: "on" },
  bEnableAimAssistPad: { label: "Aim assist (controller)", desc: "Aim assist for controllers. On = easier aiming.", ease: "on" },
  bEnableAimAssistKeyboard: { label: "Aim assist (keyboard)", desc: "Aim assist for keyboard/mouse. On = easier aiming.", ease: "on" },
  // saving
  autoSaveSpan: { label: "Autosave interval", desc: "Minutes between automatic world saves. Lower = lose less progress on a crash.", ease: "lower" },
  bIsUseBackupSaveData: { label: "Backup saves", desc: "Keep backup copies of the save. On is safer.", ease: "on" },
  // PvP / social
  bIsPvP: { label: "Enable PvP", desc: "Marks the server as PvP in the community browser.", ease: "" },
  bEnablePlayerToPlayerDamage: { label: "Player-vs-player damage", desc: "Players can damage each other. Off is friendlier for co-op.", ease: "off" },
  bEnableFriendlyFire: { label: "Friendly fire", desc: "You can damage your own guild/Pals. Off avoids accidents.", ease: "off" },
  // server / network
  ServerName: { label: "Server name", desc: "Name shown in the server list.", ease: "" },
  ServerDescription: { label: "Server description", desc: "Description shown in the server list.", ease: "" },
  ServerPlayerMaxNum: { label: "Max players", desc: "Maximum players allowed on the server.", ease: "" },
  CoopPlayerMaxNum: { label: "Max co-op players", desc: "Maximum players in a single co-op guild/session.", ease: "" },
  ServerPassword: { label: "Server password", desc: "Password required to join. Empty = open server.", ease: "" },
  AdminPassword: { label: "Admin password", desc: "Password for in-game admin commands and the REST/RCON API.", ease: "" },
  PublicPort: { label: "Game port", desc: "UDP port the server listens on (game connections).", ease: "" },
  PublicIP: { label: "Public IP", desc: "Public IP advertised to clients. Usually leave blank to auto-detect.", ease: "" },
  Region: { label: "Region", desc: "Region tag shown in the community server browser.", ease: "" },
  bUseAuth: { label: "Require authentication", desc: "Require platform authentication to join. Keep on for public servers.", ease: "" },
  bIsMultiplay: { label: "Multiplayer mode", desc: "Whether the world runs in multiplayer mode.", ease: "" },
  BanListURL: { label: "Ban list URL", desc: "URL of a shared ban list to enforce.", ease: "" },
  RESTAPIEnabled: { label: "REST API", desc: "Enables the local REST API the admin panel uses. Keep on — the panel needs it.", ease: "" },
  RESTAPIPort: { label: "REST API port", desc: "Port for the local REST API (localhost only).", ease: "" },
  RCONEnabled: { label: "RCON", desc: "Enables the RCON remote-console protocol.", ease: "" },
  RCONPort: { label: "RCON port", desc: "Port for RCON.", ease: "" },
  LogFormatType: { label: "Log format", desc: "Server log format (Text or Json).", ease: "" },
  CrossplayPlatforms: { label: "Crossplay platforms", desc: "Which platforms can play together.", ease: "" },
};

export function easeHint(e: Ease): string {
  switch (e) {
    case "higher": return "Higher = easier";
    case "lower":  return "Lower = easier";
    case "on":     return "On = easier";
    case "off":    return "Off = easier";
    default:       return "";
  }
}

// Group by meaning. Any key not mapped falls into "Other".
export const SECTION_ORDER = [
  "difficultyDeath",
  "progression",
  "playerSurvival",
  "palSurvival",
  "gathering",
  "baseBuilding",
  "worldThreats",
  "convenienceSaving",
  "pvpSocial",
  "serverNetwork",
  "apiRcon",
  "other",
] as const;

export const SECTION_LABELS: Record<string, string> = {
  difficultyDeath:   "Difficulty & death",
  progression:       "Progression & rates",
  playerSurvival:    "Player survival",
  palSurvival:       "Pal survival",
  gathering:         "Gathering & economy",
  baseBuilding:      "Base building",
  worldThreats:      "World threats",
  convenienceSaving: "Convenience & saving",
  pvpSocial:         "PvP & social",
  serverNetwork:     "Server & network",
  apiRcon:           "API, RCON & logs",
  other:             "Other",
};

export const KEY_TO_SECTION: Record<string, string> = {
  Difficulty: "difficultyDeath", DeathPenalty: "difficultyDeath", bHardcore: "difficultyDeath", bPalLost: "difficultyDeath",
  ExpRate: "progression", PalCaptureRate: "progression", PalSpawnNumRate: "progression",
    WorkSpeedRate: "progression", DayTimeSpeedRate: "progression", NightTimeSpeedRate: "progression",
  PlayerDamageRateAttack: "playerSurvival", PlayerDamageRateDefense: "playerSurvival",
    PlayerStomachDecreaceRate: "playerSurvival", PlayerStaminaDecreaceRate: "playerSurvival",
    PlayerAutoHPRegeneRate: "playerSurvival", PlayerAutoHpRegeneRateInSleep: "playerSurvival",
  PalDamageRateAttack: "palSurvival", PalDamageRateDefense: "palSurvival",
    PalStomachDecreaceRate: "palSurvival", PalStaminaDecreaceRate: "palSurvival",
    PalAutoHPRegeneRate: "palSurvival", PalAutoHpRegeneRateInSleep: "palSurvival",
    PalEggDefaultHatchingTime: "palSurvival",
  CollectionDropRate: "gathering", CollectionObjectHpRate: "gathering", CollectionObjectRespawnSpeedRate: "gathering",
    EnemyDropItemRate: "gathering", DropItemMaxNum: "gathering", DropItemAliveMaxHours: "gathering",
    SupplyDropSpan: "gathering",
  BuildObjectDamageRate: "baseBuilding", BuildObjectDeteriorationDamageRate: "baseBuilding",
    BaseCampMaxNum: "baseBuilding", BaseCampWorkerMaxNum: "baseBuilding",
  bEnableInvaderEnemy: "worldThreats", EnablePredatorBossPal: "worldThreats",
  bEnableFastTravel: "convenienceSaving", bEnableAimAssistPad: "convenienceSaving", bEnableAimAssistKeyboard: "convenienceSaving",
    autoSaveSpan: "convenienceSaving", bIsUseBackupSaveData: "convenienceSaving",
  bIsPvP: "pvpSocial", bEnablePlayerToPlayerDamage: "pvpSocial", bEnableFriendlyFire: "pvpSocial",
  ServerName: "serverNetwork", ServerDescription: "serverNetwork", ServerPlayerMaxNum: "serverNetwork",
    CoopPlayerMaxNum: "serverNetwork", ServerPassword: "serverNetwork", PublicPort: "serverNetwork",
    PublicIP: "serverNetwork", Region: "serverNetwork", bUseAuth: "serverNetwork", bIsMultiplay: "serverNetwork",
    BanListURL: "serverNetwork", CrossplayPlatforms: "serverNetwork",
  RESTAPIEnabled: "apiRcon", RESTAPIPort: "apiRcon", RCONEnabled: "apiRcon", RCONPort: "apiRcon",
    AdminPassword: "apiRcon", LogFormatType: "apiRcon",
};

export const SELECT_OPTIONS: Record<string, string[]> = {
  Difficulty: ["Casual", "Normal", "Hard", "None"],
  DeathPenalty: ["None", "Item", "ItemAndEquipment", "All"],
  LogFormatType: ["Text", "Json"],
};

export const SECRET_KEYS = new Set(["AdminPassword", "ServerPassword"]);

// Human descriptions for PalWorldSettings.ini options, plus which direction of
// the value makes the game EASIER (more forgiving). Keys match Palworld's
// OptionSettings names. Any key not listed here just shows its humanized name.
//
//   ease: "higher" | "lower" | "on" | "off" | ""   ("" = no clear easier way)
//
// "Easier" here means: less grind, less punishment, more resources — a more
// relaxed / casual experience.

export const SETTINGS_META = {
  // ---- overall ----
  Difficulty: { desc: "Overall difficulty preset. Casual is the most forgiving; Hard makes enemies tougher and survival harsher.", ease: "" },
  DeathPenalty: { desc: "What you lose when you die. None = keep everything (easiest); All = drop items, equipment and Pals.", ease: "" },
  bHardcore: { desc: "Permadeath for players. Off is far more forgiving.", ease: "off" },
  bPalLost: { desc: "Pals die permanently on death (hardcore). Off keeps your Pals.", ease: "off" },

  // ---- progression / rates ----
  ExpRate: { desc: "Multiplies all XP gained by players and Pals. Level up faster.", ease: "higher" },
  PalCaptureRate: { desc: "How likely a capture attempt succeeds. Easier to catch Pals.", ease: "higher" },
  PalSpawnNumRate: { desc: "How many wild Pals spawn. More Pals to catch — but also more to fight.", ease: "" },
  WorkSpeedRate: { desc: "How fast Pals do base work (crafting, building, farming). Everything gets built sooner.", ease: "higher" },
  DayTimeSpeedRate: { desc: "How fast daytime passes. Higher = shorter days.", ease: "" },
  NightTimeSpeedRate: { desc: "How fast night passes. Higher = shorter, less dangerous nights.", ease: "higher" },

  // ---- player survival ----
  PlayerDamageRateAttack: { desc: "Damage YOU deal. Fights end faster.", ease: "higher" },
  PlayerDamageRateDefense: { desc: "Damage you TAKE. Lower means you're tankier.", ease: "lower" },
  PlayerStomachDecreaceRate: { desc: "How fast your hunger drops. Lower = eat less often.", ease: "lower" },
  PlayerStaminaDecreaceRate: { desc: "How fast your stamina drains when running/climbing. Lower = sprint longer.", ease: "lower" },
  PlayerAutoHPRegeneRate: { desc: "How fast your health regenerates. Higher = heal faster.", ease: "higher" },
  PlayerAutoHpRegeneRateInSleep: { desc: "Health regenerated while sleeping. Higher = wake up healthier.", ease: "higher" },

  // ---- Pal survival ----
  PalDamageRateAttack: { desc: "Damage YOUR Pals deal. Your team hits harder.", ease: "higher" },
  PalDamageRateDefense: { desc: "Damage your Pals TAKE. Lower keeps them alive longer.", ease: "lower" },
  PalStomachDecreaceRate: { desc: "How fast your Pals get hungry. Lower = feed them less.", ease: "lower" },
  PalStaminaDecreaceRate: { desc: "How fast your Pals' stamina drains. Lower = they last longer.", ease: "lower" },
  PalAutoHPRegeneRate: { desc: "How fast your Pals heal. Higher = recover faster.", ease: "higher" },
  PalAutoHpRegeneRateInSleep: { desc: "Pal health regenerated while in the Palbox/sleeping. Higher = heal faster.", ease: "higher" },
  PalEggDefaultHatchingTime: { desc: "Hours needed to hatch an egg. Lower = eggs hatch sooner.", ease: "lower" },

  // ---- gathering / economy ----
  CollectionDropRate: { desc: "How much you get from gathering (wood, ore, etc.). More resources per hit.", ease: "higher" },
  CollectionObjectHpRate: { desc: "Health of gatherable nodes (trees, rocks). Lower = harvest them faster.", ease: "lower" },
  CollectionObjectRespawnSpeedRate: { desc: "How quickly harvested nodes regrow. Higher = resources come back sooner.", ease: "higher" },
  EnemyDropItemRate: { desc: "Loot dropped by defeated enemies/Pals. Higher = more rewards.", ease: "higher" },
  DropItemMaxNum: { desc: "Max dropped items allowed in the world at once. Mostly a performance limit.", ease: "" },
  DropItemAliveMaxHours: { desc: "How long dropped items stay before vanishing. Higher = more time to recover a death drop.", ease: "higher" },
  SupplyDropSpan: { desc: "Minutes between airborne supply drops. Lower = free supplies more often.", ease: "lower" },

  // ---- base building ----
  BuildObjectDamageRate: { desc: "Damage your base structures take. Lower = sturdier base.", ease: "lower" },
  BuildObjectDeteriorationDamageRate: { desc: "How fast base structures decay and need repair. Lower (or 0) = little/no upkeep.", ease: "lower" },
  BaseCampMaxNum: { desc: "How many base camps you can own. More bases = more room to build.", ease: "higher" },
  BaseCampWorkerMaxNum: { desc: "Max Pals working at a base. More workers = more gets done.", ease: "higher" },

  // ---- world threats ----
  bEnableInvaderEnemy: { desc: "Raids where enemies attack your base. Off = no raids.", ease: "off" },
  EnablePredatorBossPal: { desc: "Rare, very strong Predator boss Pals roam the world. Off = fewer nasty surprises.", ease: "off" },

  // ---- convenience ----
  bEnableFastTravel: { desc: "Allow fast travel between unlocked points. On = less walking.", ease: "on" },
  bEnableAimAssistPad: { desc: "Aim assist for controllers. On = easier aiming.", ease: "on" },
  bEnableAimAssistKeyboard: { desc: "Aim assist for keyboard/mouse. On = easier aiming.", ease: "on" },

  // ---- saving ----
  autoSaveSpan: { desc: "Minutes between automatic world saves. Lower = lose less progress on a crash (small performance cost).", ease: "lower" },
  bIsUseBackupSaveData: { desc: "Keep backup copies of the save. On is safer.", ease: "on" },

  // ---- PvP / social (safety, not difficulty) ----
  bEnablePlayerToPlayerDamage: { desc: "Players can damage each other (PvP). Off is friendlier for co-op.", ease: "off" },
  bEnableFriendlyFire: { desc: "You can damage your own guild/Pals. Off avoids accidents.", ease: "off" },

  // ---- server / meta (no 'easier' direction — these configure the server) ----
  ServerName: { desc: "Name shown in the server list.", ease: "" },
  ServerDescription: { desc: "Description shown in the server list.", ease: "" },
  ServerPlayerMaxNum: { desc: "Maximum players allowed on the server.", ease: "" },
  CoopPlayerMaxNum: { desc: "Maximum players in a single co-op guild/session.", ease: "" },
  ServerPassword: { desc: "Password required to join. Empty = open server.", ease: "" },
  AdminPassword: { desc: "Password for in-game admin commands and the REST/RCON API.", ease: "" },
  PublicPort: { desc: "UDP port the server listens on (game connections).", ease: "" },
  PublicIP: { desc: "Public IP advertised to clients. Usually leave blank to auto-detect.", ease: "" },
  Region: { desc: "Region tag shown in the community server browser.", ease: "" },
  bUseAuth: { desc: "Require platform authentication to join. Keep on for public servers.", ease: "" },
  bIsMultiplay: { desc: "Whether the world runs in multiplayer mode.", ease: "" },
  bIsPvP: { desc: "Marks the server as PvP in the browser.", ease: "" },
  BanListURL: { desc: "URL of a shared ban list to enforce.", ease: "" },
  RESTAPIEnabled: { desc: "Enables the local REST API the admin panel uses. Keep on — the panel needs it.", ease: "" },
  RESTAPIPort: { desc: "Port for the local REST API (localhost only).", ease: "" },
  RCONEnabled: { desc: "Enables the RCON remote-console protocol.", ease: "" },
  RCONPort: { desc: "Port for RCON.", ease: "" },
  LogFormatType: { desc: "Server log format (Text or Json).", ease: "" },
  CrossplayPlatforms: { desc: "Which platforms can play together.", ease: "" },
};

// Human-readable hint for the "easier" direction of a setting.
export function easeHint(ease) {
  switch (ease) {
    case "higher":
      return "Higher = easier";
    case "lower":
      return "Lower = easier";
    case "on":
      return "On = easier";
    case "off":
      return "Off = easier";
    default:
      return "";
  }
}

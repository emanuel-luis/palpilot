<!--
  SettingsView: schema-aware PalWorldSettings.ini editor, ported from the
  legacy coordinator/index.html "Config" tab. Loads the *effective* settings
  from the running server (GET /api/rest/settings — richer/always current)
  and lays them out into named sections with a search filter; secret keys
  (AdminPassword/ServerPassword) fall back to the raw-ini value (GET
  /api/config) if the REST snapshot omits them. "Save fields" posts only the
  changed keys; a raw-INI editor underneath covers anything the section view
  doesn't (see docs/FRONTEND_V2_PLAN.md + MODERNIZATION_PLAN.md §7).
-->
<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { apiGet, apiPost } from "../api.js";
import Card from "../components/ui/Card.vue";
import Btn from "../components/ui/Btn.vue";
import Field from "../components/ui/Field.vue";
import { useConfirm } from "../components/ui/useConfirm.js";
import { useToast } from "../components/ui/useToast.js";
import { useServerStore } from "../stores/server.js";

const { t } = useI18n();
const server = useServerStore();
const toast = useToast();
const { confirm } = useConfirm();

// Keys whose values must stay masked/plain-text and are worth surfacing even
// if the REST "settings" snapshot happens to omit them.
const SECRET_KEYS = ["AdminPassword", "ServerPassword"];

const ENUMS = {
  Difficulty: ["None", "Casual", "Normal", "Hard"],
  DeathPenalty: ["None", "Item", "ItemAndEquipment", "All"],
  LogFormatType: ["Text", "Json"],
};

const SERVER_KEYS = new Set([
  "ServerName",
  "ServerDescription",
  "ServerPlayerMaxNum",
  "CoopPlayerMaxNum",
  "PublicPort",
  "PublicIP",
  "Region",
  "bUseAuth",
  "BanListURL",
  "bAllowClientMod",
  "bShowPlayerList",
  "ChatPostLimitPerMinute",
  "bIsMultiplay",
  "ServerPassword",
  "AdminPassword",
  "CrossplayPlatforms",
  "LogFormatType",
  "bIsShowJoinLeftMessage",
  "ServerReplicatePawnCullDistance",
]);
const WORLD_KEYS = new Set([
  "Difficulty",
  "RandomizerType",
  "RandomizerSeed",
  "bIsRandomizerPalLevelRandom",
  "DayTimeSpeedRate",
  "NightTimeSpeedRate",
  "DeathPenalty",
  "bHardcore",
  "bPalLost",
  "bCharacterRecreateInHardcore",
  "autoSaveSpan",
  "bIsUseBackupSaveData",
  "SupplyDropSpan",
  "EnablePredatorBossPal",
  "bEnableInvaderEnemy",
  "bActiveUNKO",
]);

// [i18nSectionKey, keyTest] — evaluated in order, first match wins, "other" catches the rest.
const SECTIONS = [
  ["settings.sec.serverNet", (k) => SERVER_KEYS.has(k)],
  ["settings.sec.apiRcon", (k) => /^REST|^RCON/.test(k)],
  ["settings.sec.voice", (k) => /VoiceChat/i.test(k)],
  ["settings.sec.pvp", (k) => /pvp/i.test(k) || k === "bEnablePlayerToPlayerDamage" || k === "bEnableFriendlyFire"],
  ["settings.sec.guildBase", (k) => /Guild|BaseCamp|Build|AutoTransferMaster/.test(k)],
  ["settings.sec.pals", (k) => /^Pal/.test(k)],
  [
    "settings.sec.player",
    (k) => /Player|Respawn|Enhance|FastTravel|AimAssist|StartLocation|ExistPlayerAfterLogout|NonLoginPenalty/.test(k),
  ],
  ["settings.sec.items", (k) => /Item|Drop|Collection|Palbox|Technology/.test(k)],
  ["settings.sec.worldDiff", (k) => WORLD_KEYS.has(k)],
  ["settings.sec.rates", (k) => /Rate|Multiplier|Speed/.test(k)],
  ["settings.sec.other", () => true],
];

function human(key) {
  return key
    .replace(/^b(?=[A-Z])/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
}

function isSecret(key) {
  return SECRET_KEYS.includes(key);
}

const cfgModel = ref([]); // [{key, value, type}]
const cfgOrig = ref({});
const cfgRaw = ref("");
const cfgPath = ref("");
const cfgSearch = ref("");
const cfgRestart = ref(false);
const loaded = ref(false);

async function loadConfig() {
  if (!server.isRunning) return;
  const [effRes, cfgRes] = await Promise.all([
    apiGet("/api/rest/settings", { key: "settings" }),
    apiGet("/api/config", { key: "settings" }),
  ]);
  cfgRaw.value = cfgRes.ok ? cfgRes.data.raw || "" : "";
  cfgPath.value = cfgRes.ok ? cfgRes.data.path || "" : "";
  if (!effRes.ok) {
    cfgModel.value = [];
    loaded.value = false;
    toast.error(effRes.error || t("settings.loadFailed"));
    return;
  }
  const ini = cfgRes.ok ? cfgRes.data.options || {} : {};
  const model = [];
  for (const [k, v] of Object.entries(effRes.data)) {
    if (Array.isArray(v)) continue;
    model.push({ key: k, value: v, type: typeof v });
  }
  SECRET_KEYS.forEach((k) => {
    if (!model.find((m) => m.key === k)) model.push({ key: k, value: ini[k] ?? "", type: "string" });
  });
  cfgModel.value = model;
  cfgOrig.value = Object.fromEntries(model.map((m) => [m.key, m.value]));
  loaded.value = true;
}

onMounted(loadConfig);
watch(() => server.isRunning, loadConfig);

const cfgGroups = computed(() => {
  const q = cfgSearch.value.toLowerCase();
  const match = (it) => !q || it.key.toLowerCase().includes(q) || human(it.key).toLowerCase().includes(q);
  const used = new Set();
  const groups = [];
  for (const [titleKey, test] of SECTIONS) {
    const items = cfgModel.value.filter((it) => !used.has(it.key) && test(it.key));
    items.forEach((it) => used.add(it.key));
    const shown = items.filter(match);
    if (shown.length) groups.push({ title: t(titleKey), items: shown });
  }
  return groups;
});

async function saveFields() {
  const changed = {};
  cfgModel.value.forEach((m) => {
    if (m.value !== cfgOrig.value[m.key]) changed[m.key] = m.value;
  });
  const n = Object.keys(changed).length;
  if (!n) {
    toast.ok(t("settings.nothingChanged"));
    return;
  }
  const r = await apiPost("/api/config", { options: changed }, { key: "settings", query: `restart=${cfgRestart.value}` });
  if (r.ok) {
    toast.ok(t("settings.savedFields", { count: n, restarting: cfgRestart.value ? t("settings.savedRestarting") : "" }));
    loadConfig();
  } else {
    toast.error(r.error || t("settings.saveFailed"));
  }
}

async function saveRaw() {
  const r = await apiPost("/api/config", { raw: cfgRaw.value }, { key: "settings", query: `restart=${cfgRestart.value}` });
  toast[r.ok ? "ok" : "error"](r.ok ? t("settings.savedGeneric") : r.error || t("settings.saveFailed"));
  if (r.ok) loadConfig();
}

async function resetConfig() {
  const ok = await confirm({
    title: t("settings.resetTitle"),
    message: t("settings.resetConfirm"),
    confirmLabel: t("settings.reset"),
    danger: true,
  });
  if (!ok) return;
  const r = await apiPost("/api/config/reset", {}, { key: "settings", query: `restart=${cfgRestart.value}` });
  toast[r.ok ? "ok" : "error"](
    r.ok
      ? t("settings.resetDone", { restarting: cfgRestart.value ? t("settings.savedRestarting") : "" })
      : r.error || t("settings.resetFailed"),
  );
  if (r.ok) loadConfig();
}
</script>

<template>
  <Card :title="t('settings.title')">
    <p v-if="!server.isRunning" class="muted">{{ t("settings.startToEdit") }}</p>
    <p v-else-if="!loaded" class="muted">{{ t("common.loading") }}</p>
    <template v-else>
      <Field :label="t('settings.filterPlaceholder')" label-sr-only v-slot="{ id }">
        <input :id="id" v-model="cfgSearch" :placeholder="t('settings.filterPlaceholder')" class="search-box" />
      </Field>

      <details v-for="g in cfgGroups" :key="g.title" class="section" open>
        <summary>{{ g.title }}<span class="count">{{ g.items.length }}</span></summary>
        <div class="grid">
          <template v-for="it in g.items" :key="it.key">
            <label v-if="it.type === 'boolean'" class="switch" :for="'cfg-' + it.key">
              <input :id="'cfg-' + it.key" v-model="it.value" type="checkbox" />
              <span>{{ human(it.key) }}<br /><span class="muted key-hint">{{ it.key }}</span></span>
            </label>
            <div v-else class="field">
              <label :for="'cfg-' + it.key">{{ human(it.key) }}<br /><span class="muted key-hint">{{ it.key }}</span></label>
              <select v-if="ENUMS[it.key]" :id="'cfg-' + it.key" v-model="it.value">
                <option v-for="o in ENUMS[it.key]" :key="o" :value="o">{{ o }}</option>
              </select>
              <input
                v-else-if="it.type === 'number'"
                :id="'cfg-' + it.key"
                v-model.number="it.value"
                type="number"
                step="any"
              />
              <input v-else :id="'cfg-' + it.key" v-model="it.value" :type="isSecret(it.key) ? 'password' : 'text'" />
            </div>
          </template>
        </div>
      </details>

      <div class="row end">
        <Btn variant="ghost" class="reset-btn" busy-key="settings" @click="resetConfig">
          {{ t("settings.reset") }}
        </Btn>
        <label class="row inline-check">
          <input v-model="cfgRestart" type="checkbox" style="width: auto" />
          {{ t("settings.restartAfterSaving") }}
        </label>
        <Btn variant="ghost" busy-key="settings" @click="loadConfig">{{ t("settings.reload") }}</Btn>
        <Btn busy-key="settings" @click="saveFields">{{ t("settings.saveFields") }}</Btn>
      </div>

      <details class="raw-editor">
        <summary class="muted">{{ t("settings.rawEditor") }}</summary>
        <Field :label="t('settings.rawEditor')" label-sr-only v-slot="{ id }">
          <textarea :id="id" v-model="cfgRaw" spellcheck="false" rows="16"></textarea>
        </Field>
        <div class="row end">
          <Btn busy-key="settings" @click="saveRaw">{{ t("settings.saveRaw") }}</Btn>
        </div>
        <p class="muted mono">{{ cfgPath }}</p>
      </details>
    </template>
  </Card>
</template>

<style scoped>
.search-box {
  margin-bottom: 12px;
}
.section {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-bottom: 10px;
}
.section summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
}
.count {
  color: var(--muted);
  font-weight: 400;
  margin-left: 6px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
  margin-top: 12px;
}
.field label,
.switch span {
  display: block;
  font-size: 12px;
  margin-bottom: 4px;
}
.key-hint {
  font-size: 10px;
}
.switch {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}
.switch input {
  width: auto;
  margin-top: 3px;
}
.row {
  display: flex;
  gap: 10px;
  align-items: center;
}
.row.end {
  justify-content: flex-end;
  margin-top: 14px;
}
.reset-btn {
  margin-right: auto; /* push the destructive reset to the far left, away from Save */
  color: var(--danger);
}
.reset-btn:hover {
  border-color: var(--danger);
  color: var(--danger);
  background: transparent;
}
.inline-check {
  font-size: 13px;
}
.raw-editor {
  margin-top: 16px;
}
.raw-editor summary {
  cursor: pointer;
}
.raw-editor textarea {
  margin-top: 8px;
  width: 100%;
}
</style>

<!--
  ModsView: capability-aware, dual-mode mods UI against /api/mods* (see
  docs/FRONTEND_V2_PLAN.md). GET /api/mods returns runtime_mode + capabilities
  (pak/logic always true, ue4ss only in Proton mode) + the mod list. Upload
  (.pak or .zip) and install-by-URL both route through the same
  layout-detecting placement server-side; a UE4SS/script archive on a native
  server comes back as a 409 that we surface as a normal error toast, never a
  crash. The UE4SS runtime installer button is disabled (with a tooltip) when
  not running Proton.
-->
<script setup>
import { onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { apiDelete, apiGet, apiPost, apiUpload } from "../api.js";
import Badge from "../components/ui/Badge.vue";
import Btn from "../components/ui/Btn.vue";
import Card from "../components/ui/Card.vue";
import DataTable from "../components/ui/DataTable.vue";
import Field from "../components/ui/Field.vue";
import { useConfirm } from "../components/ui/useConfirm.js";
import { useToast } from "../components/ui/useToast.js";
import { useServerStore } from "../stores/server.js";
import { useSessionStore } from "../stores/session.js";

const { t } = useI18n();
const session = useSessionStore();
const server = useServerStore();
const toast = useToast();
const { confirm } = useConfirm();

const mods = ref([]);
const runtimeMode = ref("native");
const capabilities = ref({ pak: true, logic: true, ue4ss: false });

const modUrl = ref("");
const modUrlName = ref("");
const uploadFile = ref(null);
const ue4ssUrl = ref("");

async function loadMods() {
  if (!server.isRunning) {
    mods.value = [];
    return;
  }
  const r = await apiGet("/api/mods", { key: "mods" });
  if (r.ok) {
    mods.value = r.data.mods || [];
    runtimeMode.value = r.data.runtime_mode || "native";
    capabilities.value = r.data.capabilities || { pak: true, logic: true, ue4ss: false };
  } else {
    toast.error(r.error || t("mods.loadFailed"));
  }
}

onMounted(loadMods);
watch(() => server.isRunning, loadMods);

function fmtSize(bytes) {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let n = Number(bytes);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtDate(value) {
  if (value == null || value === "") return "—";
  const d = typeof value === "number" ? new Date(value > 1e12 ? value : value * 1000) : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

async function installByUrl() {
  const url = modUrl.value.trim();
  if (!url) {
    toast.error(t("mods.urlRequired"));
    return;
  }
  const r = await apiPost(
    "/api/mods/url",
    { url, name: modUrlName.value.trim() },
    { key: "mods", query: "restart=false" },
  );
  if (r.ok) {
    toast.ok(t("mods.installDone", { name: r.data.name || r.data.installed?.[0] || url }));
    modUrl.value = "";
    modUrlName.value = "";
    loadMods();
  } else {
    toast.error(r.error || t("mods.installFailed"));
  }
}

function pickFile(e) {
  uploadFile.value = e.target.files[0] || null;
}

async function uploadMod() {
  const f = uploadFile.value;
  if (!f) {
    toast.error(t("mods.chooseFileFirst"));
    return;
  }
  const lower = f.name.toLowerCase();
  if (!lower.endsWith(".pak") && !lower.endsWith(".zip")) {
    toast.error(t("mods.invalidFileType"));
    return;
  }
  const r = await apiUpload("/api/mods/upload", f, {
    key: "mods",
    query: `name=${encodeURIComponent(f.name)}&restart=false`,
  });
  if (r.ok) {
    toast.ok(t("mods.uploadDone", { name: r.data.name || r.data.installed?.[0] || f.name }));
    uploadFile.value = null;
    loadMods();
  } else {
    toast.error(r.error || t("mods.uploadFailed"));
  }
}

async function toggleMod(mod) {
  const action = mod.enabled ? "disable" : "enable";
  const r = await apiPost(`/api/mods/${encodeURIComponent(mod.name)}/${action}`, {}, { key: "mods" });
  if (r.ok) {
    toast.ok(mod.enabled ? t("mods.disableDone") : t("mods.enableDone"));
    loadMods();
  } else {
    toast.error(r.error || t("mods.toggleFailed"));
  }
}

async function removeMod(mod) {
  const ok = await confirm({
    message: t("mods.confirmDelete", { name: mod.name }),
    confirmLabel: t("mods.remove"),
    danger: true,
  });
  if (!ok) return;
  const r = await apiDelete(`/api/mods/${encodeURIComponent(mod.name)}`, { key: "mods" });
  if (r.ok) {
    toast.ok(t("mods.deleteDone"));
    loadMods();
  } else {
    toast.error(r.error || t("mods.deleteFailed"));
  }
}

async function restartServer() {
  const ok = await confirm({ message: t("mods.confirmRestart"), confirmLabel: t("mods.restartToApply") });
  if (!ok) return;
  const r = await apiPost("/api/restart", {}, { key: "mods" });
  toast[r.ok ? "ok" : "error"](r.ok ? t("mods.restartDone") : r.error || t("mods.restartFailed"));
}

async function installUe4ss() {
  const r = await apiPost("/api/mods/ue4ss/install", { url: ue4ssUrl.value.trim() }, { key: "ue4ss" });
  if (r.ok) {
    toast.ok(t("mods.ue4ssInstallDone"));
    ue4ssUrl.value = "";
    loadMods();
  } else {
    toast.error(r.error || t("mods.ue4ssInstallFailed"));
  }
}
</script>

<template>
  <div class="mods-view">
    <Card v-if="!server.isRunning">
      <p class="muted">{{ t("mods.startToManage") }}</p>
    </Card>

    <template v-else>
      <div v-if="runtimeMode !== 'proton'" class="native-banner" role="status">
        <Badge tone="warn">⚠</Badge>
        {{ t("mods.nativeBanner") }}
      </div>

      <Card :title="t('mods.installTitle')" :hint="t('mods.installHint')">
        <div class="install-block">
          <p class="block-label">{{ t("mods.byUrl") }}</p>
          <div class="row">
            <Field :label="t('mods.byUrl')" label-sr-only class="grow" v-slot="{ id }">
              <input :id="id" v-model="modUrl" :placeholder="t('mods.urlPlaceholder')" />
            </Field>
            <Field :label="t('mods.nameOptional')" label-sr-only v-slot="{ id }">
              <input :id="id" v-model="modUrlName" :placeholder="t('mods.nameOptional')" style="max-width: 200px" />
            </Field>
            <Btn icon="↧" :aria-label="t('mods.download')" busy-key="mods" @click="installByUrl" />
          </div>
        </div>

        <div class="install-block">
          <p class="block-label">{{ t("mods.byUpload") }}</p>
          <div class="row">
            <Field :label="t('mods.chooseFile')" label-sr-only class="grow" v-slot="{ id }">
              <input :id="id" type="file" accept=".pak,.zip" @change="pickFile" />
            </Field>
            <Btn icon="↥" :aria-label="t('mods.upload')" busy-key="mods" @click="uploadMod" />
          </div>
        </div>
      </Card>

      <Card :title="t('mods.installedTitle', { count: mods.length })">
        <DataTable
          :columns="[
            { key: 'name', label: t('mods.colName') },
            { key: 'type', label: t('mods.colType') },
            { key: 'enabled', label: t('mods.colStatus') },
            { key: 'source_url', label: t('mods.colSource') },
            { key: 'installed_at', label: t('mods.colInstalledAt') },
            { key: 'size', label: t('mods.colSize'), align: 'right' },
            { key: 'actions', label: t('mods.colActions'), align: 'right' },
          ]"
          :rows="mods"
          row-key="name"
          :empty-text="t('mods.noMods')"
        >
          <template #cell-name="{ value }"><span class="mono break">{{ value }}</span></template>
          <template #cell-type="{ value }"><Badge>{{ value }}</Badge></template>
          <template #cell-enabled="{ value }">
            <Badge :tone="value ? 'ok' : 'neutral'">{{ value ? t("mods.enabled") : t("mods.disabled") }}</Badge>
          </template>
          <template #cell-source_url="{ value }">
            <span class="mono clamp src-cell" :title="value || ''">{{ value || "—" }}</span>
          </template>
          <template #cell-installed_at="{ value }">{{ fmtDate(value) }}</template>
          <template #cell-size="{ value }">{{ fmtSize(value) }}</template>
          <template #cell-actions="{ row }">
            <div class="actions end">
              <Btn
                size="sm"
                :variant="row.enabled ? 'ghost' : 'ok'"
                icon="⏻"
                :aria-label="`${row.enabled ? t('mods.disable') : t('mods.enable')}: ${row.name}`"
                busy-key="mods"
                @click="toggleMod(row)"
              />
              <Btn
                size="sm"
                variant="danger"
                icon="✕"
                :aria-label="`${t('mods.remove')}: ${row.name}`"
                busy-key="mods"
                @click="removeMod(row)"
              />
            </div>
          </template>
        </DataTable>
        <div class="row end">
          <Btn
            variant="ghost"
            icon="↻"
            :aria-label="t('mods.restartToApply')"
            busy-key="mods"
            :disabled="!session.can('settings')"
            @click="restartServer"
          />
        </div>
      </Card>

      <Card :title="t('mods.ue4ssTitle')" :hint="t('mods.ue4ssHint')">
        <div class="row">
          <Field :label="t('mods.ue4ssUrlOptional')" class="grow" v-slot="{ id }">
            <input :id="id" v-model="ue4ssUrl" :disabled="!capabilities.ue4ss" placeholder="https://…" />
          </Field>
          <span :title="!capabilities.ue4ss ? t('mods.ue4ssNotProton') : ''">
            <Btn
              icon="⬡"
              :aria-label="t('mods.ue4ssInstall')"
              busy-key="ue4ss"
              :disabled="!capabilities.ue4ss"
              @click="installUe4ss"
            />
          </span>
        </div>
      </Card>
    </template>
  </div>
</template>

<style scoped>
.mods-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.native-banner {
  background: var(--panel-2);
  border: 1px solid var(--warn);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--warn);
}
.install-block + .install-block {
  margin-top: 14px;
}
.block-label {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--muted);
}
.row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
.row.end {
  justify-content: flex-end;
  margin-top: 12px;
}
.row .grow {
  flex: 1;
}
.src-cell {
  max-width: 220px;
}
</style>

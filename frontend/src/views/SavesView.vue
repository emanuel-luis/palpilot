<!--
  SavesView: save-slot lifecycle against /api/saves* (see docs/FRONTEND_V2_PLAN.md).
  List slots (active/empty badges, size, last_backup), create, activate (confirm:
  saves+backup+restart), backup, per-slot expandable Backups list + Restore
  (confirm) + Restore-as-new, Clone (name prompt), Rename (name prompt), delete
  (confirm). Only usable while the VM is RUNNING (slots live on the VM disk),
  matching the legacy tab's gating.
-->
<script setup>
import { onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { apiDelete, apiDownload, apiGet, apiPost } from "../api.js";
import Badge from "../components/ui/Badge.vue";
import Btn from "../components/ui/Btn.vue";
import Card from "../components/ui/Card.vue";
import DataTable from "../components/ui/DataTable.vue";
import Field from "../components/ui/Field.vue";
import Modal from "../components/ui/Modal.vue";
import { useConfirm } from "../components/ui/useConfirm.js";
import { useToast } from "../components/ui/useToast.js";
import { useServerStore } from "../stores/server.js";

const { t } = useI18n();
const server = useServerStore();
const toast = useToast();
const { confirm } = useConfirm();

const slots = ref([]);
const newName = ref("");

// guid -> {open, loaded, list}
const backupsState = reactive({});
function ensureBackups(guid) {
  if (!backupsState[guid]) backupsState[guid] = reactive({ open: false, loaded: false, list: [] });
  return backupsState[guid];
}

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

async function loadSlots() {
  if (!server.isRunning) {
    slots.value = [];
    return;
  }
  const r = await apiGet("/api/saves", { key: "saves" });
  if (r.ok) {
    slots.value = r.data.slots || [];
    slots.value.forEach((s) => ensureBackups(s.guid));
  } else {
    toast.error(r.error || t("saves.loadFailed"));
  }
}

onMounted(loadSlots);
watch(() => server.isRunning, loadSlots);

async function createSlot() {
  const name = newName.value.trim();
  if (!name) {
    toast.error(t("saves.enterName"));
    return;
  }
  const r = await apiPost("/api/saves", { name }, { key: "saves" });
  if (r.ok) {
    toast.ok(t("saves.slotCreated", { name: r.data.name }));
    newName.value = "";
    loadSlots();
  } else {
    toast.error(r.error || t("saves.createFailed"));
  }
}

async function activateSlot(slot) {
  const ok = await confirm({
    message: t("saves.confirmActivate", { name: slot.name }),
    confirmLabel: t("saves.activate"),
  });
  if (!ok) return;
  const r = await apiPost(`/api/saves/${encodeURIComponent(slot.guid)}/activate`, {}, {
    key: "saves",
    query: "restart=true",
  });
  if (r.ok) {
    toast.ok(t("saves.activateDone", { name: slot.name }));
    loadSlots();
  } else {
    toast.error(r.error || t("saves.activateFailed"));
  }
}

async function backupSlot(slot) {
  const r = await apiPost(`/api/saves/${encodeURIComponent(slot.guid)}/backup`, {}, { key: "saves" });
  if (r.ok) toast.ok(t("saves.backupDone"));
  else toast.error(r.error || t("saves.backupFailed"));
  loadSlots();
  if (ensureBackups(slot.guid).open) loadBackups(slot);
}

async function downloadCurrent(slot) {
  toast.ok(t("saves.downloadPreparing"));
  const r = await apiDownload(
    `/api/saves/${encodeURIComponent(slot.guid)}/download`,
    `${slot.name}-current.tar.gz`,
  );
  if (!r.ok) toast.error(r.error || t("saves.downloadFailed"));
}

async function downloadBackup(slot, backup) {
  toast.ok(t("saves.downloadPreparing"));
  const r = await apiDownload(
    `/api/saves/${encodeURIComponent(slot.guid)}/backups/${encodeURIComponent(backup.ref)}/download`,
    backup.file,
  );
  if (!r.ok) toast.error(r.error || t("saves.downloadFailed"));
}

async function deleteSlot(slot) {
  const ok = await confirm({
    message: t("saves.confirmDelete", { name: slot.name }),
    confirmLabel: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  const r = await apiDelete(`/api/saves/${encodeURIComponent(slot.guid)}`, { key: "saves" });
  if (r.ok) {
    toast.ok(t("saves.deleteDone"));
    loadSlots();
  } else {
    toast.error(r.error || t("saves.deleteFailed"));
  }
}

async function toggleBackups(slot) {
  const st = ensureBackups(slot.guid);
  st.open = !st.open;
  if (st.open && !st.loaded) await loadBackups(slot);
}

async function loadBackups(slot) {
  const st = ensureBackups(slot.guid);
  const r = await apiGet(`/api/saves/${encodeURIComponent(slot.guid)}/backups`, { key: "saves-backups" });
  if (r.ok) {
    st.list = r.data.backups || [];
    st.loaded = true;
  } else {
    toast.error(r.error || t("saves.backupsLoadFailed"));
  }
}

// ---------------------------------------------------------------------------
// clone / rename — single name-prompt modal shared by both flows
// ---------------------------------------------------------------------------

const promptModal = reactive({ open: false, mode: "", slot: null, backup: null, value: "" });

function openClone(slot) {
  promptModal.open = true;
  promptModal.mode = "clone";
  promptModal.slot = slot;
  promptModal.value = `${slot.name} (copy)`;
}

function openRename(slot) {
  promptModal.open = true;
  promptModal.mode = "rename";
  promptModal.slot = slot;
  promptModal.value = slot.name;
}

function openRestoreAsNew(slot, backup) {
  promptModal.open = true;
  promptModal.mode = "restoreAsNew";
  promptModal.slot = slot;
  promptModal.backup = backup;
  promptModal.value = `${slot.name} (restored)`;
}

function closePrompt() {
  promptModal.open = false;
}

const promptTitle = () => {
  if (!promptModal.slot) return "";
  if (promptModal.mode === "clone") return t("saves.cloneModalTitle", { name: promptModal.slot.name });
  if (promptModal.mode === "rename") return t("saves.renameModalTitle", { name: promptModal.slot.name });
  return t("saves.restoreAsNewModalTitle");
};

const promptFieldLabel = () => {
  if (promptModal.mode === "clone") return t("saves.cloneNameLabel");
  if (promptModal.mode === "rename") return t("saves.renameNameLabel");
  return t("saves.restoreAsNewNameLabel");
};

async function submitPrompt() {
  const name = promptModal.value.trim();
  if (!name) return;
  const slot = promptModal.slot;

  if (promptModal.mode === "clone") {
    const r = await apiPost(`/api/saves/${encodeURIComponent(slot.guid)}/clone`, { name }, { key: "saves" });
    if (r.ok) {
      toast.ok(t("saves.cloneDone", { name: r.data.name }));
      if (r.data.note) toast.ok(r.data.note);
      closePrompt();
      loadSlots();
    } else {
      toast.error(r.error || t("saves.cloneFailed"));
    }
    return;
  }

  if (promptModal.mode === "rename") {
    const r = await apiPost(`/api/saves/${encodeURIComponent(slot.guid)}/rename`, { name }, { key: "saves" });
    if (r.ok) {
      toast.ok(t("saves.renameDone", { name: r.data.name }));
      closePrompt();
      loadSlots();
    } else {
      toast.error(r.error || t("saves.renameFailed"));
    }
    return;
  }

  if (promptModal.mode === "restoreAsNew") {
    const backup = promptModal.backup;
    closePrompt();
    const ok = await confirm({
      message: t("saves.confirmRestoreAsNew", { file: backup.file, name }),
      confirmLabel: t("saves.restore"),
      danger: true,
    });
    if (!ok) return;
    await doRestore(slot, backup, true, name);
  }
}

async function restoreBackup(slot, backup) {
  const ok = await confirm({
    message: t("saves.confirmRestore", { file: backup.file, name: slot.name }),
    confirmLabel: t("saves.restore"),
    danger: true,
  });
  if (!ok) return;
  await doRestore(slot, backup, false, "");
}

async function doRestore(slot, backup, asNew, name) {
  const body = { ref: backup.ref };
  if (asNew) {
    body.as_new_slot = true;
    body.name = name;
  }
  const r = await apiPost(`/api/saves/${encodeURIComponent(slot.guid)}/restore`, body, { key: "saves-backups" });
  if (r.ok) {
    toast.ok(t("saves.restoreDone"));
    ensureBackups(slot.guid).open = false;
    loadSlots();
  } else {
    toast.error(r.error || t("saves.restoreFailed"));
  }
}

const BACKUP_COLUMNS = [
  { key: "file", label: t("saves.colFile") },
  { key: "location", label: t("saves.colLocation") },
  { key: "size", label: t("saves.colSize"), align: "right" },
  { key: "created", label: t("saves.colCreated") },
  { key: "actions", label: t("saves.colActions"), align: "right" },
];
</script>

<template>
  <div class="saves-view">
    <Card v-if="!server.isRunning">
      <p class="muted">{{ t("saves.startToManage") }}</p>
    </Card>

    <template v-else>
      <Card :title="t('saves.newSlotTitle')" :hint="t('saves.newSlotHint')">
        <form class="row" @submit.prevent="createSlot">
          <Field :label="t('saves.nameLabel')" label-sr-only class="grow" v-slot="{ id }">
            <input :id="id" v-model="newName" :placeholder="t('saves.namePlaceholder')" />
          </Field>
          <Btn type="submit" busy-key="saves">{{ t("saves.create") }}</Btn>
        </form>
      </Card>

      <Card :title="t('saves.listTitle', { count: slots.length })" :hint="t('saves.listHint')">
        <div class="scroll-x">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">{{ t("saves.colName") }}</th>
                <th scope="col">{{ t("saves.colGuid") }}</th>
                <th scope="col" style="text-align: right">{{ t("saves.colSize") }}</th>
                <th scope="col">{{ t("saves.colLastBackup") }}</th>
                <th scope="col" style="text-align: right">
                  <span class="sr-only">{{ t("saves.colActions") }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <template v-for="s in slots" :key="s.guid">
                <tr>
                  <td>
                    <span class="name-cell">
                      <span class="clamp" :title="s.name">{{ s.name }}</span>
                      <Badge v-if="s.active" tone="ok">{{ t("saves.badgeActive") }}</Badge>
                      <Badge v-if="s.pending" tone="warn">{{ t("saves.badgePending") }}</Badge>
                      <Badge v-else-if="s.empty">{{ t("saves.badgeEmpty") }}</Badge>
                    </span>
                  </td>
                  <td class="mono break">{{ s.guid }}</td>
                  <td style="text-align: right">{{ fmtSize(s.size) }}</td>
                  <td>{{ fmtDate(s.last_backup) }}</td>
                  <td>
                    <div class="actions end equal">
                      <Btn
                        v-if="!s.active"
                        size="sm"
                        variant="ok"
                        :aria-label="`${t('saves.activate')}: ${s.name}`"
                        busy-key="saves"
                        @click="activateSlot(s)"
                      >{{ t("saves.activate") }}</Btn>
                      <Btn
                        size="sm"
                        variant="ghost"
                        :aria-label="`${t('saves.backup')}: ${s.name}`"
                        busy-key="saves"
                        :disabled="s.empty"
                        @click="backupSlot(s)"
                      >{{ t("saves.backup") }}</Btn>
                      <Btn
                        size="sm"
                        variant="ghost"
                        :aria-label="`${t('saves.downloadCurrent')}: ${s.name}`"
                        busy-key="saves"
                        :disabled="s.empty"
                        @click="downloadCurrent(s)"
                      >{{ t("saves.download") }}</Btn>
                      <Btn
                        size="sm"
                        variant="ghost"
                        :aria-label="`${t('saves.clone')}: ${s.name}`"
                        busy-key="saves"
                        @click="openClone(s)"
                      >{{ t("saves.clone") }}</Btn>
                      <Btn
                        size="sm"
                        variant="ghost"
                        :aria-label="`${t('saves.rename')}: ${s.name}`"
                        busy-key="saves"
                        @click="openRename(s)"
                      >{{ t("saves.rename") }}</Btn>
                      <Btn
                        size="sm"
                        variant="ghost"
                        class="chevron-btn"
                        :class="{ open: ensureBackups(s.guid).open }"
                        :aria-label="
                          ensureBackups(s.guid).open
                            ? `${t('saves.hideBackups')}: ${s.name}`
                            : `${t('saves.showBackups')}: ${s.name}`
                        "
                        busy-key="saves-backups"
                        @click="toggleBackups(s)"
                      ><span class="chevron-glyph" aria-hidden="true">›</span>{{ t("saves.backups") }}</Btn>
                      <Btn
                        size="sm"
                        variant="danger"
                        :aria-label="`${t('common.delete')}: ${s.name}`"
                        busy-key="saves"
                        :disabled="s.active"
                        @click="deleteSlot(s)"
                      >{{ t("common.delete") }}</Btn>
                    </div>
                  </td>
                </tr>
                <tr v-if="ensureBackups(s.guid).open">
                  <td colspan="5" class="backups-cell">
                    <h3 class="backups-title">{{ t("saves.backupsFor", { name: s.name }) }}</h3>
                    <p v-if="!ensureBackups(s.guid).loaded" class="muted">{{ t("saves.loadingBackups") }}</p>
                    <p v-else-if="!ensureBackups(s.guid).list.length" class="muted">{{ t("saves.noBackups") }}</p>
                    <DataTable
                      v-else
                      :columns="BACKUP_COLUMNS"
                      :rows="ensureBackups(s.guid).list"
                      row-key="ref"
                    >
                      <template #cell-file="{ value }"><span class="mono break">{{ value }}</span></template>
                      <template #cell-size="{ value }">{{ fmtSize(value) }}</template>
                      <template #cell-created="{ value }">{{ fmtDate(value) }}</template>
                      <template #cell-actions="{ row }">
                        <div class="actions end equal">
                          <Btn
                            size="sm"
                            variant="ghost"
                            :aria-label="`${t('saves.restore')}: ${row.file}`"
                            busy-key="saves-backups"
                            @click="restoreBackup(s, row)"
                          >{{ t("saves.restore") }}</Btn>
                          <Btn
                            size="sm"
                            variant="ghost"
                            :aria-label="`${t('saves.restoreAsNew')}: ${row.file}`"
                            busy-key="saves-backups"
                            @click="openRestoreAsNew(s, row)"
                          >{{ t("saves.restoreAsNew") }}</Btn>
                          <Btn
                            size="sm"
                            variant="ghost"
                            :aria-label="`${t('saves.download')}: ${row.file}`"
                            @click="downloadBackup(s, row)"
                          >{{ t("saves.download") }}</Btn>
                        </div>
                      </template>
                    </DataTable>
                  </td>
                </tr>
              </template>
              <tr v-if="!slots.length">
                <td colspan="5" class="muted empty-row">{{ t("saves.noSavesFound") }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </template>

    <Modal :model-value="promptModal.open" :title="promptTitle()" @close="closePrompt">
      <form @submit.prevent="submitPrompt">
        <Field :label="promptFieldLabel()" v-slot="{ id }">
          <input :id="id" v-model="promptModal.value" autofocus />
        </Field>
      </form>
      <template #footer>
        <Btn variant="ghost" @click="closePrompt">{{ t("common.cancel") }}</Btn>
        <Btn busy-key="saves" @click="submitPrompt">{{ t("common.confirm") }}</Btn>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.name-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.name-cell .clamp {
  min-width: 0;
}
.saves-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
.row .grow {
  flex: 1;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.data-table th,
.data-table td {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.data-table th {
  color: var(--muted);
  font-weight: 500;
  text-align: left;
}
.empty-row {
  text-align: center;
  padding: 16px 8px;
}
.backups-cell {
  background: var(--panel-2);
}
.backups-title {
  margin: 4px 0 10px;
  font-size: 13px;
}
/* Show/hide-backups reuses the Section "expand ›" glyph, rotated open. */
.chevron-glyph {
  display: inline-block;
  transition: transform 0.15s ease;
}
.chevron-btn.open .chevron-glyph {
  transform: rotate(90deg);
}
</style>

<!--
  StatusView: the redesigned Overview. A server "hero" (on/off, name,
  players X/max, uptime, in-game day) with perm-gated quick start/stop,
  a metrics grid, the online-players table, and a "recent backups" panel for
  the currently-active save slot (GET /api/saves for the active guid, then
  GET /api/saves/{guid}/backups — this view only needs the latest few, so it
  fetches directly via api.js rather than pulling in a full saves store,
  which the Saves-view phase owns).
-->
<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import { apiGet } from "../api.js";
import Badge from "../components/ui/Badge.vue";
import Btn from "../components/ui/Btn.vue";
import Card from "../components/ui/Card.vue";
import DataTable from "../components/ui/DataTable.vue";
import StatCard from "../components/ui/StatCard.vue";
import { useConfirm } from "../components/ui/useConfirm.js";
import { useToast } from "../components/ui/useToast.js";
import { useServerStore } from "../stores/server.js";
import { useSessionStore } from "../stores/session.js";

const { t } = useI18n();
const session = useSessionStore();
const server = useServerStore();
const toast = useToast();
const { confirm } = useConfirm();

const PLAYER_COLUMNS = [
  { key: "name", label: t("status.colName") },
  { key: "level", label: t("status.colLevel"), align: "right" },
  { key: "ping", label: t("status.colPing"), align: "right" },
  { key: "userId", label: t("status.colUserId") },
];

function fmtUptime(seconds) {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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

async function onStart() {
  const r = await server.startVm();
  toast[r.ok ? "ok" : "error"](r.ok ? t("status.starting") : r.error || t("status.startFailed"));
}

async function onStop() {
  const ok = await confirm({ message: t("status.confirmStop"), danger: true, confirmLabel: t("status.quickStop") });
  if (!ok) return;
  const r = await server.stopVm();
  toast[r.ok ? "ok" : "error"](r.ok ? t("status.stopping") : r.error || t("status.stopFailed"));
}

// ---------------------------------------------------------------------------
// recent backups (active slot only)
// ---------------------------------------------------------------------------

const backupsLoading = ref(false);
const activeSlotName = ref("");
const recentBackups = ref([]);
const backupsError = ref("");

async function loadRecentBackups() {
  if (!server.isRunning) {
    activeSlotName.value = "";
    recentBackups.value = [];
    return;
  }
  backupsLoading.value = true;
  backupsError.value = "";
  try {
    const savesRes = await apiGet("/api/saves", { key: "status-backups" });
    if (!savesRes.ok) {
      backupsError.value = savesRes.error || t("status.loadFailed");
      return;
    }
    const slots = savesRes.data.slots || [];
    const active = slots.find((s) => s.active) || slots.find((s) => s.guid === savesRes.data.active);
    if (!active) {
      activeSlotName.value = "";
      recentBackups.value = [];
      return;
    }
    activeSlotName.value = active.name || active.guid;
    const backupsRes = await apiGet(`/api/saves/${encodeURIComponent(active.guid)}/backups`, {
      key: "status-backups",
    });
    if (backupsRes.ok) {
      recentBackups.value = (backupsRes.data.backups || [])
        .slice()
        .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
        .slice(0, 5);
    } else {
      backupsError.value = backupsRes.error || t("status.loadFailed");
    }
  } finally {
    backupsLoading.value = false;
  }
}

let unwatchRunning = null;
onMounted(() => {
  loadRecentBackups();
  // Re-check whenever the VM transitions to RUNNING (e.g. after Start).
  unwatchRunning = setInterval(() => {
    if (server.isRunning && !activeSlotName.value && !backupsLoading.value) loadRecentBackups();
  }, 8000);
});
onUnmounted(() => clearInterval(unwatchRunning));
</script>

<template>
  <div class="status-view">
    <Card>
      <div class="hero">
        <div class="hero-main">
          <span class="hero-dot" :class="{ on: server.isRunning, busy: server.isTransitioning }"></span>
          <div>
            <h1 class="hero-name">{{ server.info?.servername || t("app.title") }}</h1>
            <p class="hero-status muted">
              <template v-if="server.isRunning">{{ t("status.heroOnline") }}</template>
              <template v-else-if="server.isTransitioning">{{
                t("status.heroTransitioning", { status: server.vm.status })
              }}</template>
              <template v-else>{{ t("status.heroOffline") }}</template>
            </p>
          </div>
        </div>
        <div class="hero-stats" v-if="server.isRunning && server.metrics">
          <div class="hero-stat">
            <div class="hero-stat-value">
              {{ t("status.players", { current: server.metrics.currentplayernum ?? "—", max: server.metrics.maxplayernum ?? "—" }) }}
            </div>
          </div>
          <div class="hero-stat">
            <div class="hero-stat-value">{{ fmtUptime(server.metrics.uptime) }}</div>
            <div class="hero-stat-label muted">{{ t("status.uptime") }}</div>
          </div>
          <div class="hero-stat">
            <div class="hero-stat-value">{{ t("status.inGameDay", { day: server.metrics.days ?? "—" }) }}</div>
          </div>
        </div>
        <div class="hero-actions">
          <Btn v-if="session.can('power') && server.canStart" variant="ok" busy-key="vm-power" @click="onStart">
            ▶ {{ t("status.quickStart") }}
          </Btn>
          <Btn v-else-if="session.can('power') && server.isRunning" variant="danger" busy-key="vm-power" @click="onStop">
            ■ {{ t("status.quickStop") }}
          </Btn>
          <span v-else-if="!session.can('power') && !server.isRunning" class="muted">{{ t("status.noStartPermission") }}</span>
        </div>
      </div>
    </Card>

    <div class="metrics-grid" v-if="server.isRunning && server.metrics">
      <StatCard :label="t('status.metricFps')" :value="server.metrics.serverfps ?? '—'" />
      <StatCard :label="t('status.metricPlayers')" :value="server.metrics.currentplayernum ?? '—'" />
      <StatCard :label="t('status.metricMax')" :value="server.metrics.maxplayernum ?? '—'" />
      <StatCard :label="t('status.metricFrametime')" :value="server.metrics.serverframetime ?? '—'" />
      <StatCard :label="t('status.metricDays')" :value="server.metrics.days ?? '—'" />
    </div>
    <Card v-else-if="server.isRunning">
      <p class="muted">{{ t("status.noMetrics") }}</p>
    </Card>

    <Card :title="t('status.playersTitle', { count: server.players.length })">
      <DataTable
        :columns="PLAYER_COLUMNS"
        :rows="server.players"
        row-key="userId"
        :empty-text="server.isRunning ? t('status.noPlayersOnline') : t('status.noPlayersOffline')"
      >
        <template #cell-userId="{ value }"><span class="mono">{{ value }}</span></template>
        <template #cell-ping="{ value }">{{ value != null ? Math.round(value) : "—" }}</template>
      </DataTable>
    </Card>

    <Card :title="t('status.recentBackups')" :hint="t('status.recentBackupsHint')">
      <p v-if="backupsLoading" class="muted">{{ t("common.loading") }}</p>
      <p v-else-if="backupsError" class="muted">{{ backupsError }}</p>
      <p v-else-if="!server.isRunning" class="muted">{{ t("status.startServerToSeeBackups") }}</p>
      <p v-else-if="!activeSlotName" class="muted">{{ t("status.noActiveSlot") }}</p>
      <template v-else>
        <p class="active-slot-name">
          {{ activeSlotName }} <Badge tone="ok">{{ t("status.activeBadge") }}</Badge>
        </p>
        <DataTable
          v-if="recentBackups.length"
          :columns="[
            { key: 'file', label: t('status.colBackupFile') },
            { key: 'location', label: t('status.colBackupLocation') },
            { key: 'size', label: t('status.colBackupSize'), align: 'right' },
            { key: 'created', label: t('status.colBackupCreated') },
          ]"
          :rows="recentBackups"
          row-key="ref"
        >
          <template #cell-file="{ value }"><span class="mono">{{ value }}</span></template>
          <template #cell-size="{ value }">{{ fmtSize(value) }}</template>
          <template #cell-created="{ value }">{{ fmtDate(value) }}</template>
        </DataTable>
        <p v-else class="muted">{{ t("status.noBackupsYet") }}</p>
      </template>
    </Card>
  </div>
</template>

<style scoped>
.status-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.hero {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}
.hero-main {
  display: flex;
  align-items: center;
  gap: 14px;
}
.hero-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--danger);
  flex-shrink: 0;
}
.hero-dot.on {
  background: var(--ok);
  box-shadow: 0 0 12px var(--ok);
}
.hero-dot.busy {
  background: var(--warn);
  box-shadow: 0 0 12px var(--warn);
}
.hero-name {
  margin: 0;
  font-size: 20px;
}
.hero-status {
  margin: 2px 0 0;
  font-size: 13px;
}
.hero-stats {
  display: flex;
  gap: 24px;
  flex: 1;
}
.hero-stat-value {
  font-size: 16px;
  font-weight: 600;
}
.hero-stat-label {
  font-size: 11px;
  text-transform: uppercase;
}
.hero-actions {
  margin-left: auto;
}
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}
.active-slot-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  font-weight: 600;
}
</style>

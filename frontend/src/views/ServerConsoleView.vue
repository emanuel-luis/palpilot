<!--
  ServerConsoleView: the one Console (docs/CONSOLE_V3_PLAN.md §B) — a power
  state hero followed by every server feature as a labelled, perm-gated
  section: Saves, then Settings + Mods under "Active World" (they act on the
  active save slot until the backend grows true per-slot config), then
  Commands + Watchdog. Each feature keeps its own view/logic (SavesView,
  SettingsView, ModsView, CommandsView, WatchdogView); this view only
  arranges + labels + gates them. Retires the old standalone StatusView — its
  hero (server store data: vm status, world name, players, uptime, day) now
  lives here as the Console's header, and its metrics grid/players
  table/recent-backups panel are superseded by Saves' own backup list.
-->
<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import Card from "../components/ui/Card.vue";
import Btn from "../components/ui/Btn.vue";
import Section from "../components/ui/Section.vue";
import { useConfirm } from "../components/ui/useConfirm.js";
import { useToast } from "../components/ui/useToast.js";
import { useServerStore } from "../stores/server.js";
import { useSessionStore } from "../stores/session.js";
import CommandsView from "./CommandsView.vue";
import ModsView from "./ModsView.vue";
import SavesView from "./SavesView.vue";
import SettingsView from "./SettingsView.vue";
import WatchdogView from "./WatchdogView.vue";

const { t } = useI18n();
const session = useSessionStore();
const server = useServerStore();
const toast = useToast();
const { confirm } = useConfirm();

function fmtUptime(seconds) {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function onStart() {
  const r = await server.startVm();
  toast[r.ok ? "ok" : "error"](r.ok ? t("console.hero.starting") : r.error || t("console.hero.startFailed"));
}

async function onStop() {
  const ok = await confirm({
    message: t("console.hero.confirmStop"),
    danger: true,
    confirmLabel: t("console.hero.stop"),
  });
  if (!ok) return;
  const r = await server.stopVm();
  toast[r.ok ? "ok" : "error"](r.ok ? t("console.hero.stopping") : r.error || t("console.hero.stopFailed"));
}

const refreshing = ref(false);
async function onRefresh() {
  refreshing.value = true;
  try {
    await server.pollOverview();
  } finally {
    refreshing.value = false;
  }
}

// Re-poll a little more eagerly while this view is mounted so the hero feels
// live without waiting on the shared 8s background interval (App.vue already
// starts/stops that one for the whole session).
let quickPoll = null;
onMounted(() => {
  quickPoll = setInterval(() => server.pollOverview(), 4000);
});
onUnmounted(() => clearInterval(quickPoll));
</script>

<template>
  <div class="console-view">
    <Card v-if="session.can('view')" class="hero-card">
      <div class="hero" :class="{ offline: !server.isRunning && !server.isTransitioning }">
        <div class="hero-main">
          <span class="hero-dot" :class="{ on: server.isRunning, busy: server.isTransitioning }" aria-hidden="true"></span>
          <div class="hero-id">
            <h1 class="hero-name">{{ server.info?.servername || t("app.title") }}</h1>
            <p class="hero-status muted">
              <template v-if="server.isRunning">{{ t("console.hero.online") }}</template>
              <template v-else-if="server.isTransitioning">{{
                t("console.hero.transitioning", { status: server.vm.status })
              }}</template>
              <template v-else>{{ t("console.hero.offline") }}</template>
            </p>
          </div>
        </div>

        <div class="hero-stats">
          <div class="hero-stat">
            <span class="hero-stat-value">
              {{
                server.isRunning && server.metrics
                  ? t("console.hero.players", {
                      current: server.metrics.currentplayernum ?? "—",
                      max: server.metrics.maxplayernum ?? "—",
                    })
                  : "—"
              }}
            </span>
            <span class="hero-stat-label eyebrow">{{ t("console.hero.playersLabel") }}</span>
          </div>
          <div class="hero-stat">
            <span class="hero-stat-value">{{
              server.isRunning && server.metrics ? fmtUptime(server.metrics.uptime) : "—"
            }}</span>
            <span class="hero-stat-label eyebrow">{{ t("console.hero.uptimeLabel") }}</span>
          </div>
          <div class="hero-stat">
            <span class="hero-stat-value">{{
              server.isRunning && server.metrics ? server.metrics.days ?? "—" : "—"
            }}</span>
            <span class="hero-stat-label eyebrow">{{ t("console.hero.dayLabel") }}</span>
          </div>
        </div>

        <div class="actions hero-actions">
          <Btn
            v-if="session.can('power') && server.canStart"
            variant="primary"
            icon="⏻"
            :aria-label="t('console.hero.start')"
            class="power-btn"
            busy-key="vm-power"
            @click="onStart"
          />
          <Btn
            v-else-if="session.can('power') && server.isRunning"
            variant="danger"
            icon="⏻"
            :aria-label="t('console.hero.stop')"
            class="power-btn"
            busy-key="vm-power"
            @click="onStop"
          />
          <span v-else-if="!session.can('power') && !server.isRunning" class="muted no-perm-note">
            {{ t("console.hero.noStartPermission") }}
          </span>
          <Btn variant="ghost" icon="↻" :aria-label="t('common.refresh')" :loading="refreshing" @click="onRefresh" />
        </div>
      </div>
    </Card>

    <Section v-if="session.can('saves')" :title="t('console.sections.saves')">
      <SavesView />
    </Section>

    <template v-if="session.can('settings') || session.can('mods')">
      <h2 class="eyebrow active-world-heading">{{ t("console.activeWorld.title") }}</h2>
      <p class="muted active-world-note">{{ t("console.activeWorld.note") }}</p>

      <Section v-if="session.can('settings')" :title="t('console.sections.settings')" :default-open="false">
        <SettingsView />
      </Section>

      <Section v-if="session.can('mods')" :title="t('console.sections.mods')" :default-open="false">
        <ModsView />
      </Section>
    </template>

    <Section v-if="session.can('commands')" :title="t('console.sections.commands')" :default-open="false">
      <CommandsView />
    </Section>

    <Section v-if="session.can('watchdog')" :title="t('console.sections.watchdog')" :default-open="false">
      <WatchdogView />
    </Section>
  </div>
</template>

<style scoped>
.console-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hero-card {
  padding: 20px 22px;
}
.hero {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
  transition: opacity 0.2s ease, filter 0.2s ease;
}
.hero.offline {
  filter: saturate(0.55);
  opacity: 0.85;
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
  box-shadow: 0 0 0 0 var(--ok);
  animation: hero-breathe 2.4s ease-in-out infinite;
}
.hero-dot.busy {
  background: var(--warn);
  box-shadow: 0 0 12px var(--warn);
}
@keyframes hero-breathe {
  0%,
  100% {
    box-shadow: 0 0 6px 1px var(--ok);
  }
  50% {
    box-shadow: 0 0 14px 4px var(--ok);
  }
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
  gap: 22px;
  flex: 1;
  flex-wrap: wrap;
}
.hero-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hero-stat-value {
  font-family: var(--font-mono);
  font-size: 16px;
  font-weight: 600;
}
.hero-actions {
  margin-left: auto;
}
/* Bump specificity past Btn.vue's own scoped `.btn.icon-only`/`.icon-only.danger`
   defaults (component-internal scoped styles otherwise win on specificity
   regardless of source order) so the hero CTA can be a bigger amber circle —
   "the amber ⏻ power button is the one CTA" — while :not(.danger) leaves the
   stop state's red tint alone. */
.btn.icon-only.power-btn {
  width: 40px;
  height: 40px;
  font-size: 18px;
  border-radius: 50%;
}
.btn.icon-only.power-btn:not(.danger) {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.btn.icon-only.power-btn:not(.danger):hover:not(:disabled) {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.no-perm-note {
  font-size: 12px;
}

.active-world-heading {
  margin: 4px 0 0;
}
.active-world-note {
  margin: 0 0 4px;
  font-size: 12px;
}

@media (max-width: 640px) {
  .hero-actions {
    margin-left: 0;
    width: 100%;
    justify-content: flex-start;
  }
}
</style>

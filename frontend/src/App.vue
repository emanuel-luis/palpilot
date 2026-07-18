<!--
  App shell: TWO nav groups — Console (a single item, the unified
  ServerConsoleView) and Admin (Users, Account) — per docs/CONSOLE_V3_PLAN.md
  §B. Header (server status pill + theme toggle + account menu), a
  router-less view switch (`currentView`, provided to descendants under the
  "nav" key so any view can navigate), and the two singleton overlay hosts
  (Toast, ConfirmDialog).

  No vue-router: 3 nav destinations behind perm gates don't need URL-driven
  routing, and this keeps the single-file build simple. If deep-linking is
  ever wanted, `currentView` is the one place to wire it to location.hash.
-->
<script setup>
import { computed, provide, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Badge from "./components/ui/Badge.vue";
import ConfirmDialog from "./components/ui/ConfirmDialog.vue";
import Toast from "./components/ui/Toast.vue";
import { useConfirm } from "./components/ui/useConfirm.js";
import { useToast } from "./components/ui/useToast.js";
import ThemeToggle from "./components/ui/ThemeToggle.vue";
import { useServerStore } from "./stores/server.js";
import { useSessionStore } from "./stores/session.js";
import AccountView from "./views/AccountView.vue";
import LoginView from "./views/LoginView.vue";
import ServerConsoleView from "./views/ServerConsoleView.vue";
import UsersView from "./views/UsersView.vue";

const { t } = useI18n();
const session = useSessionStore();
const server = useServerStore();
const toast = useToast();
const { confirm } = useConfirm();

// ---------------------------------------------------------------------------
// nav
// ---------------------------------------------------------------------------

// Console shows if the user holds ANY perm a Console section is gated by
// (view/saves/mods/settings/watchdog/commands) — `perms: []` means "always
// visible" (Account), matching the granular perm map in the plan's §C table.
const CONSOLE_PERMS = ["view", "saves", "mods", "settings", "watchdog", "commands"];
const NAV_ITEMS = [
  { id: "console", group: "console", perms: CONSOLE_PERMS, component: ServerConsoleView },
  { id: "users", group: "admin", perms: ["users"], component: UsersView },
  { id: "account", group: "admin", perms: [], component: AccountView },
];
const GROUP_ORDER = ["console", "admin"];

const visibleItems = computed(() =>
  NAV_ITEMS.filter((item) => !item.perms.length || item.perms.some((p) => session.can(p))),
);
const navGroups = computed(() =>
  GROUP_ORDER.map((group) => ({
    id: group,
    label: t(`nav.groups.${group}`),
    items: visibleItems.value.filter((item) => item.group === group),
  })).filter((g) => g.items.length),
);

const currentView = ref("console");
const sidebarOpen = ref(false);

function goTo(id) {
  if (!visibleItems.value.find((item) => item.id === id)) return;
  currentView.value = id;
  sidebarOpen.value = false;
}
provide("nav", reactive({ currentView, goTo }));

// If perms shrink (or on first login) and the current view is no longer
// reachable, fall back to the first visible item instead of a blank page.
watch(
  visibleItems,
  (items) => {
    if (!items.find((item) => item.id === currentView.value)) {
      currentView.value = items[0]?.id || "console";
    }
  },
  { immediate: true },
);

const activeComponent = computed(
  () => visibleItems.value.find((item) => item.id === currentView.value)?.component || null,
);

// ---------------------------------------------------------------------------
// auth-driven polling lifecycle
// ---------------------------------------------------------------------------

watch(
  () => session.isAuthenticated,
  (authed) => {
    if (authed) server.startPolling();
    else server.stopPolling();
  },
  { immediate: true },
);

// ---------------------------------------------------------------------------
// header: VM pill + account menu
// ---------------------------------------------------------------------------

const vmPillTone = computed(() => (server.isRunning ? "ok" : server.isTransitioning ? "warn" : "danger"));

const accountMenuOpen = ref(false);

function openAccount() {
  goTo("account");
  accountMenuOpen.value = false;
}

async function signOut() {
  accountMenuOpen.value = false;
  await session.logout();
}

async function signOutAll() {
  accountMenuOpen.value = false;
  const ok = await confirm({
    title: t("header.account.signOutAll"),
    message: t("account.confirmSignOutAll"),
    confirmLabel: t("header.account.signOutAll"),
    danger: true,
  });
  if (!ok) return;
  const r = await session.logoutAll();
  toast[r.ok ? "ok" : "error"](r.ok ? t("account.signOutAllDone") : t("account.signOutAllFailed"));
}
</script>

<template>
  <LoginView v-if="!session.isAuthenticated" />

  <div v-else class="shell">
    <button
      class="drawer-toggle"
      :aria-label="sidebarOpen ? t('nav.closeMenu') : t('nav.openMenu')"
      :aria-expanded="sidebarOpen"
      @click="sidebarOpen = !sidebarOpen"
    >
      ☰
    </button>

    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span>{{ t("app.title") }}</div>
      <nav v-for="group in navGroups" :key="group.id" class="nav-group" :aria-label="group.label">
        <h2 class="nav-group-label">{{ group.label }}</h2>
        <button
          v-for="item in group.items"
          :key="item.id"
          class="nav-item"
          :class="{ active: currentView === item.id }"
          @click="goTo(item.id)"
        >
          {{ t(`nav.${item.id}`) }}
        </button>
      </nav>
    </aside>

    <div v-if="sidebarOpen" class="drawer-backdrop" @click="sidebarOpen = false"></div>

    <div class="main-col">
      <header class="topbar">
        <span class="pill" :class="vmPillTone">
          <span class="dot"></span>
          {{ t("header.vmStatus", { status: server.vm.status || t("common.unknown") }) }}
        </span>
        <span class="spacer"></span>
        <ThemeToggle />
        <div class="account-menu">
          <button
            class="icon-btn"
            :aria-label="t('header.account.menu')"
            :aria-expanded="accountMenuOpen"
            @click="accountMenuOpen = !accountMenuOpen"
          >
            {{ session.user.slice(0, 1).toUpperCase() || "?" }}
          </button>
          <div v-if="accountMenuOpen" class="account-dropdown" @focusout="accountMenuOpen = false">
            <p class="account-dropdown-user">{{ t("header.account.signedInAs", { user: session.user }) }}</p>
            <button class="dropdown-item" @click="openAccount">
              {{ t("header.account.account") }}
            </button>
            <button class="dropdown-item" @click="signOut">{{ t("header.account.signOut") }}</button>
            <button class="dropdown-item danger" @click="signOutAll">{{ t("header.account.signOutAll") }}</button>
          </div>
        </div>
      </header>

      <div v-if="server.stale" class="stale-banner" role="status" aria-live="polite">
        <Badge tone="warn">⚠</Badge>
        {{ t("header.staleData") }}
      </div>

      <main class="content">
        <component :is="activeComponent" v-if="activeComponent" />
      </main>
    </div>
  </div>

  <Toast />
  <ConfirmDialog />
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
}

.drawer-toggle {
  display: none;
  position: fixed;
  top: 10px;
  left: 10px;
  z-index: 60;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  width: 38px;
  height: 38px;
  font-size: 16px;
}

.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--panel);
  border-right: 1px solid var(--border);
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: -0.01em;
  padding: 4px 8px 6px;
}
.brand-mark {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--accent);
  position: relative;
}
.brand-mark::after {
  content: "";
  position: absolute;
  inset: 6px;
  border-radius: 2px;
  background: var(--panel);
}
.nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-group-label {
  margin: 0 0 4px;
  padding: 0 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}
.nav-item {
  text-align: left;
  background: none;
  border: none;
  color: var(--muted);
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  font-size: 14px;
}
.nav-item:hover {
  background: var(--panel-2);
  color: var(--text);
}
.nav-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--accent);
}

.drawer-backdrop {
  display: none;
}

.main-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 10;
}
.spacer {
  flex: 1;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel-2);
}
.pill .dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--muted);
}
.pill.ok .dot {
  background: var(--ok);
  box-shadow: 0 0 8px var(--ok);
}
.pill.warn .dot {
  background: var(--warn);
  box-shadow: 0 0 8px var(--warn);
}
.pill.danger .dot {
  background: var(--danger);
}

.icon-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 600;
}
.icon-btn:hover {
  border-color: var(--accent);
}

.account-menu {
  position: relative;
}
.account-dropdown {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px;
  min-width: 220px;
  box-shadow: var(--shadow-lg);
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.account-dropdown-user {
  margin: 2px 8px 6px;
  font-size: 12px;
  color: var(--muted);
}
.dropdown-item {
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  padding: 8px 8px;
  border-radius: 6px;
  font-size: 13px;
}
.dropdown-item:hover {
  background: var(--panel-2);
}
.dropdown-item.danger {
  color: var(--danger);
}

.stale-banner {
  background: var(--panel-2);
  border-bottom: 1px solid var(--warn);
  padding: 10px 20px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--warn);
  font-size: 13px;
}

.content {
  max-width: 1080px;
  width: 100%;
  margin: 0 auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

@media (max-width: 860px) {
  .drawer-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    z-index: 55;
    box-shadow: var(--shadow-lg);
  }
  .sidebar.open {
    transform: translateX(0);
  }
  .drawer-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 50;
  }
  .topbar {
    padding-left: 58px;
  }
}
</style>

<!--
  CommandsView: announce / kick / ban / unban / save / restart / stop /
  force-stop. announce/kick/ban/unban/save/stop/force-stop go through
  /api/rest/* (perm "commands"; see docs/FRONTEND_V2_PLAN.md), mirroring the
  legacy Commands tab's endpoint set (POST_EPS in panel.py). "Restart server"
  is the separate /api/restart route (perm "settings", same gate the backend
  already enforces server-side) that restarts the game process in place.
  Neither restart nor stop ever powers off the VM — that's the top-bar ⏻
  (perm "power") in the Console hero.
-->
<script setup>
import { reactive } from "vue";
import { useI18n } from "vue-i18n";

import { apiPost } from "../api.js";
import Card from "../components/ui/Card.vue";
import Btn from "../components/ui/Btn.vue";
import Field from "../components/ui/Field.vue";
import { useConfirm } from "../components/ui/useConfirm.js";
import { useToast } from "../components/ui/useToast.js";
import { useServerStore } from "../stores/server.js";
import { useSessionStore } from "../stores/session.js";

const { t } = useI18n();
const server = useServerStore();
const session = useSessionStore();
const toast = useToast();
const { confirm } = useConfirm();

const ann = reactive({ message: "" });
const mod = reactive({ userid: "", message: "" });
const shutdown = reactive({ waittime: 30, message: "" });

async function cmd(endpoint, body) {
  const r = await apiPost(`/api/rest/${endpoint}`, body, { key: "commands" });
  toast[r.ok ? "ok" : "error"](r.ok ? t("commands.commandOk", { cmd: endpoint }) : r.error || t("commands.commandFailed"));
  return r.ok;
}

async function announce() {
  const message = ann.message.trim();
  if (!message) {
    toast.error(t("commands.announceRequired"));
    return;
  }
  const ok = await cmd("announce", { message });
  if (ok) ann.message = "";
}

async function kick() {
  const userid = mod.userid.trim();
  if (!userid) {
    toast.error(t("commands.userIdRequired"));
    return;
  }
  await cmd("kick", { userid, message: mod.message });
}

async function ban() {
  const userid = mod.userid.trim();
  if (!userid) {
    toast.error(t("commands.userIdRequired"));
    return;
  }
  const ok = await confirm({ message: `${t("commands.ban")}: ${userid}?`, confirmLabel: t("commands.ban"), danger: true });
  if (!ok) return;
  await cmd("ban", { userid, message: mod.message });
}

async function unban() {
  const userid = mod.userid.trim();
  if (!userid) {
    toast.error(t("commands.userIdRequired"));
    return;
  }
  await cmd("unban", { userid });
}

async function saveWorld() {
  await cmd("save", {});
}

async function stopServer() {
  const ok = await confirm({
    message: t("commands.confirmStop", { seconds: shutdown.waittime }),
    confirmLabel: t("commands.stopServer"),
    danger: true,
  });
  if (!ok) return;
  await cmd("shutdown", { waittime: shutdown.waittime, message: shutdown.message });
}

async function restartServer() {
  const ok = await confirm({
    message: t("commands.confirmRestart"),
    confirmLabel: t("commands.restartServer"),
    danger: true,
  });
  if (!ok) return;
  const r = await apiPost("/api/restart", {}, { key: "commands" });
  toast[r.ok ? "ok" : "error"](r.ok ? t("commands.restartOk") : r.error || t("commands.restartFailed"));
}

async function forceStop() {
  const ok = await confirm({ message: t("commands.confirmForceStop"), confirmLabel: t("commands.forceStop"), danger: true });
  if (!ok) return;
  await cmd("stop", {});
}
</script>

<template>
  <div class="commands-view">
    <Card v-if="!server.isRunning">
      <p class="muted">{{ t("commands.serverOff") }}</p>
    </Card>

    <template v-else>
      <Card :title="t('commands.announcementTitle')">
        <form class="row" @submit.prevent="announce">
          <Field :label="t('commands.announcementMessage')" label-sr-only class="grow" v-slot="{ id }">
            <input :id="id" v-model="ann.message" :placeholder="t('commands.announcementMessage')" />
          </Field>
          <Btn type="submit" busy-key="commands">{{ t("commands.announce") }}</Btn>
        </form>
      </Card>

      <Card :title="t('commands.moderationTitle')">
        <div class="fields">
          <Field :label="t('commands.userId')" v-slot="{ id }">
            <input :id="id" v-model="mod.userid" :placeholder="t('commands.userIdPlaceholder')" />
          </Field>
          <Field :label="t('commands.messageLabel')" v-slot="{ id }">
            <input :id="id" v-model="mod.message" :placeholder="t('commands.reasonPlaceholder')" />
          </Field>
        </div>
        <div class="actions equal" style="margin-top: 10px">
          <Btn busy-key="commands" @click="kick">{{ t("commands.kick") }}</Btn>
          <Btn variant="danger" busy-key="commands" @click="ban">{{ t("commands.ban") }}</Btn>
          <Btn variant="ghost" busy-key="commands" @click="unban">{{ t("commands.unban") }}</Btn>
        </div>
      </Card>

      <Card :title="t('commands.worldTitle')">
        <div class="actions">
          <Btn busy-key="commands" @click="saveWorld">{{ t("commands.saveWorld") }}</Btn>
        </div>
      </Card>

      <Card :title="t('commands.powerTitle')" :hint="t('commands.powerHint')">
        <div class="power-block">
          <div class="power-row">
            <div class="power-copy">
              <p class="power-row-title">{{ t("commands.restartTitle") }}</p>
              <p class="muted power-row-note">{{ t("commands.restartNote") }}</p>
            </div>
            <Btn
              variant="danger"
              busy-key="commands"
              :disabled="!session.can('settings')"
              @click="restartServer"
            >{{ t("commands.restartServer") }}</Btn>
          </div>

          <div class="power-row power-row-stop">
            <div class="fields">
              <Field :label="t('commands.waitSeconds')" v-slot="{ id }">
                <input :id="id" v-model.number="shutdown.waittime" type="number" min="0" style="max-width: 140px" />
              </Field>
              <Field :label="t('commands.messageLabel')" class="grow" v-slot="{ id }">
                <input :id="id" v-model="shutdown.message" :placeholder="t('commands.restartingPlaceholder')" />
              </Field>
            </div>
            <div class="power-copy">
              <p class="power-row-title">{{ t("commands.stopTitle") }}</p>
              <p class="muted power-row-note">{{ t("commands.stopNote") }}</p>
            </div>
            <div class="actions" style="margin-top: 6px">
              <Btn
                variant="danger"
                busy-key="commands"
                :disabled="!session.can('commands')"
                @click="stopServer"
              >{{ t("commands.stopServer") }}</Btn>
              <Btn variant="ghost" busy-key="commands" :disabled="!session.can('commands')" @click="forceStop">{{
                t("commands.forceStop")
              }}</Btn>
            </div>
          </div>

          <p class="muted power-vm-note">{{ t("commands.vmPowerNote") }}</p>
        </div>
      </Card>
    </template>
  </div>
</template>

<style scoped>
.commands-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.fields {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.fields > * {
  min-width: 180px;
}
.row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.row .grow {
  flex: 1;
}
.power-block {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.power-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.power-row-stop {
  flex-direction: column;
  align-items: stretch;
  border-bottom: none;
}
.power-copy {
  min-width: 0;
}
.power-row-title {
  margin: 0;
  font-weight: 600;
}
.power-row-note {
  margin: 2px 0 0;
  font-size: 12px;
}
.power-vm-note {
  margin: 0;
  font-size: 12px;
}
</style>

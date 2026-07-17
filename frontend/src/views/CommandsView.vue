<!--
  CommandsView: announce / kick / ban / unban / save / shutdown / force-stop
  against /api/rest/* (perm "commands"; see docs/FRONTEND_V2_PLAN.md). Mirrors
  the legacy Commands tab's endpoint set (POST_EPS in panel.py:
  announce/kick/ban/unban/save/shutdown/stop).
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

const { t } = useI18n();
const server = useServerStore();
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

async function shutdownServer() {
  const ok = await confirm({
    message: t("commands.confirmShutdown", { seconds: shutdown.waittime }),
    confirmLabel: t("commands.shutdown"),
    danger: true,
  });
  if (!ok) return;
  await cmd("shutdown", { waittime: shutdown.waittime, message: shutdown.message });
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
          <Btn type="submit" icon="✦" :aria-label="t('commands.announce')" busy-key="commands" />
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
        <div class="actions" style="margin-top: 10px">
          <Btn icon="⏏" :aria-label="t('commands.kick')" busy-key="commands" @click="kick" />
          <Btn variant="danger" icon="⊘" :aria-label="t('commands.ban')" busy-key="commands" @click="ban" />
          <Btn variant="ghost" icon="↺" :aria-label="t('commands.unban')" busy-key="commands" @click="unban" />
        </div>
      </Card>

      <Card :title="t('commands.worldTitle')">
        <div class="actions">
          <Btn icon="↧" :aria-label="t('commands.saveWorld')" busy-key="commands" @click="saveWorld" />
        </div>
      </Card>

      <Card :title="t('commands.shutdownTitle')" :hint="t('commands.shutdownHint')">
        <div class="fields">
          <Field :label="t('commands.waitSeconds')" v-slot="{ id }">
            <input :id="id" v-model.number="shutdown.waittime" type="number" min="0" style="max-width: 140px" />
          </Field>
          <Field :label="t('commands.messageLabel')" class="grow" v-slot="{ id }">
            <input :id="id" v-model="shutdown.message" :placeholder="t('commands.restartingPlaceholder')" />
          </Field>
        </div>
        <div class="actions" style="margin-top: 10px">
          <Btn variant="danger" icon="⏻" :aria-label="t('commands.shutdown')" busy-key="commands" @click="shutdownServer" />
          <Btn variant="danger" icon="■" :aria-label="t('commands.forceStop')" busy-key="commands" @click="forceStop" />
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
</style>

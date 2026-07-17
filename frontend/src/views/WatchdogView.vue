<!--
  WatchdogView: idle-watchdog poll interval + idle-grace editor against
  GET/POST /api/watchdog (perm "view" to read, "config" to save — see
  docs/FRONTEND_V2_PLAN.md). Grace is stored in seconds server-side but edited
  in minutes here for readability, mirroring the legacy tab's wdGraceMin
  computed getter/setter.
-->
<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";

import { apiGet, apiPost } from "../api.js";
import Btn from "../components/ui/Btn.vue";
import Card from "../components/ui/Card.vue";
import Field from "../components/ui/Field.vue";
import { useToast } from "../components/ui/useToast.js";
import { useSessionStore } from "../stores/session.js";

const { t } = useI18n();
const session = useSessionStore();
const toast = useToast();

const wd = reactive({ poll_seconds: 60, grace_seconds: 1800 });
const loaded = ref(false);

const graceMinutes = computed({
  get: () => Math.round(wd.grace_seconds / 60),
  set: (v) => {
    wd.grace_seconds = Math.round(v * 60);
  },
});

async function load() {
  const r = await apiGet("/api/watchdog", { key: "watchdog" });
  if (r.ok) {
    wd.poll_seconds = r.data.poll_seconds;
    wd.grace_seconds = r.data.grace_seconds;
    loaded.value = true;
  } else {
    toast.error(r.error || t("watchdog.loadFailed"));
  }
}

onMounted(load);

async function save() {
  if (!(10 <= wd.poll_seconds && wd.poll_seconds <= 3600)) {
    toast.error(t("watchdog.pollRange"));
    return;
  }
  if (!(1 <= graceMinutes.value && graceMinutes.value <= 1440)) {
    toast.error(t("watchdog.graceRange"));
    return;
  }
  const r = await apiPost(
    "/api/watchdog",
    { poll_seconds: wd.poll_seconds, grace_seconds: wd.grace_seconds },
    { key: "watchdog" },
  );
  toast[r.ok ? "ok" : "error"](r.ok ? t("watchdog.updated") : r.error || t("watchdog.saveFailed"));
}
</script>

<template>
  <Card :title="t('watchdog.title')" :hint="t('watchdog.hint')">
    <template v-if="loaded">
      <div class="grid">
        <Field :label="t('watchdog.pollInterval')" v-slot="{ id }">
          <input :id="id" v-model.number="wd.poll_seconds" type="number" min="10" max="3600" />
        </Field>
        <Field :label="t('watchdog.idleGrace')" v-slot="{ id }">
          <input :id="id" v-model.number="graceMinutes" type="number" min="1" max="1440" />
        </Field>
      </div>
      <p class="muted">{{ t("watchdog.summary", { poll: wd.poll_seconds, grace: graceMinutes }) }}</p>
      <div class="row end">
        <Btn variant="ghost" busy-key="watchdog" @click="load">{{ t("watchdog.reload") }}</Btn>
        <Btn busy-key="watchdog" :disabled="!session.can('config')" @click="save">{{ t("watchdog.save") }}</Btn>
      </div>
    </template>
  </Card>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 10px;
}
.row.end {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>

<!--
  Login view. Full-screen while unauthenticated (App.vue renders this instead
  of the shell). Talks to POST /api/login {username,password} via the session
  store; surfaces the 429 throttle/lockout response with a live countdown, and
  puts the error in role="alert" so it's announced immediately.
-->
<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Btn from "../components/ui/Btn.vue";
import Field from "../components/ui/Field.vue";
import { useSessionStore } from "../stores/session.js";

const { t } = useI18n();
const session = useSessionStore();

const form = reactive({ username: "", password: "" });
const countdown = ref(0);
let countdownTimer = null;

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
}

watch(
  () => session.retryAfter,
  (seconds) => {
    stopCountdown();
    if (!seconds) return;
    countdown.value = seconds;
    countdownTimer = setInterval(() => {
      countdown.value -= 1;
      if (countdown.value <= 0) stopCountdown();
    }, 1000);
  },
);
onBeforeUnmount(stopCountdown);

const throttled = computed(() => countdown.value > 0);

// The coordinator returns human-readable `error` strings (already English,
// not a code), so we pass most of them straight through rather than trying
// to map every possible backend message into an i18n key. The two cases we
// DO special-case are ones the frontend itself needs to react to: the
// network-transport failure synthesized by api.js, and the 429 throttle,
// which we render with a live countdown instead of the raw retry_after number.
const errorMessage = computed(() => {
  if (throttled.value) return t("login.throttled", { seconds: countdown.value });
  if (!session.loginError) return "";
  if (session.loginError === "network_error") return t("common.networkError");
  return session.loginError;
});

async function submit() {
  if (throttled.value || session.loginBusy) return;
  await session.login(form.username.trim(), form.password);
}
</script>

<template>
  <div class="login-screen">
    <form class="login-box" @submit.prevent="submit">
      <h1 class="login-title">{{ t("app.title") }}</h1>
      <p class="login-subtitle">{{ t("login.subtitle") }}</p>

      <Field :label="t('login.username')" v-slot="{ id }">
        <input :id="id" v-model.trim="form.username" autocomplete="username" autofocus />
      </Field>
      <Field :label="t('login.password')" v-slot="{ id }">
        <input :id="id" v-model="form.password" type="password" autocomplete="current-password" />
      </Field>

      <Btn type="submit" class="login-submit" :loading="session.loginBusy" :disabled="throttled">
        {{ session.loginBusy ? t("login.submitting") : t("login.submit") }}
      </Btn>

      <p class="login-error" role="alert">{{ errorMessage }}</p>
    </form>
  </div>
</template>

<style scoped>
.login-screen {
  position: fixed;
  inset: 0;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.login-box {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 28px;
  width: 340px;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.login-title {
  margin: 0;
  font-size: 18px;
}
.login-subtitle {
  margin: -8px 0 4px;
  color: var(--muted);
  font-size: 13px;
}
.login-submit {
  width: 100%;
  margin-top: 4px;
}
.login-error {
  color: var(--danger);
  font-size: 12px;
  margin: 0;
  min-height: 16px;
}
</style>

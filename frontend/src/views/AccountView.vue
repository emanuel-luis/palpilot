<!--
  AccountView: change own password (POST /api/account/password) and sign out
  everywhere (POST /api/logout-all). Both bump the account's token `ver`
  server-side, so both end this session too — the session store handles
  clearing local state and the app falls back to LoginView automatically.
-->
<script setup>
import { reactive, ref } from "vue";
import { useI18n } from "vue-i18n";

import Btn from "../components/ui/Btn.vue";
import Card from "../components/ui/Card.vue";
import Field from "../components/ui/Field.vue";
import { useConfirm } from "../components/ui/useConfirm.js";
import { useToast } from "../components/ui/useToast.js";
import { useSessionStore } from "../stores/session.js";

const { t } = useI18n();
const session = useSessionStore();
const toast = useToast();
const { confirm } = useConfirm();

const form = reactive({ current: "", next: "", confirm: "" });
const formError = ref("");

async function submitPasswordChange() {
  formError.value = "";
  if (form.next.length < 8) {
    formError.value = t("account.tooShort");
    return;
  }
  if (form.next !== form.confirm) {
    formError.value = t("account.mismatch");
    return;
  }
  const r = await session.changePassword(form.current, form.next);
  if (r.ok) {
    toast.ok(t("account.success"));
    form.current = "";
    form.next = "";
    form.confirm = "";
  } else {
    formError.value = r.error || t("account.failure");
  }
}

async function onSignOutAll() {
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
  <div class="account-view">
    <Card :title="t('account.title')">
      <p class="signed-in-as">{{ t("header.account.signedInAs", { user: session.user }) }}</p>
    </Card>

    <Card :title="t('account.changePassword')">
      <form class="password-form" @submit.prevent="submitPasswordChange">
        <Field :label="t('account.currentPassword')" v-slot="{ id }">
          <input :id="id" v-model="form.current" type="password" autocomplete="current-password" required />
        </Field>
        <Field :label="t('account.newPassword')" v-slot="{ id }">
          <input :id="id" v-model="form.next" type="password" autocomplete="new-password" required minlength="8" />
        </Field>
        <Field :label="t('account.confirmPassword')" :error="formError" v-slot="{ id, describedby }">
          <input
            :id="id"
            v-model="form.confirm"
            type="password"
            autocomplete="new-password"
            required
            :aria-describedby="describedby"
          />
        </Field>
        <div class="row end">
          <Btn type="submit" busy-key="change-password">{{ t("account.submit") }}</Btn>
        </div>
      </form>
    </Card>

    <Card :title="t('account.sessions')" :hint="t('account.sessionsHint')">
      <Btn variant="danger" busy-key="logout-all" @click="onSignOutAll">{{ t("account.signOutAll") }}</Btn>
    </Card>
  </div>
</template>

<style scoped>
.account-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.signed-in-as {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
.password-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 360px;
}
.row.end {
  display: flex;
  justify-content: flex-end;
}
</style>

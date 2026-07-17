<!--
  UsersView: user CRUD against /api/users* (perm "users" — see
  docs/FRONTEND_V2_PLAN.md). POST /api/users both creates (unknown username)
  and updates (existing username: perms always replace, password only
  changes if provided) — same single-form pattern as the legacy tab. Delete
  is blocked client-side for the signed-in user and the server independently
  guards the last remaining 'users' admin either way.
-->
<script setup>
import { onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";

import { apiDelete, apiGet, apiPost } from "../api.js";
import Badge from "../components/ui/Badge.vue";
import Btn from "../components/ui/Btn.vue";
import Card from "../components/ui/Card.vue";
import DataTable from "../components/ui/DataTable.vue";
import Field from "../components/ui/Field.vue";
import { useConfirm } from "../components/ui/useConfirm.js";
import { useToast } from "../components/ui/useToast.js";
import { useSessionStore } from "../stores/session.js";

const { t } = useI18n();
const session = useSessionStore();
const toast = useToast();
const { confirm } = useConfirm();

const users = ref([]);
const allPerms = ref(["view", "power", "config", "commands", "users"]);

const form = reactive({ username: "", password: "", perms: ["view"], editing: false });

const PERM_KEYS = new Set(["view", "power", "config", "commands", "users"]);
function permLabel(p) {
  return PERM_KEYS.has(p) ? t(`users.perm.${p}`) : p;
}

async function loadUsers() {
  const r = await apiGet("/api/users", { key: "users" });
  if (r.ok) {
    users.value = r.data.users || [];
    allPerms.value = r.data.all_perms || allPerms.value;
  } else {
    toast.error(r.error || t("users.loadFailed"));
  }
}

onMounted(loadUsers);

function resetForm() {
  form.username = "";
  form.password = "";
  form.perms = ["view"];
  form.editing = false;
}

function editUser(u) {
  form.username = u.username;
  form.password = "";
  form.perms = [...u.perms];
  form.editing = true;
}

async function saveUser() {
  const username = form.username.trim();
  if (!username) {
    toast.error(t("users.usernameRequired"));
    return;
  }
  if (!form.editing && !form.password) {
    toast.error(t("users.passwordRequiredForNew"));
    return;
  }
  const body = { username, perms: form.perms };
  if (form.password) body.password = form.password;
  const r = await apiPost("/api/users", body, { key: "users" });
  if (r.ok) {
    toast.ok(t("users.saved"));
    resetForm();
    loadUsers();
  } else {
    toast.error(r.error || t("users.saveFailed"));
  }
}

async function deleteUser(username) {
  const ok = await confirm({
    message: t("users.confirmDelete", { username }),
    confirmLabel: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  const r = await apiDelete(`/api/users/${encodeURIComponent(username)}`, { key: "users" });
  if (r.ok) {
    toast.ok(t("users.deleted"));
    loadUsers();
  } else {
    toast.error(r.error || t("users.deleteFailed"));
  }
}
</script>

<template>
  <div class="users-view">
    <Card :title="form.editing ? t('users.editTitle', { username: form.username }) : t('users.addTitle')">
      <form class="user-form" @submit.prevent="saveUser">
        <div class="grid">
          <Field :label="t('users.username')" v-slot="{ id }">
            <input :id="id" v-model.trim="form.username" :readonly="form.editing" />
          </Field>
          <Field :label="form.editing ? t('users.passwordKeepHint') : t('users.password')" v-slot="{ id }">
            <input :id="id" v-model="form.password" type="password" autocomplete="new-password" />
          </Field>
        </div>
        <fieldset class="perms-fieldset">
          <legend>{{ t("users.permissionsLabel") }}</legend>
          <label v-for="p in allPerms" :key="p" class="perm-check">
            <input v-model="form.perms" type="checkbox" :value="p" />
            {{ permLabel(p) }}
          </label>
        </fieldset>
        <div class="row end">
          <Btn variant="ghost" type="button" @click="resetForm">{{ t("users.clear") }}</Btn>
          <Btn type="submit" busy-key="users">{{ t("users.save") }}</Btn>
        </div>
      </form>
    </Card>

    <Card :title="t('users.listTitle')">
      <DataTable
        :columns="[
          { key: 'username', label: t('users.colUsername') },
          { key: 'perms', label: t('users.colPermissions') },
          { key: 'actions', label: t('users.colActions'), align: 'right' },
        ]"
        :rows="users"
        row-key="username"
        :empty-text="t('users.noUsers')"
      >
        <template #cell-username="{ value }">
          {{ value }}
          <span v-if="value === session.user" class="muted">{{ t("users.youSuffix") }}</span>
        </template>
        <template #cell-perms="{ value }">
          <Badge v-for="p in value" :key="p">{{ permLabel(p) }}</Badge>
        </template>
        <template #cell-actions="{ row }">
          <div class="actions-cell">
            <Btn size="sm" variant="ghost" @click="editUser(row)">{{ t("common.edit") }}</Btn>
            <Btn
              size="sm"
              variant="danger"
              busy-key="users"
              :disabled="row.username === session.user"
              @click="deleteUser(row.username)"
            >
              {{ t("common.delete") }}
            </Btn>
          </div>
        </template>
      </DataTable>
    </Card>
  </div>
</template>

<style scoped>
.users-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.user-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}
.perms-fieldset {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.perms-fieldset legend {
  font-size: 12px;
  color: var(--muted);
  padding: 0 4px;
}
.perm-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.perm-check input {
  width: auto;
}
.row.end {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.actions-cell {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
</style>

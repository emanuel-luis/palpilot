<!--
  UsersView: user CRUD against /api/users* + the roles manager against
  /api/roles* (perm "users" for both — see docs/CONSOLE_V3_PLAN.md §C/§D).
  POST /api/users both creates (unknown username) and updates (existing
  username: role/perms always replace, password only changes if provided) —
  same single-form pattern as the legacy tab. A user's baseline comes from
  its Role; picking "Custom" reveals the granular perm checkboxes so a
  one-off grant doesn't require a throwaway role. Delete is blocked
  client-side for the signed-in user and the server independently guards the
  last remaining 'users' admin either way (using EFFECTIVE perms).

  Roles are preset permission bundles (GET/POST/DELETE /api/roles): built-ins
  (owner/operator/moderator/viewer) are seeded, badged, and not deletable,
  but their perms stay editable; custom roles can be renamed... actually not
  renamed (name is the identity/key) but created, re-saved, and deleted as
  long as no user still holds them.
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

// The granular perm set from docs/CONSOLE_V3_PLAN.md §C. Seeded here so the
// checkboxes render before the first /api/roles round-trip, then replaced by
// whatever the coordinator reports (its all_perms is the source of truth).
const ALL_PERMS_FALLBACK = ["view", "power", "saves", "mods", "settings", "watchdog", "commands", "users"];
const PERM_KEYS = new Set([...ALL_PERMS_FALLBACK, "config"]); // "config" only for a translated label, never offered as a checkbox
function permLabel(p) {
  return PERM_KEYS.has(p) ? t(`users.perm.${p}`) : p;
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

const users = ref([]);
const allPerms = ref(ALL_PERMS_FALLBACK);

const CUSTOM_ROLE = "custom";
const form = reactive({ username: "", password: "", role: "viewer", perms: ["view"], editing: false });

async function loadUsers() {
  const r = await apiGet("/api/users", { key: "users" });
  if (r.ok) {
    users.value = r.data.users || [];
    if (r.data.all_perms?.length) allPerms.value = r.data.all_perms;
  } else {
    toast.error(r.error || t("users.loadFailed"));
  }
}

function resetForm() {
  form.username = "";
  form.password = "";
  // Default a cleared/new-user form to the least-privileged role available —
  // never to whatever happens to be first in the roles list (which could be
  // "owner"), so adding a user is opt-in-to-more, not opt-out-of-less.
  form.role = roles.value.find((r) => r.name === "viewer")?.name || roles.value[0]?.name || "viewer";
  form.perms = ["view"];
  form.editing = false;
}

function editUser(u) {
  form.username = u.username;
  form.password = "";
  form.role = u.role || CUSTOM_ROLE;
  form.perms = [...(u.perms || [])];
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
  const body = { username, role: form.role };
  if (form.role === CUSTOM_ROLE) body.perms = form.perms;
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

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

const roles = ref([]); // [{name, perms, builtin}]
const roleForm = reactive({ name: "", perms: [], editing: false, builtin: false });

async function loadRoles() {
  const r = await apiGet("/api/roles", { key: "roles" });
  if (r.ok) {
    roles.value = r.data.roles || [];
    if (r.data.all_perms?.length) allPerms.value = r.data.all_perms;
  } else {
    toast.error(r.error || t("users.roles.loadFailed"));
  }
}

onMounted(async () => {
  await loadRoles();
  loadUsers();
});

function roleLabel(name) {
  return name === CUSTOM_ROLE ? t("users.roles.custom") : name;
}

function resetRoleForm() {
  roleForm.name = "";
  roleForm.perms = [];
  roleForm.editing = false;
  roleForm.builtin = false;
}

function editRole(r) {
  roleForm.name = r.name;
  roleForm.perms = [...r.perms];
  roleForm.editing = true;
  roleForm.builtin = !!r.builtin;
}

async function saveRole() {
  const name = roleForm.name.trim();
  if (!name || name === CUSTOM_ROLE) {
    toast.error(t("users.roles.nameRequired"));
    return;
  }
  const r = await apiPost("/api/roles", { name, perms: roleForm.perms }, { key: "roles" });
  if (r.ok) {
    toast.ok(t("users.roles.saved"));
    resetRoleForm();
    loadRoles();
  } else {
    toast.error(r.error || t("users.roles.saveFailed"));
  }
}

async function deleteRole(r) {
  const ok = await confirm({
    message: t("users.roles.confirmDelete", { name: r.name }),
    confirmLabel: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  const res = await apiDelete(`/api/roles/${encodeURIComponent(r.name)}`, { key: "roles" });
  if (res.ok) {
    toast.ok(t("users.roles.deleted"));
    loadRoles();
  } else {
    toast.error(res.error || t("users.roles.deleteFailed"));
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
          <Field :label="t('users.roleLabel')" v-slot="{ id }">
            <select :id="id" v-model="form.role">
              <option v-for="r in roles" :key="r.name" :value="r.name">{{ roleLabel(r.name) }}</option>
              <option :value="CUSTOM_ROLE">{{ roleLabel(CUSTOM_ROLE) }}</option>
            </select>
          </Field>
        </div>
        <fieldset v-if="form.role === CUSTOM_ROLE" class="perms-fieldset">
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
          { key: 'role', label: t('users.colRole') },
          { key: 'perms', label: t('users.colPermissions') },
          { key: 'actions', label: t('users.colActions'), align: 'right' },
        ]"
        :rows="users"
        row-key="username"
        :empty-text="t('users.noUsers')"
      >
        <template #cell-username="{ value }">
          <span class="break">{{ value }}</span>
          <span v-if="value === session.user" class="muted">{{ t("users.youSuffix") }}</span>
        </template>
        <template #cell-role="{ value }">
          <Badge :tone="value === CUSTOM_ROLE ? 'warn' : 'neutral'">{{ roleLabel(value || CUSTOM_ROLE) }}</Badge>
        </template>
        <template #cell-perms="{ row }">
          <!-- effective_perms reflects the role's baseline (or custom override);
               row.perms is only the raw override and is empty for role users. -->
          <Badge v-for="p in (row.effective_perms || row.perms || [])" :key="p">{{ permLabel(p) }}</Badge>
        </template>
        <template #cell-actions="{ row }">
          <div class="actions end equal">
            <Btn size="sm" variant="ghost" :aria-label="`${t('common.edit')}: ${row.username}`" @click="editUser(row)">{{
              t("common.edit")
            }}</Btn>
            <Btn
              size="sm"
              variant="danger"
              :aria-label="`${t('common.delete')}: ${row.username}`"
              busy-key="users"
              :disabled="row.username === session.user"
              @click="deleteUser(row.username)"
            >{{ t("common.delete") }}</Btn>
          </div>
        </template>
      </DataTable>
    </Card>

    <Card :title="t('users.roles.title')" :hint="t('users.roles.hint')">
      <div class="scroll-x">
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">{{ t("users.roles.colName") }}</th>
              <th scope="col">{{ t("users.roles.colPerms") }}</th>
              <th scope="col" style="text-align: right">
                <span class="sr-only">{{ t("users.colActions") }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in roles" :key="r.name">
              <td>
                {{ r.name }}
                <Badge v-if="r.builtin" tone="ok">{{ t("users.roles.builtin") }}</Badge>
              </td>
              <td><Badge v-for="p in r.perms" :key="p">{{ permLabel(p) }}</Badge></td>
              <td>
                <div class="actions end equal">
                  <Btn size="sm" variant="ghost" :aria-label="`${t('common.edit')}: ${r.name}`" @click="editRole(r)">{{
                    t("common.edit")
                  }}</Btn>
                  <Btn
                    v-if="!r.builtin"
                    size="sm"
                    variant="danger"
                    :aria-label="`${t('common.delete')}: ${r.name}`"
                    busy-key="roles"
                    @click="deleteRole(r)"
                  >{{ t("common.delete") }}</Btn>
                </div>
              </td>
            </tr>
            <tr v-if="!roles.length">
              <td colspan="3" class="muted empty-row">{{ t("users.roles.noRoles") }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <form class="role-form" @submit.prevent="saveRole">
        <p class="eyebrow role-form-title">
          {{ roleForm.editing ? t("users.roles.editTitle", { name: roleForm.name }) : t("users.roles.addTitle") }}
        </p>
        <div class="grid">
          <Field :label="t('users.roles.nameLabel')" v-slot="{ id }">
            <input :id="id" v-model.trim="roleForm.name" :readonly="roleForm.editing" :placeholder="t('users.roles.namePlaceholder')" />
          </Field>
        </div>
        <p v-if="roleForm.builtin" class="muted builtin-note">{{ t("users.roles.builtinNote") }}</p>
        <fieldset class="perms-fieldset">
          <legend>{{ t("users.permissionsLabel") }}</legend>
          <label v-for="p in allPerms" :key="p" class="perm-check">
            <input v-model="roleForm.perms" type="checkbox" :value="p" />
            {{ permLabel(p) }}
          </label>
        </fieldset>
        <div class="row end">
          <Btn variant="ghost" type="button" @click="resetRoleForm">{{ t("users.clear") }}</Btn>
          <Btn type="submit" busy-key="roles">{{ t("users.roles.save") }}</Btn>
        </div>
      </form>
    </Card>
  </div>
</template>

<style scoped>
.users-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.user-form,
.role-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.role-form {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.role-form-title {
  margin: 0;
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
.builtin-note {
  margin: -4px 0 0;
  font-size: 12px;
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
</style>

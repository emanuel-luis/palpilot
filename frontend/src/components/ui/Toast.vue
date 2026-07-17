<!--
  Toast host: mount ONCE (in App.vue). Renders the queue from useToast().
  `role="status"`/aria-live="polite" for ok toasts, "assertive" `role="alert"`
  for errors, so screen readers announce failures immediately (M10 fix).
-->
<script setup>
import { useI18n } from "vue-i18n";

import { useToast } from "./useToast.js";

const { items, dismiss } = useToast();
const { t } = useI18n();
</script>

<template>
  <div class="toast-host">
    <div
      v-for="item in items"
      :key="item.id"
      class="toast"
      :class="item.tone"
      :role="item.tone === 'error' ? 'alert' : 'status'"
      :aria-live="item.tone === 'error' ? 'assertive' : 'polite'"
    >
      <span>{{ item.message }}</span>
      <button class="dismiss" :aria-label="t('ui.dismiss')" @click="dismiss(item.id)">×</button>
    </div>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 1000;
  max-width: 92vw;
  align-items: center;
}
.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  max-width: 90vw;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}
.toast.ok {
  border-color: var(--ok);
}
.toast.error {
  border-color: var(--danger);
}
.dismiss {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
}
.dismiss:hover {
  color: var(--text);
}
</style>

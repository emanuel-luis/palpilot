<!--
  Btn: the one button component every mutating action should use. Busy-aware
  two ways:
    - `:loading="true"` — caller already knows it's in flight (e.g. bound to
      a local ref).
    - `busy-key="saves"` — Btn looks itself up in the shared api.js busy
      registry via `isBusy(key)`, so any action sharing that key (e.g. every
      Saves-tab mutation) disables every button for that key automatically,
      generalizing the legacy `savesBusy`/`modsBusy` pattern plan-wide.
  Either way, a loading button is disabled and shows a small inline spinner
  before its label so screen readers/sighted users both get the state.
-->
<script setup>
import { computed } from "vue";

import { isBusy } from "../../api.js";

const props = defineProps({
  variant: { type: String, default: "primary" }, // primary | ghost | ok | danger
  size: { type: String, default: "md" }, // md | sm
  type: { type: String, default: "button" },
  loading: { type: Boolean, default: false },
  busyKey: { type: String, default: "" },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: "" },
});

defineEmits(["click"]);

const isLoading = computed(() => props.loading || (props.busyKey ? isBusy(props.busyKey) : false));
const isDisabled = computed(() => props.disabled || isLoading.value);
</script>

<template>
  <button
    class="btn"
    :class="[variant, size, { loading: isLoading }]"
    :type="type"
    :disabled="isDisabled"
    :aria-busy="isLoading ? 'true' : undefined"
    :aria-label="ariaLabel || undefined"
    @click="$emit('click', $event)"
  >
    <span v-if="isLoading" class="spinner" aria-hidden="true"></span>
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--accent-2);
  border: 1px solid var(--accent);
  color: #fff;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  font: inherit;
  line-height: 1;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  background: var(--accent);
}
.btn.ghost {
  background: transparent;
  border-color: var(--border);
  color: var(--text);
}
.btn.ghost:hover:not(:disabled) {
  border-color: var(--accent);
}
.btn.ok {
  background: var(--ok);
  border-color: var(--ok);
}
.btn.ok:hover:not(:disabled) {
  filter: brightness(1.1);
}
.btn.danger {
  background: var(--danger-2);
  border-color: var(--danger);
}
.btn.danger:hover:not(:disabled) {
  background: var(--danger);
}
.btn.sm {
  padding: 5px 10px;
  font-size: 12px;
}
.btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: btn-spin 0.6s linear infinite;
}
@keyframes btn-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

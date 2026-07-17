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

  Icon-only compact mode: pass `icon` (a single glyph, e.g. "▶"/"✕"/"⚙") with
  NO default slot content and it renders as a square symbol button in the
  base.css `.icon-btn` look instead of a labelled pill — used for row actions
  (Saves/Mods/Commands) that need to stay on one `.actions` line. `icon` mode
  REQUIRES `aria-label` (also set as the native `title` for a hover tooltip);
  a dev-mode console warning fires if it's missing so this never regresses
  into an unlabelled icon button.
-->
<script setup>
import { computed, useSlots } from "vue";

import { isBusy } from "../../api.js";

const props = defineProps({
  variant: { type: String, default: "primary" }, // primary | ghost | ok | danger
  size: { type: String, default: "md" }, // md | sm
  type: { type: String, default: "button" },
  loading: { type: Boolean, default: false },
  busyKey: { type: String, default: "" },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: "" },
  icon: { type: String, default: "" }, // single glyph; renders icon-only when there's no default slot
});

defineEmits(["click"]);

const slots = useSlots();
const isLoading = computed(() => props.loading || (props.busyKey ? isBusy(props.busyKey) : false));
const isDisabled = computed(() => props.disabled || isLoading.value);
const isIconOnly = computed(() => !!props.icon && !slots.default);

if (import.meta.env?.DEV) {
  if (isIconOnly.value && !props.ariaLabel) {
    // eslint-disable-next-line no-console
    console.warn('Btn: icon-only buttons require an "aria-label" (used as the aria-label and hover title).');
  }
}
</script>

<template>
  <button
    class="btn"
    :class="[variant, size, { loading: isLoading, 'icon-only': isIconOnly }]"
    :type="type"
    :disabled="isDisabled"
    :aria-busy="isLoading ? 'true' : undefined"
    :aria-label="ariaLabel || undefined"
    :title="isIconOnly ? ariaLabel : undefined"
    @click="$emit('click', $event)"
  >
    <span v-if="isLoading" class="spinner" aria-hidden="true"></span>
    <span v-else-if="isIconOnly" class="icon-glyph" aria-hidden="true">{{ icon }}</span>
    <slot v-else />
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

/* Icon-only: the base.css .icon-btn box (compact, symbol, hairline border)
   regardless of `variant`; the variant only tints the glyph so semantics
   (danger/ok) still read at a glance in a dense `.actions` row. */
.btn.icon-only {
  width: 30px;
  height: 30px;
  padding: 0;
  gap: 0;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 14px;
}
.btn.icon-only:hover:not(:disabled) {
  background: transparent;
  border-color: var(--accent);
  color: var(--accent);
}
.btn.icon-only.ok {
  color: var(--ok);
}
.btn.icon-only.ok:hover:not(:disabled) {
  border-color: var(--ok);
  color: var(--ok);
}
.btn.icon-only.danger {
  color: var(--danger);
}
.btn.icon-only.danger:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}
.btn.icon-only.sm {
  width: 26px;
  height: 26px;
  font-size: 13px;
}
.icon-glyph {
  line-height: 1;
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

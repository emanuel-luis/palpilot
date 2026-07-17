<!--
  Generic modal shell used by ConfirmDialog.vue and any future dialog (e.g.
  Saves' clone/rename prompts). Controlled via v-model:modelValue.
  Accessible basics: role="dialog", aria-modal, labelled by its title,
  Escape-to-close, and focus lands on the panel on open.
-->
<script setup>
import { nextTick, ref, watch } from "vue";

const props = defineProps({
  modelValue: { type: Boolean, required: true },
  title: { type: String, default: "" },
  closeOnBackdrop: { type: Boolean, default: true },
});
const emit = defineEmits(["update:modelValue", "close"]);

const panelRef = ref(null);
const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;

function close() {
  emit("update:modelValue", false);
  emit("close");
}

function onBackdrop() {
  if (props.closeOnBackdrop) close();
}

function onKeydown(e) {
  if (e.key === "Escape") close();
}

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      await nextTick();
      panelRef.value?.focus();
    }
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-backdrop" @mousedown.self="onBackdrop">
      <div
        ref="panelRef"
        class="modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="title ? titleId : undefined"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header v-if="title" class="modal-head">
          <h2 :id="titleId" class="modal-title">{{ title }}</h2>
        </header>
        <div class="modal-body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="modal-footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 1100;
}
.modal-panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  width: 100%;
  max-width: 420px;
  max-height: 90vh;
  overflow-y: auto;
}
.modal-panel:focus {
  outline: none;
}
.modal-title {
  margin: 0 0 12px;
  font-size: 16px;
}
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
</style>

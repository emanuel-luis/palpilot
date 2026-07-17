<!--
  Field: label[for]/id pairing for every form input (H4 fix — the legacy UI
  had none). Wraps a single input via the default slot, which receives the
  generated `id` and `describedby` to wire onto the actual <input>/<select>:

    <Field label="Username" v-slot="{ id, describedby }">
      <input :id="id" :aria-describedby="describedby" v-model="username" />
    </Field>

  `hint`/`error` render below and are folded into `aria-describedby` so
  assistive tech announces them together with the input.
-->
<script setup>
import { computed, useId } from "vue";

const props = defineProps({
  label: { type: String, required: true },
  hint: { type: String, default: "" },
  error: { type: String, default: "" },
  labelSrOnly: { type: Boolean, default: false }, // visually hide the label (e.g. inline search boxes with a placeholder)
});

const id = useId();
const hintId = `${id}-hint`;
const errorId = `${id}-error`;

const describedby = computed(() => {
  const ids = [];
  if (props.hint) ids.push(hintId);
  if (props.error) ids.push(errorId);
  return ids.join(" ") || undefined;
});
</script>

<template>
  <div class="field">
    <label :for="id" :class="{ 'sr-only': labelSrOnly }">{{ label }}</label>
    <slot :id="id" :describedby="describedby" />
    <p v-if="hint" :id="hintId" class="field-hint">{{ hint }}</p>
    <p v-if="error" :id="errorId" class="field-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field label {
  font-size: 12px;
  color: var(--muted);
}
.field-hint {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
}
.field-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
</style>

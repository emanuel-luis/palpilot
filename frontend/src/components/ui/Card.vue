<!--
  Card: the base panel used throughout every view. Optional `title`/`hint`
  props render a heading + muted subtitle; otherwise just wraps the default
  slot. `#actions` slot renders right-aligned next to the title (buttons,
  filters, etc.).
-->
<script setup>
defineProps({
  title: { type: String, default: "" },
  hint: { type: String, default: "" },
});
</script>

<template>
  <section class="card">
    <header v-if="title || $slots.actions" class="card-head">
      <div v-if="title" class="card-title-wrap">
        <h2 class="card-title">{{ title }}</h2>
        <p v-if="hint" class="card-hint">{{ hint }}</p>
      </div>
      <div v-if="$slots.actions" class="card-actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="card-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
  box-shadow: var(--shadow);
}
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}
.card-hint {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--muted);
  font-weight: 400;
}
.card-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
</style>

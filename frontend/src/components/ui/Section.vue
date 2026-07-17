<!--
  Section: the collapsible block ServerConsoleView uses to stack Saves /
  Settings / Mods / Commands / Watchdog under one Console without inventing a
  new visual language — a native <details>/<summary> pair (free keyboard +
  screen-reader disclosure semantics) with the base.css `.eyebrow` micro-label
  as the summary and a rotating "›" (the plan's "expand" glyph) as the
  indicator. Purely presentational: callers own perm-gating (`v-if` around
  the component) and whatever's inside the default slot.
-->
<script setup>
defineProps({
  title: { type: String, required: true },
  hint: { type: String, default: "" },
  defaultOpen: { type: Boolean, default: true },
});
</script>

<template>
  <details class="section" :open="defaultOpen">
    <summary class="section-summary">
      <span class="chevron" aria-hidden="true">&#8250;</span>
      <span class="eyebrow section-title">{{ title }}</span>
      <span v-if="hint" class="section-hint muted">{{ hint }}</span>
    </summary>
    <div class="section-body">
      <slot />
    </div>
  </details>
</template>

<style scoped>
.section {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.section-summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 18px;
}
.section-summary::-webkit-details-marker {
  display: none;
}
.section-summary::marker {
  content: "";
}
.chevron {
  display: inline-block;
  color: var(--muted);
  transition: transform 0.15s ease;
  flex-shrink: 0;
}
.section[open] > .section-summary .chevron {
  transform: rotate(90deg);
}
.section-title {
  flex-shrink: 0;
}
.section-hint {
  font-size: 12px;
}
.section-body {
  padding: 0 18px 18px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>

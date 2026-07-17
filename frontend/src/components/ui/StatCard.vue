<!-- StatCard: one metric tile (label + big value), used in grids on StatusView. -->
<script setup>
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: "—" },
});
</script>

<template>
  <div class="stat-card">
    <div class="stat-value">{{ value }}</div>
    <div class="stat-label">{{ label }}</div>
  </div>
</template>

<style scoped>
.stat-card {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px;
}
.stat-value {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
}
.stat-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
</style>

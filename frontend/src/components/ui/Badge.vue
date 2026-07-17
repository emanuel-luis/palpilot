<!-- Badge: small inline status tag (active/empty/enabled/disabled/perm labels, ...). -->
<script setup>
defineProps({
  tone: { type: String, default: "neutral" }, // neutral | ok | warn | danger
});
</script>

<template>
  <span class="badge" :class="tone"><slot /></span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 1px 6px;
  color: var(--muted);
  line-height: 1.6;
}
.badge.ok {
  color: var(--ok);
  border-color: var(--ok);
}
.badge.warn {
  color: var(--warn);
  border-color: var(--warn);
}
.badge.danger {
  color: var(--danger);
  border-color: var(--danger);
}
</style>

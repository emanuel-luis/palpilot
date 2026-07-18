<!--
  DataTable: wraps any table in overflow-x:auto (so only the table scrolls on
  mobile, never the page) and handles the empty state. Columns drive the
  header; each row is rendered via a scoped slot per-column so callers keep
  full control of cell markup (badges, buttons, mono formatting, ...).

  Usage:
    <DataTable :columns="[{key:'name',label:'Name'}, {key:'level',label:'Level',align:'right'}]"
               :rows="players" row-key="userId">
      <template #cell-name="{ row }">{{ row.name }}</template>
    </DataTable>
  Any column without a matching `#cell-<key>` slot falls back to `row[key]`.
-->
<script setup>
defineProps({
  columns: { type: Array, required: true }, // [{key, label, align?: 'left'|'right'|'center'}]
  rows: { type: Array, required: true },
  rowKey: { type: [String, Function], default: "id" },
  emptyText: { type: String, default: "" },
});

function keyFor(row, rowKey) {
  return typeof rowKey === "function" ? rowKey(row) : row[rowKey];
}
</script>

<template>
  <div class="scroll-x">
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="col in columns" :key="col.key" scope="col" :style="{ textAlign: col.align || 'left' }">
            {{ col.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="keyFor(row, rowKey)">
          <td
            v-for="col in columns"
            :key="col.key"
            :class="{ num: col.align === 'right' }"
            :style="{ textAlign: col.align || 'left' }"
          >
            <slot :name="`cell-${col.key}`" :row="row" :value="row[col.key]">{{ row[col.key] }}</slot>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length" class="muted empty-row">
            <slot name="empty">{{ emptyText }}</slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.data-table th,
.data-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.data-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--panel);
  color: var(--muted);
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--border);
}
.data-table tbody tr {
  transition: background 0.1s ease;
}
.data-table tbody tr:hover {
  background: var(--panel-2);
}
.data-table td.num {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.empty-row {
  text-align: center;
  padding: 20px 8px;
  color: var(--muted);
}
</style>

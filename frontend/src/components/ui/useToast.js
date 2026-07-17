// Toast composable: a module-level (singleton) reactive queue so any
// component/store can call `useToast().notify(...)` without prop-drilling,
// while a single <Toast /> host — mounted once in App.vue — renders it.
import { reactive } from "vue";

const DEFAULT_DURATION_MS = 3200;

const state = reactive({
  items: [], // {id, message, tone, duration}
});

let nextId = 1;

function dismiss(id) {
  const i = state.items.findIndex((t) => t.id === id);
  if (i !== -1) state.items.splice(i, 1);
}

function notify(message, { tone = "ok", duration = DEFAULT_DURATION_MS } = {}) {
  const id = nextId++;
  state.items.push({ id, message, tone });
  if (duration > 0) setTimeout(() => dismiss(id), duration);
  return id;
}

export function useToast() {
  return {
    items: state.items,
    notify,
    ok: (message, opts) => notify(message, { ...opts, tone: "ok" }),
    error: (message, opts) => notify(message, { ...opts, tone: "error" }),
    dismiss,
  };
}

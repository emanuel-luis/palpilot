// Confirm-dialog composable: a promise-based `confirm(opts) -> Promise<boolean>`
// backed by a single module-level (singleton) piece of state, rendered by the
// one <ConfirmDialog /> host mounted in App.vue — mirrors the useToast()
// pattern so any store/view can prompt without prop-drilling a modal ref.
//
// This is a deliberate a11y/UX upgrade over native window.confirm() (which
// blocks a11y tooling and can't be styled/localized), used for anything the
// legacy UI gated behind confirm() — stop VM, delete slot, sign out
// everywhere, etc.
import { reactive } from "vue";

const state = reactive({
  open: false,
  title: "",
  message: "",
  confirmLabel: "",
  cancelLabel: "",
  danger: false,
  _resolve: null,
});

function confirm({ title = "", message = "", confirmLabel = "", cancelLabel = "", danger = false } = {}) {
  return new Promise((resolve) => {
    state.open = true;
    state.title = title;
    state.message = message;
    state.confirmLabel = confirmLabel;
    state.cancelLabel = cancelLabel;
    state.danger = danger;
    state._resolve = resolve;
  });
}

function settle(result) {
  state.open = false;
  const resolve = state._resolve;
  state._resolve = null;
  if (resolve) resolve(result);
}

export function useConfirm() {
  return { state, confirm, settle };
}

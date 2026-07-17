<!--
  Confirm dialog host: mount ONCE (in App.vue). Renders whatever
  useConfirm().confirm({...}) most recently requested, on top of Modal.vue.
  Callers: `const {confirm} = useConfirm(); if (await confirm({message:'…'})) { ... }`
-->
<script setup>
import { useI18n } from "vue-i18n";

import Btn from "./Btn.vue";
import Modal from "./Modal.vue";
import { useConfirm } from "./useConfirm.js";

const { state, settle } = useConfirm();
const { t } = useI18n();
</script>

<template>
  <Modal :model-value="state.open" :title="state.title || t('ui.confirmDefaultTitle')" @close="settle(false)">
    <p class="confirm-message">{{ state.message }}</p>
    <template #footer>
      <Btn variant="ghost" @click="settle(false)">{{ state.cancelLabel || t("common.cancel") }}</Btn>
      <Btn :variant="state.danger ? 'danger' : 'primary'" @click="settle(true)">
        {{ state.confirmLabel || t("common.confirm") }}
      </Btn>
    </template>
  </Modal>
</template>

<style scoped>
.confirm-message {
  margin: 0;
  white-space: pre-line;
}
</style>

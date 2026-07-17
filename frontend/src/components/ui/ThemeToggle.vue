<!--
  ThemeToggle: light/dark switch. Default follows the OS
  (`prefers-color-scheme`, handled purely in CSS — see styles/base.css);
  clicking here stamps an explicit `data-theme` on <html> that overrides it
  in either direction, persisted in localStorage so it survives reloads.
-->
<script setup>
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

const STORAGE_KEY = "palpilot.theme";
const { t } = useI18n();
const theme = ref(localStorage.getItem(STORAGE_KEY) || "");

function apply(value) {
  if (value) document.documentElement.setAttribute("data-theme", value);
  else document.documentElement.removeAttribute("data-theme");
}

function toggle() {
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  const current = theme.value || (prefersLight ? "light" : "dark");
  theme.value = current === "light" ? "dark" : "light";
  localStorage.setItem(STORAGE_KEY, theme.value);
  apply(theme.value);
}

onMounted(() => apply(theme.value));
</script>

<template>
  <button
    class="theme-toggle"
    :aria-label="theme === 'light' ? t('header.theme.switchToDark') : t('header.theme.switchToLight')"
    :title="theme === 'light' ? t('header.theme.switchToDark') : t('header.theme.switchToLight')"
    @click="toggle"
  >
    {{ theme === "light" ? "🌙" : "☀" }}
  </button>
</template>

<style scoped>
.theme-toggle {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  font-size: 15px;
  line-height: 1;
}
.theme-toggle:hover {
  border-color: var(--accent);
}
</style>

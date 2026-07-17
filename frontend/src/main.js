import { createPinia } from "pinia";
import { createApp } from "vue";
import { createI18n } from "vue-i18n";

import App from "./App.vue";
import en from "./i18n/en.js";
import "./styles/base.css";
import { useSessionStore } from "./stores/session.js";

const i18n = createI18n({
  legacy: false, // Composition API mode: useI18n() in <script setup>
  locale: "en",
  fallbackLocale: "en",
  messages: { en },
});

const app = createApp(App);
app.use(createPinia());
app.use(i18n);

// Recover {user,perms} from a stored token (if any/still valid) before the
// first render, so a page reload doesn't flash the login screen for an
// already-authenticated session.
useSessionStore().restore();

app.mount("#app");

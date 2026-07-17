# PalPilot v2 frontend

Vite + Vue 3 SFC source for the coordinator UI. Builds to a single self-contained
`coordinator/index.html` (all JS/CSS inlined via `vite-plugin-singlefile`) — the
coordinator Cloud Function keeps serving one static file exactly as it does today.
Node is a **build-time only** dependency; nothing here runs in production.

## Build

```sh
cd coordinator/frontend
npm ci
npm run build
```

`vite.config.js` sets `build.outDir` to `..` (i.e. `coordinator/`) with
`emptyOutDir: false`, so `npm run build` overwrites `coordinator/index.html`
directly — no manual copy step needed. Nothing else under `coordinator/` is
touched or deleted.

`npm run dev` runs the Vite dev server against `index.html` in this directory
for local iteration; it talks to the coordinator API using relative paths
(`location.pathname`), so point it at a coordinator instance via a dev proxy
if you need live API responses.

## Layout

```
src/
  main.js               createApp + pinia + vue-i18n, mounts #app
  App.vue                shell: grouped sidebar nav, header, toast/confirm hosts
  api.js                 fetch wrapper: Bearer session token, {ok,error} envelope,
                          401 -> session.handleUnauthorized(), busy registry
  session.js              token storage + decode (no pinia — plain localStorage/JWT-ish utils)
  i18n/en.js              all user-facing strings (English default)
  stores/
    session.js (pinia)   auth state, perms, login/logout/logout-all/change-password
    server.js (pinia)    /api/overview polling, vm start/stop, config load/save
  components/ui/         Card, Btn, Toast(+ useToast), ConfirmDialog(+ useConfirm),
                          Modal, DataTable, StatCard, Badge, Field, ThemeToggle
  views/
    LoginView.vue
    StatusView.vue        redesigned overview (built this phase)
    AccountView.vue       change password + logout-all (built this phase)
    SavesView.vue         stub — filled in by the views phase
    ModsView.vue          stub — filled in by the views phase
    SettingsView.vue      stub — filled in by the views phase
    CommandsView.vue      stub — filled in by the views phase
    WatchdogView.vue      stub — filled in by the views phase
    UsersView.vue         stub — filled in by the views phase
```

No router: `App.vue` holds a single reactive `currentView` and provides
`{ currentView, goTo(id) }` (key `"nav"`) to descendants so any view can
navigate (e.g. a "view backups in Saves" link from the Status hero).

See `../../docs/FRONTEND_V2_PLAN.md` for the full API contract both this app
and the coordinator/panel backends must agree on.

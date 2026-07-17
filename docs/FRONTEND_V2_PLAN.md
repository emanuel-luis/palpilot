# PalPilot v2 — Frontend rework, session auth, saves clone/rename, dual-mode mods

> Anchor spec for the v2 rework. Branch `feat/frontend-v2`. Build-only; deploy is operator-gated.
> This is a LIVE server — Proton runtime is **opt-in and NOT activated** by this work.

## Decisions (locked)
- **Frontend:** Vite + Vue 3 **SFC** components, built to a single self-contained `coordinator/index.html`
  via `vite-plugin-singlefile`. Source under `coordinator/frontend/`. The committed `index.html` keeps the
  one-file serve + hot-deploy contract (coordinator serving is unchanged). Node build only at dev time.
- **Auth:** session tokens (signed, expiring) replace raw base64-Basic-in-localStorage. Polished login UI,
  password change, logout-all, rate-limit feedback.
- **Mods:** dual-mode. Native (default) = `.pak`/LogicMods. Proton (opt-in runtime) = UE4SS script mods (UBIM).
  Panel is capability-aware and cleanly blocks UE4SS when not in Proton mode.
- **Server runtime:** dual-mode via `var.runtime_mode` (`native`|`proton`), default `native` (unchanged).

## Navigation (regrouped)
Left sidebar, grouped:
- **Overview** — Status (redesigned: server hero, players/max, uptime, in-game day, quick start/stop, metric cards, players table, recent backups).
- **Server** — Saves · Mods · Settings (config) · Commands · Watchdog.
- **Admin** — Users · Account (password change / sessions).
Responsive: sidebar collapses to a top drawer on mobile. Light/dark theme.

## Frontend layout (`coordinator/frontend/`)
```
package.json            vue, vite, @vitejs/plugin-vue, vite-plugin-singlefile, pinia, vue-i18n
vite.config.js          singlefile plugin; build.outDir -> emits ../index.html (committed)
index.html              vite entry (dev); prod is inlined
src/
  main.js               createApp + pinia + i18n
  App.vue               shell: sidebar nav + router-less view switch + toast host
  api.js                fetch wrapper: Bearer session token, 401->logout, busy registry, {ok,error} envelope
  session.js            token storage, decode exp, auto-refresh/expiry handling
  i18n/en.js            all strings (English default)
  stores/
    session.js (pinia)  auth state, perms, login/logout/password
    server.js (pinia)   overview polling, vm power, config
  components/ui/        Card, Btn(BusyButton), Toast, ConfirmDialog, Modal, DataTable, StatCard, Badge, Field, ThemeToggle
  views/
    LoginView.vue
    StatusView.vue      redesigned overview
    SavesView.vue       list + create + activate + backup + restore + CLONE + RENAME + delete
    ModsView.vue        capability-aware: pak/logic + UE4SS(gated) + upload(zip/pak)+url + enable/disable
    SettingsView.vue    schema-aware config editor (port of current)
    CommandsView.vue    announce/kick/ban/save/shutdown
    WatchdogView.vue    poll/grace
    UsersView.vue       user CRUD
    AccountView.vue     change password, logout-all
```
Build: `npm ci && npm run build` → writes self-contained `coordinator/index.html`. Committed.

## API contract (all agents MUST match)

### Auth / session (coordinator)
- `POST /api/login {username,password}` -> `{ok, token, user, perms, exp}` (429 with `{ok:false,error,retry_after}` when throttled).
- Session token = `base64url(header).base64url(payload).hex(HMAC-SHA256(header.payload, INTERNAL_TOKEN))`,
  payload `{u, perms, iat, exp, ver}` (compact JWT-like; do NOT add a JWT dependency, hand-roll with hmac+json).
  `ver` = per-user token version from users.json (bumped by logout-all).
- Requests authenticate via `Authorization: Bearer <token>`. Coordinator verifies signature, `exp` (e.g. 12h),
  and that `ver` matches the user's current `ver`. Basic-Auth still accepted ONLY on `/api/login` (+ break-glass).
- `POST /api/logout` (client drops token; no-op server side) · `POST /api/logout-all` (bump caller's `ver`).
- `POST /api/account/password {old,new}` -> re-hash (PBKDF2 600k), bump `ver`.
- users.json user record gains `"ver": <int>` (default 0 for legacy records).

### Saves (panel, proxied under /api/saves*) — additions
- `POST /api/saves/{guid}/clone {name}` -> `{ok, guid, name}` : copy the world folder to a NEW guid, register metadata `{name, created, cloned_from}`. (Copy only; if guid is the active slot, note in response that a fresh in-game save is recommended first.)
- `POST /api/saves/{guid}/rename {name}` -> `{ok, guid, name}` : update friendly name in slot metadata only.
- (existing: list/create/activate/backup/backups/restore/delete stay.)

### Mods (panel, proxied under /api/mods*) — dual-mode
- `GET /api/mods` -> `{ok, runtime_mode:"native"|"proton", capabilities:{pak:true, logic:true, ue4ss:bool}, mods:[{name,type:"pak"|"logic"|"ue4ss",enabled,source_url,installed_at}]}`.
- `POST /api/mods/upload?name=&restart=` (raw body): accept `.pak` (→ ~mods) OR `.zip` (extract + place by layout:
  loose `.pak`→~mods; `LogicMods/`→Paks/LogicMods; UE4SS layout (`Mods/`, `enabled.txt`, `dlls`)→Binaries/Win64/ue4ss).
  If the archive is a UE4SS/script mod and `runtime_mode != proton` -> `409 {ok:false,error:"requires Proton runtime"}`.
- `POST /api/mods/url {url,name}` — same rules, size-capped, SSRF-guarded (keep existing guards).
- `POST /api/mods/ue4ss/install {url?}` -> install RE-UE4SS into Pal/Binaries/Win64 (`409` if not proton).
- `POST /api/mods/{name}/enable|disable` · `DELETE /api/mods/{name}` (type-aware).
- Panel reads `RUNTIME_MODE` env (default `native`). NO cmd/ps1 execution — the panel performs the file
  placement a Windows setup script would do; it never runs arbitrary scripts.

## Runtime dual-mode (terraform/startup.sh) — opt-in, NOT activated now
- `var.runtime_mode` (`native`|`proton`, default `native`); passed as `runtime-mode` VM metadata + `RUNTIME_MODE` panel env.
- `native`: current behavior, unchanged.
- `proton`: startup.sh installs GE-Proton, fetches the WINDOWS PalServer via steamcmd
  (`+@sSteamCmdForcePlatformType windows`), lays out UE4SS dirs, runs `PalServer.exe` under Proton in the
  systemd unit. Heavily guarded so `native` is byte-identical to today. Documented as needing a bigger machine
  + a VM recreate to switch. Best-effort; validated only by review (not booted).

## Constraints (unchanged from modernization plan §4)
Keep coordinator/panel two-tier split, GCS-JSON, hot-deploy path, persistent disk, per-user perms. No new heavy
backend deps (hand-roll the token with stdlib hmac). Frontend MAY use vite/vue/pinia/vue-i18n (build-time only).
Nothing deployed by the build; Proton stays off.

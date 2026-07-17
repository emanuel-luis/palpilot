# PalPilot v3 — unified Console, minimalist redesign, granular perms + roles

> Branch `feat/frontend-v2` (continues v2). Build-only; deploy operator-gated.
> Anchor design system already written: `frontend/src/styles/base.css` (tokens + utilities). Honor it.

## A. Design language (minimalist "instrument panel")
- **Palette (tokens in base.css):** cool graphite (`--bg #0d1013` … `--panel-2 #1a2026`), hairline `--border`,
  ONE restrained warm-amber accent `--accent #e2a03f` used sparingly (primary action, active nav, online glow).
  Semantics: `--ok` green (online), `--danger` red, `--warn`=amber (transition). Light theme mirrored.
- **Type:** `--font-ui` (system grotesk) for UI; `--font-mono` for ALL data/IDs/metrics; `.eyebrow` = uppercase
  mono micro-label for section headers.
- **Signature:** server **power state is the hero** — a status header with a breathing dot when online; when off,
  surfaces desaturate and the amber ⏻ power button is the one CTA.
- **Icons (symbols, monochrome unicode, ALWAYS with aria-label + title):** power ⏻ · start ▶ · stop ■ · refresh ↻ ·
  activate ★ · backup ↧ · restore ↺ · clone ⧉ · rename ✎ · delete ✕ · settings ⚙ · mods ⧉̸→ use ⬡ · announce ✦ ·
  add ＋ · expand › . Prefer geometric glyphs over colorful emoji.
- **Overflow:** use base.css `.break` (wrap GUIDs/IDs/paths), `.clamp` (+`title`) for single-line truncation,
  `.scroll-x` for wide tables. Never let text escape a card/cell.
- **Buttons in one row:** use base.css `.actions` (nowrap, self-scrolling) + compact `.icon-btn`/`Btn icon`.

## B. Information architecture — ONE Console
Collapse the five server tabs into a single **Console** view (full server overview):
```
CONSOLE
  ├ Status hero            power state · world name · players X/max · uptime · day · [⏻] [↻]
  ├ Saves                  active slot + slot list; actions ★ ↧ ↺ ⧉ ✎ ✕ ; ＋ new
  ├ Active World           (per-save framing) → ⚙ Settings (accordion) · ⬡ Mods (accordion)
  ├ Commands               ✦ announce · kick/ban · 💾 save · ⏻ shutdown
  └ Watchdog               idle poll + grace
```
Nav (sidebar) becomes two groups: **Console** · **Admin** (Users, Account). The status hero replaces the separate
Status tab. Settings + Mods sit under an "Active World" heading (framed as belonging to the active save; a future
backend enhancement can make them truly per-slot — out of scope now, note it in the UI).

New view `frontend/src/views/ServerConsoleView.vue` composes: a StatusHero section + the existing SavesView,
SettingsView, ModsView, CommandsView, WatchdogView rendered inside labelled collapsible sections (accordion via
`<details>` or a small Section component). Keep each feature's logic in its own view; the console only arranges +
labels them and gates each section by its permission.

## C. Permissions — granular, per feature
Replace the coarse set with granular perms (superset; keep names stable where possible):
```
view      see status / overview / players / metrics
power     start / stop the VM
saves     manage save slots (create/activate/clone/rename/delete/backup/restore)
mods      manage mods
settings  edit PalWorldSettings.ini (was part of "config")
watchdog  edit the idle-watchdog timeout (was part of "config")
commands  run REST commands (announce/kick/ban/save/shutdown)
users     manage panel users AND roles
```
`PERMS = [view, power, saves, mods, settings, watchdog, commands, users]`.

**Backward-compat:** legacy records/roles holding `"config"` expand to `{saves, mods, settings, watchdog}` at
read time (a `_expand_perms()` helper on both coordinator and panel). Never break an existing admin.

**Route → perm mapping (coordinator route table + panel per-endpoint enforcement MUST match):**
| Path | Method | Perm |
|---|---|---|
| /api/overview, /api/vm/status, GET status-ish | GET | view |
| /api/vm/start, /api/vm/stop | POST | power |
| /api/saves* | non-GET | saves · (GET → view) |
| /api/mods* | non-GET | mods · (GET → view) |
| /api/config | POST | settings · (GET → view) |
| /api/restart | POST | settings |
| /api/watchdog | POST | watchdog · (GET → view) |
| /api/rest/* | POST | commands · (GET → view) |
| /api/users*, /api/roles* | any | users |

## D. Roles — preset permission bundles
- New GCS doc `roles.json`: `{ "roles": { "<name>": { "perms": [...], "builtin": bool } } }`.
- **Built-in roles (seeded, editable perms but not deletable):**
  - `owner` → all perms.
  - `operator` → view, power, saves, mods, settings, watchdog, commands (no users).
  - `moderator` → view, commands.
  - `viewer` → view.
- Each user record gains `"role": "<name>"`. **Effective perms = _expand_perms(role.perms) ∪ any per-user
  `perms` override** (keep the existing per-user `perms` array as an optional override; if a user has a role,
  the role supplies the baseline). Simplest rule to implement + explain: if `role` set, effective = role's perms;
  a user may also be `role: "custom"` with an explicit `perms` array. Resolve in one `_effective_perms(user)`.
- **Coordinator endpoints (perm `users`):**
  - `GET /api/roles` → `{ok, roles:[{name, perms, builtin}], all_perms:[...]}`
  - `POST /api/roles {name, perms}` → create/update a custom role (reject editing a builtin's identity; allow
    editing a builtin's perms if you choose — keep builtins' perms editable but keep `builtin:true`, and forbid
    delete).
  - `DELETE /api/roles/{name}` → delete a custom (non-builtin) role; refuse if any user still holds it.
  - `POST /api/users` accepts `role` (and optional `perms` when role=custom). Keep the "last user-manager" guard
    using EFFECTIVE perms.
- **Panel (panel.py):** `_verify_coord_headers` already receives `X-Coord-Perms` = the effective perms; update the
  per-endpoint permission checks to the granular perms above (+ `_expand_perms` for legacy `config`).

## E. Frontend
- `session.can(perm)` unchanged API; perms come from login/token (already effective from the coordinator).
- Nav + each Console section gated by its granular perm (view/saves/mods/settings/watchdog/commands); Admin by users.
- **UsersView:** per user show + edit **Role** (dropdown of roles) and, when role=custom, granular perm checkboxes.
- **New RolesView (or a panel within UsersView):** list roles, create/edit a role (name + granular perm
  checkboxes), delete custom roles. Built-ins badged, not deletable.
- Add `icon` support to `Btn.vue` (icon-only compact variant, requires `aria-label`); i18n strings for all new
  labels/perm names/role names in `frontend/src/i18n/en.js`.

## Constraints
Keep two-tier split, GCS-JSON (add roles.json alongside users.json), hot-deploy, session tokens, per-user `ver`.
No heavy deps. Nothing deployed by the build. Verify: `npm run build` (single-file), `py_compile`,
`terraform validate`, contract match coordinator↔panel↔frontend.

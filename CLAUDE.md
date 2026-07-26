# CLAUDE.md — working in this repo

PalPilot: an on-demand Palworld dedicated server on GCP with a web control plane. See `README.md` for the product
and `docs/ARCHITECTURE.md` for diagrams. This file is the practical guide for making changes safely.

## Repo map

```
coordinator/          Always-on control plane — Cloud Function (gen2, HTTP), Python.
  main.py             Auth (session tokens), users/roles, watchdog config, VM power, signed proxy to the agent.
  discord_bot.py      Discord slash commands (interactions webhook); protocol only, actions via main._DiscordOps.
  index.html          BUILT single-page console (generated — do not hand-edit; see frontend/).
  requirements.txt
frontend/             Console source: Vite + Vue 3 SFCs. Builds to a self-contained coordinator/index.html.
  src/{App.vue, api.js, session.js, i18n/, stores/, components/ui/, views/}
panel/                VM-side agent, Python (FastAPI).
  panel.py            Settings/saves/mods/backups/restore; Palworld REST proxy; per-endpoint permission checks.
  idle_watchdog.py    Powers the VM off when the server is empty.
  index.html          Static "use the console" page (the agent no longer serves an admin UI).
  tests/test_ini.py   Unit tests for the PalWorldSettings.ini parser (the riskiest logic).
main.tf, coordinator.tf, variables.tf, outputs.tf   Terraform (VM, IP, disks, buckets, function, IAM, monitoring).
startup.sh            VM boot script (provisioning, systemd units, fetches agent code from the bucket).
scripts/discord_register.py    One-off: registers the guild slash commands from discord_bot.COMMAND_DEFS.
.github/workflows/deploy.yml   CI auto-deploy on push (see docs/CICD.md).
docs/                 ARCHITECTURE.md, CICD.md, DISCORD.md.
```

## Build & verify (no app runtime needed)

- **Frontend:** `cd frontend && npm ci && npm run build` → overwrites `coordinator/index.html` (single-file). The
  build is the correctness gate for the Vue SFCs.
- **Python:** `python3 -m py_compile coordinator/main.py panel/panel.py panel/idle_watchdog.py` and
  `cd panel && python3 -m unittest -q tests.test_ini`.
- **Terraform:** `terraform fmt -recursive && terraform validate`.

## How each part deploys (this is the crux — get it right)

- **Coordinator + console** → redeploy the Cloud Function (CI: `gcloud functions deploy`; manual: `terraform apply`
  targeting the function). Zero downtime. Rebuild the frontend first so `coordinator/index.html` is fresh.
- **Agent (`panel/*`)** → push to the panel GCS bucket. The VM fetches it **on next boot** (startup.sh) or via the
  self-update endpoint. Terraform intentionally does NOT manage panel code (`ignore_changes = [source]`), so
  `terraform apply` never redeploys it.
- **Infra (`*.tf`, `startup.sh`)** → `terraform apply`. **Editing `startup.sh` forces a VM recreate** — plan it as a
  maintenance window (it disconnects players). The persistent data disk survives the recreate.

## Hard constraints — do not break

- **Live server with real players.** Anything that restarts `palworld.service`, recreates the VM, or changes the
  network is a maintenance-window action, not an any-time deploy.
- **Persistent data disk (`/home/steam/Steam`) must survive** any VM recreate — it holds worlds, mods, slot configs.
- **Secrets never in git:** `terraform.tfvars`, `terraform.tfstate*` are gitignored — keep them that way, and out of
  cloud-synced folders. `frontend/node_modules` and build caches stay out too.
- **`frontend/` lives OUTSIDE `coordinator/`** so the function zip never ingests `node_modules`. Keep it there.
- **Permission names must match across three places:** the coordinator route table, the agent's `require(...)`
  checks, and the console's `session.can(...)` gating. The set is
  `view, power, saves, mods, settings, watchdog, commands, users`.

## Key facts / gotchas

- **Auth:** login is HTTP Basic once → the coordinator issues a signed session token (Bearer). Coordinator→agent
  calls carry separate signed `X-Coord-*` headers (HMAC with the shared `INTERNAL_TOKEN`) so the agent enforces the
  same permissions. Empty `INTERNAL_TOKEN` fails closed.
- **Roles:** `roles.json` in the panel bucket; built-ins owner/operator/moderator/viewer plus custom roles. Users
  carry a `role`; effective permissions resolve role-vs-custom in one helper. A legacy coarse `config` permission is
  expanded to `saves,mods,settings,watchdog` for backward compatibility.
- **Per-save settings:** each slot stores its own `PalWorldSettings.ini`; activating a slot swaps it into the live
  config, then `bootstrap()` re-asserts the REST/admin keys so the panel↔game link cannot break.
- **The console SPA is served `Cache-Control: no-store`** so a deploy is always picked up (a stale bundle can hide
  UI gated on old permissions).
- **Self-update restart can be flaky** — a fresh VM boot reliably fetches the latest agent from the bucket; when in
  doubt, a clean `systemctl restart palworld-panel` (or a reboot) is the sure path.
- **Mods are dual-mode:** native `.pak`/LogicMods always; UE4SS script mods require the opt-in Proton runtime
  (`var.runtime_mode = "proton"`, a deliberate VM recreate) — otherwise UE4SS installs return 409.
- **Cost model:** the VM auto-powers-off when empty; the fixed floor is the static IP + persistent disks, the
  variable cost is VM compute while running.
- **Discord bot:** `POST /api/discord/interactions` is handled *before* the auth gate and authenticated by
  Ed25519 signature (`DISCORD_PUBLIC_KEY`; empty = 404). Discord roles map to the same perm set, then flow
  through the usual `_rbac_headers()` signing — no privileged side-channel. Answer within ~3s or Discord drops
  the interaction (hence parallel agent calls with 2.5s timeouts and no deferred/followup path). Adding a
  command means editing BOTH `COMMANDS` and `COMMAND_DEFS`, then re-running `scripts/discord_register.py`.
  Deploys with the coordinator (function redeploy, zero downtime). See docs/DISCORD.md.

## Conventions

- Match the surrounding style in each file. Coordinator/agent responses use a `{ ok, error, ... }` envelope
  (Palworld REST passthrough bodies are the exception). Frontend strings live in `frontend/src/i18n/en.js` (English).
- Prefer editing in place over restructuring; keep `panel.py` a single file (the boot fetch copies named files).

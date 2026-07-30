# CLAUDE.md — working in this repo

PalPilot: an on-demand Palworld dedicated server on GCP with a web control plane. See `README.md` for the product
and `docs/ARCHITECTURE.md` for diagrams. This file is the practical guide for making changes safely.

## Repo map

```
coordinator/          Always-on control plane — Cloud Run service `palpilot-coordinator`, Python.
  main.py             Auth (session tokens), users/roles, watchdog config, VM power, signed proxy to the
                      agent, and the static console routes (assets + SPA fallback).
  discord_bot.py      Discord slash commands (interactions webhook); protocol only, actions via main._DiscordOps.
  Dockerfile          Runs main.py's same entry point under gunicorn via functions_framework.create_app().
  index.html          BUILT app shell (generated — do not hand-edit; see frontend/).
  assets/             BUILT hashed JS/CSS chunks (generated).
  tests/test_static_routes.py   Asset route, SPA fallback, traversal guard, API-still-gated.
  tests/test_vm_serial.py       GET /api/vm/serial: gating, secret redaction, VM-off is a state.
  requirements.txt
frontend/             Console source: Vite + React 18 + TypeScript + Tailwind. Multi-file build.
  src/{App.tsx, lib/, stores/, hooks/, i18n/, data/, components/, views/, mocks/, styles.css}
panel/                VM-side agent, Python (FastAPI).
  panel.py            Settings/saves/mods/backups/restore; Palworld REST proxy; host metrics; game logs;
                      per-endpoint permission checks.
  idle_watchdog.py    Powers the VM off when the server is empty.
  index.html          Static "use the console" page (the agent no longer serves an admin UI).
  tests/test_ini.py   Unit tests for the PalWorldSettings.ini parser (the riskiest logic).
  tests/test_metrics_logs.py    /proc parsers (fixture-driven) + the log reader.
  tests/test_update.py          Steam VDF/ACF parsing + version policy, pin and reconcile rules.
main.tf, coordinator.tf, variables.tf, outputs.tf   Terraform (VM, IP, disks, buckets, function, IAM, monitoring).
startup.sh            VM boot script (provisioning, systemd units, fetches agent code from the bucket).
scripts/discord_register.py    One-off: registers the guild slash commands from discord_bot.COMMAND_DEFS.
.github/workflows/deploy.yml   CI auto-deploy on push (see docs/CICD.md).
docs/                 ARCHITECTURE.md, CICD.md, DISCORD.md.
```

## Build & verify (no app runtime needed)

- **Frontend:** `cd frontend && npm ci && npm run build` → writes `coordinator/index.html` + `coordinator/assets/*`
  (`prebuild` clears stale hashed chunks first; `emptyOutDir` must stay false or it would wipe `main.py`). The
  build, including `tsc -b`, is the correctness gate.
- **Python:** `python3 -m py_compile coordinator/main.py panel/panel.py panel/idle_watchdog.py`,
  `cd coordinator && python3 -m unittest -q tests.test_static_routes` (run the frontend build first — the asset
  tests need real hashed files), and
  `cd panel && python3 -m unittest -q tests.test_ini tests.test_metrics_logs tests.test_update`.
  `tests/` has no `__init__.py`, so `unittest discover` can't load it — name modules explicitly.
- **Terraform:** `terraform fmt -recursive && terraform validate`.

## How each part deploys (this is the crux — get it right)

- **Coordinator + console** → redeploy the Cloud Run service (CI: `gcloud run deploy --source coordinator`, which
  builds `coordinator/Dockerfile` via Cloud Build). Zero downtime. CI rebuilds the frontend first, so the image
  always carries a fresh console. Terraform owns the service *shape* and ignores `image`; CI owns the image.
- **Agent (`panel/*`)** → push to the panel GCS bucket. The VM fetches it **on next boot** (startup.sh) or via the
  self-update endpoint. Terraform intentionally does NOT manage panel code (`ignore_changes = [source]`), so
  `terraform apply` never redeploys it.
- **Infra (`*.tf`, `startup.sh`)** → `terraform apply`. **Editing `startup.sh` DOES force a VM recreate**:
  `metadata_startup_script` is ForceNew on `google_compute_instance`, confirmed by
  `terraform show` reporting `metadata_startup_script … # forces replacement`. Plan it as a maintenance window
  (it disconnects players). The persistent data disk survives, the boot disk does not.
  Ordinary `metadata` entries (e.g. `coordinator-url`) ARE in-place and take effect on the next boot — those two
  cases are different, which is easy to conflate.
- `startup.sh` drift was reconciled by a VM replace on 2026-07-30 (boot disk erased, dependencies reinstalled, data
  disk intact); `terraform plan` is clean again. Still check a plan for `must be replaced` on
  `google_compute_instance.palworld` before every apply — that is a maintenance-window action, never a routine one.
- **A VM replace silently drops the console's power permission.** `google_compute_instance_iam_member.coordinator_vm_ops`
  lives in the INSTANCE's IAM policy, which comes up empty on a new instance, but its Terraform id is keyed by
  instance NAME — unchanged — so Terraform sees no drift and plans nothing. Symptom: everything looks healthy but the
  console can't power the VM on (the SA lost `compute.instances.start`). It bit both recreates before
  `lifecycle { replace_triggered_by = [google_compute_instance.palworld] }` was added. Verify after any replace with
  `gcloud compute instances get-iam-policy palworld-tf-vm --zone <zone>`; an empty `{"etag": …}` means the binding is
  gone.

## Hard constraints — do not break

- **Live server with real players.** Anything that restarts `palworld.service`, reboots or recreates the VM, or
  changes the network is a maintenance-window action, not an any-time deploy. Always read `terraform plan` for
  `must be replaced` before applying.
- **Persistent data disk (`/home/steam/Steam`) must survive** any VM recreate — it holds worlds, mods, slot configs.
- **Secrets never in git:** `terraform.tfvars`, `terraform.tfstate*` are gitignored — keep them that way, and out of
  cloud-synced folders. `frontend/node_modules` and build caches stay out too.
- **`frontend/` lives OUTSIDE `coordinator/`** so the deployed source never ingests `node_modules`. Keep it there.
- **Permission names must match across three places:** the coordinator route table, the agent's `require(...)`
  checks, and the console's `session.can(...)` gating. The set is
  `view, power, saves, mods, settings, watchdog, commands, users`.

## Key facts / gotchas

- **Auth:** login is HTTP Basic once → the coordinator issues a signed session token (Bearer). The token payload
  names the user **`u`**, not `user`. Coordinator→agent
  calls carry separate signed `X-Coord-*` headers (HMAC with the shared `INTERNAL_TOKEN`) so the agent enforces the
  same permissions. Empty `INTERNAL_TOKEN` fails closed.
- **Roles:** `roles.json` in the panel bucket; built-ins owner/operator/moderator/viewer plus custom roles. Users
  carry a `role`; effective permissions resolve role-vs-custom in one helper. A legacy coarse `config` permission is
  expanded to `saves,mods,settings,watchdog` for backward compatibility.
- **Per-save settings:** each slot stores its own `PalWorldSettings.ini`; activating a slot swaps it into the live
  config, then `bootstrap()` re-asserts the REST/admin keys so the panel↔game link cannot break.
- **`index.html` is served `Cache-Control: no-store`** so a deploy is always picked up (a stale bundle can hide UI
  gated on old permissions), while `/assets/*` is `immutable` for a year — safe because Vite hashes every filename.
- **The static asset + SPA-fallback routes sit ABOVE the auth gate** and are public: a `<script>` request carries no
  bearer token. Nothing new is exposed (`GET /` was always public and always held the whole app), but never move an
  `/api/*` route above that gate. A missing file must 404, not 401 — a 401 carries `WWW-Authenticate` and can pop a
  browser credential prompt.
- **Never derive the API base from `location.pathname`.** With the SPA fallback that is the current route, not the
  mount point. It comes from `VITE_API_BASE` (empty for the Cloud Run root).
- **Self-update restart can be flaky** — a fresh VM boot reliably fetches the latest agent from the bucket; when in
  doubt, a clean `systemctl restart palworld-panel` (or a reboot) is the sure path.
- **Mods are dual-mode:** native `.pak`/LogicMods always; UE4SS script mods require the opt-in Proton runtime
  (`var.runtime_mode = "proton"`, a metadata change that needs a reboot to take effect) — otherwise UE4SS
  installs return 409.
- **Cost model:** the VM auto-powers-off when empty; the fixed floor is the static IP + persistent disks, the
  variable cost is VM compute while running. No load balancer anywhere — adding one would add a fixed hourly
  charge larger than the current floor.
- **Two log sources, and only one of them is the agent's.** `GET /api/logs` tails the game's Unreal logs on the data
  disk (agent, needs the VM up). `GET /api/vm/serial?start=N` is **coordinator-owned** and returns the VM's serial
  console — startup.sh echoes, systemd unit transitions, the `game-sync` reconcile, PalServer's stdout — which is the
  only way to see a boot: the agent can't read the journal (no `journalctl`/sudoers grant without a `startup.sh` edit)
  and isn't running yet anyway. It needs `compute.instances.getSerialPortOutput` on the coordinator's custom role (a
  permission edit, applied in place). Tail by feeding the previous `next` back as `start`; GCP's buffer is a ring, so
  `start` coming back ahead of what you asked for means output aged out. A non-RUNNING VM answers
  `ok:true, available:false` — "the VM is off" is a state to render, not an error. Output is raw VM text, so it goes
  through `_redact()` before reaching a browser.
- **Host metrics + game logs:** `GET /api/metrics/host` parses `/proc` and `GET /api/logs` tails the game log tree
  with a byte cursor (both `view`). Deliberately no `psutil` and no `journalctl`: the venv has only
  fastapi+uvicorn and the sudoers drop-in allows exactly nine `systemctl` commands, so either would force a
  `startup.sh` edit. Readings that are unavailable return `null`, never `0`.
- **Save import is chunked, on purpose:** the console uploads through the coordinator, and Cloud Run rejects a
  request body over 32 MiB, so `POST /api/saves/upload` opens a session and the browser sends ordered
  `.../upload/<id>/part?index=N` slices (`UPLOAD_PART_MAX_BYTES`, 24 MiB) that the agent appends to one file
  before `.../finish` extracts it. Parts must arrive in order (append-only file); a failed part truncates back
  to the last good offset. Archives are extracted member-by-member with traversal/symlink rejection and an
  uncompressed-size cap (`SAVE_MAX_BYTES`) — never `tar xzf` on untrusted input. An import always lands as a
  NEW slot; it never overwrites a world.
- **steamcmd lies about failure, and its first run is flaky.** `+app_update` exits **0** on a failed update and only
  says so in its output: `Error! App '2394010' state is 0x6 after update job.` (0x6 = UpdateRequired|FullyInstalled,
  i.e. "an update is due and I didn't apply it"). It also commonly fails on the first invocation after it
  self-updates and re-execs — which is why `startup.sh` retries the initial install 5×. So an install is only
  successful if the appmanifest's buildid actually became the wanted build AND no `state is 0x…` line was printed;
  `_install_latest()` verifies both. A live server shipped stale precisely because the first version of that
  function only checked "an appmanifest exists" and reported `ok: true`. Retrying the same command is not enough
  either (prod failed 3× identically with `progress: 0.00 (0 / 0)`), so attempts ESCALATE via `_UPDATE_STRATEGIES`:
  plain → `+app_info_update 1` → clear `appcache/appinfo.vdf` → clear `steamapps/downloading/<appid>`. The winning
  strategy is reported, and a failure carries the tail of Steam's own `logs/content_log.txt`, which is the only
  place the real cause is written.
- **Downloads are anonymous (`steamcmd +login anonymous`), and that is rate-limited per account/IP.** Steam has
  answered `Access Denied` on a manifest request code (`content_log.txt`) and stranded this server on an old build;
  no retry or cache clear fixes that, so `_install_latest()` detects it and sets a persisted cooldown
  (`update_cooldown()`) instead of hammering. An authenticated-login path was built and then removed on request —
  if the denial recurs, that is the fix to reach for (git history: "optional Steam account sign-in").
  `download_depot` stages under `STEAMCMD_HOME` on the data disk (it ignores `force_install_dir`, and the default
  HOME is the small boot disk), and cleanup deletes only `steamapps/content` (`_clear_depot_staging()`).
- **Game version is agent-owned:** policy + observed-build history live in `palworld-update.json` on the data disk,
  the wanted build per save lives in the slot metadata (`version: {mode, buildid}`), and `reconcile_version()` is the
  single entry point (boot via `panel.py game-sync`, panel start-up thread, save activate/restore, interval, or
  `POST /api/update/apply`). Installing means stopping the game, so it refuses while players are online unless
  forced. **Pinning only works for builds this server has observed** — Steam won't serve manifest ids for old builds,
  so `download_depot` needs manifests we recorded while that build was current (the installed build is always
  readable from `appmanifest_<app>.acf`). A pinned install does NOT update that `.acf`, hence the agent's own
  `installed` marker wins for `method: "pinned"`. `/api/update*` is gated view/settings (like `/api/config`);
  `/api/saves/{guid}/version` is gated `saves`, because the version belongs to the save.
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

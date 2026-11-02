# CLAUDE.md — working in this repo

PalPilot: an on-demand Palworld dedicated server on GCP with a web control plane. See `README.md` for the product
and `docs/ARCHITECTURE.md` for diagrams. This file is the practical guide for making changes safely.

## Repo map

- `coordinator/` — always-on control plane, Cloud Run service `palpilot-coordinator`, Python. `main.py` = auth,
  users/roles, watchdog config, VM power, signed proxy to the agent, static console routes. `discord_bot.py` = Discord
  slash commands (actions via `main._DiscordOps`). `index.html` and `assets/` are BUILT, untracked output of
  `make build` (never hand-edit).
- `frontend/` — console source (Vite + React 19 + TypeScript + Tailwind 4, Vitest; Node 24 in CI), outside
  `coordinator/`. Strings in `frontend/src/i18n/en.ts`.
- `panel/` — VM-side agent (FastAPI). `panel.py` = settings/saves/mods/backups, Palworld REST proxy, host metrics,
  game logs, per-endpoint permission checks. `idle_watchdog.py` powers the VM off when empty.
- `main.tf`, `coordinator.tf`, `variables.tf`, `outputs.tf` — Terraform. `startup.sh` — VM boot script.
- `scripts/discord_register.py` registers guild slash commands from `discord_bot.COMMAND_DEFS`;
  `.github/workflows/deploy.yml` is CI auto-deploy (`docs/CICD.md`); `docs/` has ARCHITECTURE, CICD, DECISIONS,
  DISCORD, REVIVAL, SECURITY and `diagrams/` (D2 sources with committed SVGs).
- `analytics/` — usage and cost analytics on synthetic history: DuckDB + dbt-duckdb (`make demo`).

## Build & verify (no app runtime needed)

- **Setup:** `make install` (`uv sync --locked` for the Python 3.12 dev tools, `npm ci` in `frontend/`).
- **Frontend:** `make build` writes `coordinator/index.html` + `coordinator/assets/*`
  (`prebuild` clears stale chunks; `emptyOutDir` must stay false or it wipes `main.py`). The build, including
  `tsc -b`, is the correctness gate.
- **Lint:** `make lint` (ruff, `terraform fmt -check`, frontend lint + typecheck; tflint and checkov when installed).
- **Tests:** `make test` = `uv run pytest` (`coordinator/tests`, `panel/tests`) + `npm test` (Vitest). The
  static-route tests need the built console, so `make test` builds it when `coordinator/index.html` is missing.
- **Terraform:** `terraform fmt -recursive`; `make tf-check` (init without a backend, validate).
- **Analytics:** `make demo` (generate, ingest, dbt build, report); `make analytics-test`.

## How each part deploys (get this right)

- **Offline by choice:** billing is off and the deploy jobs run only when the repo variable `DEPLOY_ENABLED` is
  `'true'` (unset). Do not set it, run `gcloud` or `terraform apply` unless the owner is reviving the stack
  (`docs/REVIVAL.md`).
- **Coordinator + console:** redeploy Cloud Run (CI: `gcloud run deploy --source coordinator`; CI rebuilds the
  frontend first). Zero downtime. Terraform owns the service shape and ignores `image`; CI owns the image.
- **Agent (`panel/*`):** push to the panel GCS bucket; the VM fetches it on next boot or via the self-update
  endpoint. Terraform does NOT manage panel code (`ignore_changes = [source]`), so `terraform apply` never redeploys it.
- **Infra (`*.tf`, `startup.sh`):** `terraform apply`. **Editing `startup.sh` FORCES a VM recreate**
  (`metadata_startup_script` is ForceNew; `terraform show` says `# forces replacement`): a maintenance window that
  disconnects players. The data disk survives, the boot disk does not. Ordinary `metadata` entries (e.g.
  `coordinator-url`) are in-place, effective on next boot; do not conflate the two.
- Check every plan for `must be replaced` on `google_compute_instance.palworld`; never a routine action.
- **A VM replace silently drops the console's power permission.** `google_compute_instance_iam_member.coordinator_vm_ops`
  lives in the instance's IAM policy (empty on a new instance) but its Terraform id is keyed by instance NAME, so
  Terraform plans nothing. Symptom: all healthy, but the console can't power the VM on (SA lost
  `compute.instances.start`). `lifecycle { replace_triggered_by = [google_compute_instance.palworld] }` mitigates it.
  After any replace verify with `gcloud compute instances get-iam-policy palworld-tf-vm --zone <zone>`; an empty
  `{"etag": …}` means the binding is gone.

## Hard constraints — do not break

- **Treat the server as live.** It is offline now, but after a revival it has real players: anything that restarts
  `palworld.service`, reboots/recreates the VM, or changes the network is a maintenance-window action. Always read
  `terraform plan` before applying.
- **Persistent data disk (`/home/steam/Steam`) must survive** any VM recreate (worlds, mods, slot configs).
- **Secrets never in git:** `terraform.tfvars`, `terraform.tfstate*` stay gitignored and out of cloud-synced folders;
  so do `frontend/node_modules` and build caches.
- **`frontend/` stays OUTSIDE `coordinator/`** so the deployed source never ingests `node_modules`.
- **Permission names must match in three places:** coordinator route table, agent `require(...)` checks, console
  `session.can(...)` gating. Set: `view, power, saves, mods, settings, watchdog, commands, users`.

## Key facts / gotchas

- **Auth:** HTTP Basic once, then a signed session token (Bearer) whose payload names the user `u`, not `user`.
  Coordinator→agent calls carry signed `X-Coord-*` headers (HMAC with shared `INTERNAL_TOKEN`; empty fails closed).
- **Roles:** `roles.json` in the panel bucket; built-ins owner/operator/moderator/viewer plus custom. A legacy
  `config` permission expands to `saves,mods,settings,watchdog`.
- **Per-save settings:** each slot stores its own `PalWorldSettings.ini`; activating swaps it in, then `bootstrap()`
  re-asserts the REST/admin keys so the panel↔game link cannot break.
- **Caching:** `index.html` is `Cache-Control: no-store`; `/assets/*` is `immutable` (Vite hashes filenames).
- **Static asset + SPA-fallback routes sit ABOVE the auth gate** (public; `<script>` requests carry no bearer).
  Never move an `/api/*` route above that gate. A missing file must 404, not 401 (401 pops a browser credential prompt).
- **Never derive the API base from `location.pathname`** (SPA fallback makes it the route). Use `VITE_API_BASE`
  (empty for the Cloud Run root).
- **Self-update restart can be flaky:** a fresh VM boot reliably fetches the latest agent; else
  `systemctl restart palworld-panel` or reboot.
- **Mods:** native `.pak`/LogicMods always; UE4SS script mods need `var.runtime_mode = "proton"` (metadata change,
  reboot) or installs return 409.
- **Cost:** VM auto-powers-off when empty; fixed floor = static IP + disks. No load balancer anywhere (adds a fixed
  hourly charge above the floor).
- **Two log sources:** `GET /api/logs` tails the game's Unreal logs (agent, VM must be up). `GET /api/vm/serial?start=N`
  is coordinator-owned and returns the VM serial console, the only way to see a boot (the agent has no `journalctl`
  and isn't running yet). Needs `compute.instances.getSerialPortOutput` on the coordinator's custom role. Tail by
  feeding the previous `next` back as `start`; the GCP buffer is a ring, so a larger returned `start` means output
  aged out. A non-RUNNING VM answers `ok:true, available:false` (a state, not an error). Output passes `_redact()`.
- **Host metrics + logs:** `GET /api/metrics/host` parses `/proc`; `GET /api/logs` uses a byte cursor (both `view`).
  Deliberately no `psutil`/`journalctl`: the venv has only fastapi+uvicorn and the sudoers drop-in allows exactly nine
  `systemctl` commands, so either would force a `startup.sh` edit. Unavailable readings return `null`, never `0`.
- **Save import is chunked:** Cloud Run rejects bodies over 32 MiB, so `POST /api/saves/upload` opens a session and
  the browser sends ordered `.../upload/<id>/part?index=N` slices (`UPLOAD_PART_MAX_BYTES`, 24 MiB), appended by the
  agent until `.../finish`. Parts must arrive in order; a failed part truncates to the last good offset. Extract
  member-by-member with traversal/symlink rejection and a size cap (`SAVE_MAX_BYTES`), never `tar xzf` on untrusted
  input. An import always lands as a NEW slot.
- **steamcmd lies about failure.** `+app_update` exits 0 on a failed update; only output says
  `Error! App '2394010' state is 0x6 after update job.` The first run after its self-update is flaky (`startup.sh`
  retries 5×). An install succeeds only if the appmanifest buildid became the wanted build AND no `state is 0x…` line
  printed; `_install_latest()` checks both. Plain retries don't help, so attempts escalate via `_UPDATE_STRATEGIES`:
  plain → `+app_info_update 1` → clear `appcache/appinfo.vdf` → clear `steamapps/downloading/<appid>`. Failures carry
  the tail of `logs/content_log.txt`, the only place the real cause is written.
- **Downloads are anonymous and rate-limited** per account/IP. `Access Denied` on a manifest request code
  (`content_log.txt`) strands the server on an old build; `_install_latest()` detects it and sets a persisted cooldown
  (`update_cooldown()`) instead of retrying. A Steam sign-in path was built then removed on request (git history:
  "optional Steam account sign-in"). `download_depot` stages under `STEAMCMD_HOME` on the data disk (it ignores
  `force_install_dir`; default HOME is the small boot disk); cleanup deletes only `steamapps/content`.
- **Game version is agent-owned:** policy + build history in `palworld-update.json` on the data disk, wanted build per
  save in slot metadata (`version: {mode, buildid}`); `reconcile_version()` is the single entry point (boot via
  `panel.py game-sync`, start-up thread, save activate/restore, interval, `POST /api/update/apply`). Installing stops
  the game, so it refuses while players are online unless forced. **Pinning only works for builds this server has
  observed** (Steam won't serve old manifest ids); a pinned install does NOT update the `.acf`, so the agent's own
  `installed` marker wins for `method: "pinned"`. `/api/update*` is gated view/settings; `/api/saves/{guid}/version`
  is gated `saves`.
- **Discord bot:** `POST /api/discord/interactions` is handled BEFORE the auth gate, authenticated by Ed25519
  signature (`DISCORD_PUBLIC_KEY`; empty = 404). Roles map to the same perm set and flow through `_rbac_headers()`.
  Answer within ~3s or Discord drops it (parallel agent calls, 2.5s timeouts, no deferred path). A new command means
  editing BOTH `COMMANDS` and `COMMAND_DEFS`, then re-running `scripts/discord_register.py`. See `docs/DISCORD.md`.

## Conventions

- Match surrounding style. Coordinator/agent responses use a `{ ok, error, ... }` envelope (Palworld REST
  passthrough is the exception). Frontend strings live in `frontend/src/i18n/en.ts`.
- Prefer editing in place; keep `panel.py` a single file (the boot fetch copies named files).

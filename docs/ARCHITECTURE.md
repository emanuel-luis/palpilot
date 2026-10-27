# PalPilot — Architecture

PalPilot is a two-tier control plane for an on-demand Palworld dedicated server on Google Cloud: a small,
always-on **coordinator** (serverless) and a **VM-side agent** (the "panel") that runs next to the game. The
expensive VM only runs while players are online; everything else is cheap or free.

The diagrams are written in [D2](https://d2lang.com) under [`diagrams/`](diagrams/) and rendered to SVG; edit the
`.d2` source and run `make diagrams` (see the README's Development section).

---

## 1. System components

![Architecture: players reach the game through the static IP and the UDP 8211 firewall rule, or start the server from Discord; admins use the console on the Cloud Run coordinator, which powers the VM through the Compute Engine API, keeps users, roles and the watchdog config in the panel bucket, and proxies signed requests to the agent on port 8080, a rule open to 0.0.0.0/0 by default; on the VM, startup.sh fetches the agent code and secrets, the watchdog asks the coordinator to stop an empty VM, and the agent and a cron job write backups and the stats history to the backups bucket](diagrams/architecture.svg)

Source: [architecture.d2](diagrams/architecture.d2).

- **Coordinator** — hosts the console, authenticates users, owns users/roles/watchdog state, starts/stops the VM,
  and proxies permission-checked requests to the agent. Scales to zero when idle. A gen2 Cloud Function with the
  same code is still declared in `coordinator.tf` as a transitional shim; it also calls the agent on the
  external IP, and removing it is step 5 of the panel-port fix in [`SECURITY.md`](SECURITY.md).
- **Agent (panel)** — does the file-level work on the VM: edit `PalWorldSettings.ini`, manage save slots and mods,
  take/restore backups, and proxy the Palworld REST API. Reached through the coordinator's signed proxy, on a
  port the firewall leaves open to `0.0.0.0/0` by default: that risk and its fix are in
  [`SECURITY.md`](SECURITY.md).
- **Persistent data disk** — worlds, mods, and per-slot settings; survives every power cycle and VM recreate.
- **Not drawn:** the SSH rule (`palworld-ssh-restricted`, TCP 22 from Google's IAP range only), the Cloud
  Monitoring uptime check and alert on the coordinator, and the deploy identity (Workload Identity Federation,
  Artifact Registry), which is in [section 6](#6-deployment-paths).

---

## 2. Authentication & request flow

Login is HTTP Basic once; the coordinator then issues a signed, expiring **session token** the browser carries as
a Bearer header. When proxying to the agent, the coordinator signs the acting user's identity + permissions so the
agent can enforce the same permission model — the agent never trusts a raw shared credential from the open port.

![Sequence of an admin action: the admin signs in once and gets an HMAC-signed session token; a request to activate a save slot is checked by the coordinator (token signature, expiry and version, live permissions, the saves permission, 403 when missing), which checks the VM is running and proxies it with signed X-Coord headers; the agent verifies the signature and the permission, stops the game, backs up the outgoing world to the data disk and the backups bucket, swaps the settings, reconciles the game build and starts the game](diagrams/user-flows-admin-action.svg)

Source: [user-flows-admin-action.d2](diagrams/user-flows-admin-action.d2).

- **Session token** — `base64url(header).base64url(payload).hex(HMAC-SHA256(...))`, hand-rolled (no JWT dep),
  signed with a shared secret. A per-user `ver` counter allows "sign out everywhere" and password-change invalidation.
- **RBAC propagation** — the `X-Coord-*` headers are a *separate* signed construction; the agent verifies them and
  enforces the granular permission for each endpoint, expanding any legacy coarse permission for safety.

---

## 3. Permissions & roles

Granular, per-feature permissions; roles are named bundles you assign to users. The built-in roles
(`BUILTIN_ROLES` in `coordinator/main.py`; their permissions stay editable):

| Role | view | power | saves | mods | settings | watchdog | commands | users |
|---|---|---|---|---|---|---|---|---|
| owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| operator | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| moderator | ✓ | | | | | | ✓ | |
| viewer | ✓ | | | | | | | |

A user carries one of these roles, or `custom` with an explicit permission list. Effective permissions resolve in
one place: a user's role supplies the baseline; a `custom` role uses the user's own permission list. The
coordinator route table, the agent's per-endpoint checks, and the console's UI gating all key off the same
permission names.

---

## 4. Save slots & per-save settings

Each save slot is a world folder; the active one is selected by a pointer in `GameUserSettings.ini`. **Settings and
mods belong to the save, not the server** — each slot carries its own `PalWorldSettings.ini`, swapped into the live
config when the slot is activated.

![Save slots on the data disk: GameUserSettings.ini names the active world folder under SaveGames/0, palworld-slots.json holds each slot's name and version pin, each slot's own ini in palworld-slot-configs is applied to the live PalWorldSettings.ini on activate and snapshotted back on edit and on switch, and world backups go to SaveGames/0/_slot_backups and to slots/ in the backups bucket](diagrams/save-slots.svg)

Source: [save-slots.d2](diagrams/save-slots.d2).

**Activate a slot:** stop → back up current world → snapshot current settings to the outgoing slot → switch the
pointer → apply the target slot's settings → re-assert REST/admin keys (so the panel↔game link never breaks) →
reconcile the game build the incoming save wants → start. Clone copies the settings, the mods **and** the version
pin with the world; delete removes them.

---

## 4b. Game version (auto-update + per-save pinning)

The game binaries only ever changed when `steamcmd` ran, and it only ran when the data disk had no PalServer on it —
so a long-lived VM silently fell behind upstream releases. The agent now owns the version:

- **Policy** (`palworld-update.json`, on the data disk): `auto_update` — on by default.
- **Wanted build per save** (in the slot metadata): `latest` (default) or `pinned` to a buildid.
- **Reconcile** — install whatever the *active* save wants. Runs at boot (`panel.py game-sync`, before the game
  starts, plus the panel's own start-up pass), on a save switch/restore and on an interval
  (`UPDATE_CHECK_SECONDS`). Declines while players are connected unless forced, because installing means
  stopping the game; the active world is backed up first (`pre-update`).
- **Console update** — `POST /api/update/apply` installs an explicit target (`latest` or a buildid) through
  `apply_update` directly, without the reconcile checks; it is refused while players are connected unless forced.

![Flowchart of reconcile_version: a trigger (boot, agent start-up, save activate or restore, every 3 hours) resolves the build the active save wants; the agent skips when the save follows latest with auto-update off, Steam asked it to cool down and the run is not forced, the target is unknown, or a pinned build has no recorded manifests; it does nothing when the installed build already matches; with players online and no force it skips as pending until the next trigger; otherwise apply_update stops the game, backs it up, installs through steamcmd, verifies the build and starts the game. The console's update button goes straight to apply_update with an explicit target](diagrams/version-reconcile.svg)

Source: [version-reconcile.d2](diagrams/version-reconcile.d2).

**Why pinning is limited to observed builds.** `steamcmd` installs either the current public build (`app_update`) or
an exact set of depot manifests (`download_depot`); Steam does not serve manifest ids for old builds. So the agent
records each build's manifests whenever it sees them (every check, every install, plus the installed build is always
readable from `appmanifest_<app>.acf`) and only those builds can be pinned/reinstalled — pinning "the build running
right now", the freeze-this-playthrough case, therefore always works. A pinned install writes files without
updating Steam's `.acf`, so the agent keeps its own `installed` marker as the authority.

---

## 5. Server lifecycle (cost control)

The VM is off by default. A player (or an admin) powers it on from Discord or the console, and the boot script
fetches the agent and brings the game up:

![Sequence of a start: the player runs /palworld start in Discord; the coordinator checks the Ed25519 signature, the guild and the caller's roles, reads the VM status and calls instances.start, then replies within 3 seconds with the address; from the console the same start is POST /api/vm/start, with the console polling the status and the boot log; the VM runs startup.sh, mounts the data disk, reads the secrets, copies the agent code from the panel bucket, runs game-sync and restarts the three services; the player joins on the static IP, UDP 8211](diagrams/user-flows-start-server.svg)

Source: [user-flows-start-server.d2](diagrams/user-flows-start-server.d2).

The watchdog polls the player count on the VM; when the server has been empty past the grace period it asks the
coordinator to power the VM off. Worlds/mods persist on the data disk for the next boot.

![Sequence of the idle shutdown: the watchdog starts at boot with the empty timer running; every poll it reads its poll and grace seconds from the coordinator, which caches watchdog.json from the panel bucket, and asks the game's REST API for the player count; players online clear the timer, an unreachable API leaves it unchanged, no players let it run; after the whole grace period it calls POST /api/vm/stop with the internal token, the coordinator stops the instance and writes an audit line, and the watchdog exits](diagrams/user-flows-idle-shutdown.svg)

Source: [user-flows-idle-shutdown.d2](diagrams/user-flows-idle-shutdown.d2).

---

## 6. Deployment paths

Different parts ship differently — deliberately, so day-to-day changes never touch the live VM.

![Deployment paths: a push to main that touches coordinator/, frontend/ or panel/ runs deploy.yml, whose ci job must pass and whose deploy jobs also need DEPLOY_ENABLED set (unset today, so they are skipped); deploy-coordinator authenticates through Workload Identity Federation and runs gcloud run deploy --source, which builds the image with Cloud Build into Artifact Registry for a new Cloud Run revision; deploy-panel copies the agent code to the panel bucket, which the VM fetches on its next boot; every other path only runs checks (ci.yml, diagrams.yml, analytics.yml); the owner applies *.tf and startup.sh changes with terraform by hand in a maintenance window](diagrams/deployment.svg)

Source: [deployment.d2](diagrams/deployment.d2).

- **Coordinator + console** → redeploy the Cloud Run service (zero downtime). GitHub Actions does this on push
  once `DEPLOY_ENABLED` is set; it is paused while the project is offline ([`CICD.md`](CICD.md)).
- **Agent** → push to the panel bucket; the VM fetches it on next boot (or self-update). No live restart from CI.
- **Infra** → `terraform apply`. Editing `startup.sh` forces a VM recreate, so it's a planned, maintenance-window
  action; the persistent data disk is preserved across the recreate.
- **Everything else** (docs, diagrams, analytics) runs checks only; no deploy job starts.

See **[`CICD.md`](CICD.md)** for the automated pipeline, and [`../analytics/README.md`](../analytics/README.md) for
the usage and cost data flow.

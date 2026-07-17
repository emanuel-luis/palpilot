# Palworld Control Plane — Modernization & Refactor Plan

> **Status:** proposal / high-level architecture. No code in this document.
> **Scope:** source-code refactor, feature re-architecture, and UI/UX modernization
> of the `palworld-terraform` control plane.
> **Audience:** the operator (single/few-admin hobby deployment) and the implementing agents.
> **Golden rule:** this is a **live production server with real, connected players**.
> Every change is classified by its deployment blast radius (see §9). Nothing that
> interrupts active sessions ships outside a planned maintenance window.

---

## 1. Executive Summary

The system is **architecturally sound for its scale** and does *not* need a redesign.
Five independent reviewers converged on the same conclusion: keep the two-tier split
(always-on serverless coordinator + ephemeral root-capable VM agent), keep GCS-JSON as
the datastore, keep HTTP Basic Auth, keep the single-file Vue UI. The work is
**remediation and polish, not re-platforming.**

The real center of gravity is the **VM agent's independently internet-facing port**:
four of five dimensions point at it from different angles (no RBAC of its own, plaintext
public HTTP on a root process, a stored XSS in the legacy UI it serves, an ungated
self-update endpoint). Closing that one surface collapses most of the risk at once.

Highest-impact items, in order:

1. **Secrets hygiene (operator action, urgent):** `terraform.tfstate`, `terraform.tfstate.backup`,
   and `terraform.tfvars` hold live plaintext secrets inside a **OneDrive-synced** path — an
   active, ongoing leak. Rotate credentials and get state out of cloud sync.
2. **Close the public panel port** and route all admin traffic through the coordinator's
   HTTPS endpoint. One firewall change neutralizes the RBAC-bypass, the plaintext-credential
   exposure, the ungated self-update, and the legacy-UI XSS in a single stroke.
3. **Fix the confirmed stored XSS** in `panel/index.html` (defense in depth; retire the file).
4. **Add a restore capability** — the system takes backups everywhere but cannot restore
   through the UI. That is the biggest *functional* gap for a live server.
5. Batch **root-privilege reduction** + **Secret Manager** migration into one planned VM recreate.
6. **Write atomicity** (temp-file + `os.replace`, GCS `if_generation_match`) everywhere.
7. Contain **`install_mod_url`** (size cap + host allowlist).
8. Fix the **INI-parser paren-depth bug** (silent config corruption) + add one parser test.

---

## 2. Current Architecture (As-Is)

```
                          ┌──────────────────────────────┐
     browser (admin)  ───▶ │  Coordinator (Cloud Function  │  always-on, HTTPS, public
     HTTP Basic over HTTPS │  gen2, functions_framework)   │  invoker (Basic Auth internal)
                          │  coordinator/main.py + Vue UI │
                          │  - start/stop VM              │
                          │  - users.json / watchdog.json │◀── GCS bucket (JSON "DB")
                          │  - proxy config/REST/saves/mods│
                          └───────────────┬───────────────┘
                                          │ HTTP Basic over PLAIN HTTP :8080
                                          │ (VM external IP, 0.0.0.0/0)   ⚠ public
                          ┌───────────────▼───────────────┐
     players (UDP 8211) ─▶│  Palworld VM (GCE, start/stop) │
                          │  panel.py  (FastAPI, ROOT)     │  ⚠ runs as root
                          │   - edit PalWorldSettings.ini  │
                          │   - save slots / mods (files)  │
                          │   - proxy Palworld REST (:8212)│  localhost only ✓
                          │   - self-update (gsutil+systemd)│ ⚠ ungated
                          │  idle_watchdog.py (ROOT)       │
                          │  palworld.service (steam user) │
                          │  data disk /home/steam/Steam   │  persistent ✓
                          └────────────────────────────────┘
```

**Deployment model (deliberate, must preserve):**
- Coordinator code → `terraform apply` redeploys the function.
- Panel code (`panel.py`, `index.html`, `idle_watchdog.py`) → GCS bucket with
  `ignore_changes=[source]`, hot-deployed via `gsutil` + self-update / boot-time fetch.
  **This exists to avoid the VM-recreate-on-every-change problem.**
- `startup.sh` writes the systemd units and secret-bootstrap. **Editing it forces a full VM recreate.**

**Data stores:** `users.json` + `watchdog.json` (GCS blobs), `palworld-slots.json` (VM disk),
and the filesystem itself (GUID world folders, `~mods/`) as the real source of truth for slots/mods.

---

## 3. Assessment Summary

| # | Dimension | Verdict |
|---|-----------|---------|
| 1 | Backend architecture & code quality | Good separation; real correctness gaps (parser, atomicity, error shapes); root over-scope |
| 2 | Security & secrets | Two criticals (OneDrive-synced state, public plaintext root panel); rest is small cheap fixes |
| 3 | Frontend / UI/UX / a11y | Right-sized Vue; one **critical XSS** in legacy UI; no a11y, no i18n seam, no light theme |
| 4 | Feature architecture & data model | **No restore**; 3 uncoordinated backup mechanisms; metadata/FS divergence; thin mod model |
| 5 | Infra / Terraform / deploy | VM-recreate footgun; local state; SA over-grant; no monitoring; no CI |

### Findings by severity

**CRITICAL**
- `C1` Live secrets in `terraform.tfstate`/`.backup`/`.tfvars` inside OneDrive-synced folder (active leak).
- `C2` Panel port public + plaintext HTTP + root process + no login throttle → "one guessed password = root".
- `C3` Stored XSS in `panel/index.html` (`innerHTML` of attacker-controlled Steam player names) → admin session/credential takeover.
- `C4` No restore path anywhere (backups exist; recovery is manual SSH only).

**HIGH**
- `H1` Panel port bypasses the coordinator's per-user RBAC (single shared credential, no RBAC on the agent).
- `H2` Three uncoordinated backup mechanisms; `_slot_backups` on the data disk grows unbounded.
- `H3` Two independently-maintained, drifted frontends (feature gap + duplicate maintenance + attack surface).
- `H4` No `<label for>`/input association anywhere → every input unusable to screen readers.

**MEDIUM**
- `M1` Mod upload fully buffered in RAM across both hops, no size cap.
- `M2` `install_mod_url` = authenticated SSRF + unbounded write (only `^https?://` checked).
- `M3` `_split_top_level` tracks quotes but not paren depth → silent `.ini` corruption on struct/array values.
- `M4` `STRING_KEYS` allowlist must track Palworld's schema forever; a miss writes an unquoted (⇒ empty) value.
- `M5` Read-modify-write races: GCS blobs (no `if_generation_match`) and local JSON, no atomicity.
- `M6` Non-atomic local file writes (ini, GameUserSettings.ini, slots metadata).
- `M7` Inconsistent error envelopes/status codes across and within both tiers.
- `M8` `panel.py` runs entirely as root (only `chown` + `systemctl` truly need it).
- `M9` Slot metadata vs. filesystem can diverge with no reconciliation.
- `M10` Toast (the only feedback channel) not `aria-live`; hardcoded pt-BR with no i18n seam.

**LOW**
- `L1` Hand-rolled coordinator routing; easy to forget a permission gate on a new route.
- `L2` No exception handling on the highest-stakes calls (`_inst.start/stop`); raw `str(e)` leaked to clients.
- `L3` Zero automated tests.
- `L4` `idle_watchdog.py` runs as root for no reason.
- `L5` Non-constant-time secret compares (`main.py`); PBKDF2 at 100k (< OWASP ~600k).
- `L6` Basic-auth token in `localStorage`; Vue CDN `<script>` has no SRI.
- `L7` No light theme; wide tables lack horizontal-scroll containers; no busy-state guard outside Saves/Mods; silent poll failures/401.
- `L8` REST allowlist duplicated conceptually across tiers.

### Gaps the reviewers surfaced (not in the original scope)
- Default-network **SSH rule (tcp:22 from 0.0.0.0/0)** is likely still open — a third public surface.
- Coordinator service account holds **`roles/compute.instanceAdmin.v1` at project scope** (over-grant).
- **No monitoring/alerting** — nobody is told if `palworld.service` crash-loops or a recreate fails to come back.
- **Self-update has no rollback / health check / version pin** — a bad `panel.py` bricks the agent until manual `gsutil`.

---

## 4. Hard Constraints (Must-Preserve)

1. **Editing `startup.sh` = full VM recreate.** Batch all such changes into one deliberate maintenance window.
2. **The persistent data disk (`/home/steam/Steam`) must survive any recreate.** It is the core safety property.
3. **Panel code stays hot-deployable** via `gsutil` + self-update / boot fetch (keep `ignore_changes=[source]`).
   Do **not** fold panel code back under `terraform apply`.
4. **Keep the coordinator/panel two-tier split** (billing-driven). Move fixes *within* tiers.
5. **Live players.** Any `palworld.service` restart, VM recreate, or network change = maintenance-window mindset.
6. **`tfstate`/`tfvars` never committed to git** (already gitignored). Do not weaken this; actively close the sync gap.
7. **Keep HTTP Basic Auth** as the mechanism; fix only the gaps around it (exposure, throttling, constant-time).
8. **Keep GCS-JSON** for users/watchdog/slots metadata; fix atomicity, don't add a DB.
9. **Keep the `view/power/config/commands/users` permission model**; extend it down to the agent, don't replace it.

---

## 5. Target Architecture (To-Be) — High Level

Same shape, tightened boundaries. The diagram below marks the deltas (★).

```
   browser ──HTTPS──▶ Coordinator (Cloud Function)
                      • one error envelope {ok,error,data} ★
                      • route table + @require(perm) decorator ★
                      • constant-time compares, login throttle ★
                      • if_generation_match on GCS writes ★
                      • backups/restore proxy routes ★
                      • scoped SA (instance, not project) ★
                          │
                          │ HTTPS-only path; panel port NOT public ★
                          │ (VPC connector / firewall to coordinator egress,
                          │  or signed short-lived token; see §9 open question)
                          ▼
                      Palworld VM
                      • panel.py runs as NON-root svc user ★
                        + tiny root helper / sudoers for chown+systemctl only ★
                      • atomic writes (temp+os.replace) ★
                      • INI parser paren-depth fixed + unit-tested ★
                      • install_mod_url: size cap + host allowlist ★
                      • mod upload: streamed, size-capped ★
                      • backups: one policy, retention pruning ★
                      • RESTORE endpoint ★
                      • idle_watchdog runs as non-root ★
                      • secrets from Secret Manager, not metadata ★
                      • legacy panel/index.html retired/redirect ★
```

### Code organization (within-tier refactor, no new services)

`panel.py` (826 lines) is split into a small package so domain logic is testable and the
HTTP layer is thin — **no framework change, still FastAPI**:

```
panel/
  app.py            # FastAPI wiring, auth dependency, route registration
  ini.py            # OptionSettings parse/format/set  (+ tests/test_ini.py)  ← highest-risk unit
  saves.py          # slot lifecycle: list/create/activate/backup/restore/delete + metadata GC
  mods.py           # list/upload(streamed)/url-install(capped+allowlist)/enable-disable/delete
  backups.py        # single backup policy: naming, local+GCS, retention pruning
  gus.py            # GameUserSettings.ini (active-world pointer)
  system.py         # privileged ops via the tiny root helper (chown, systemctl)
  fsutil.py         # atomic_write(), safe_name(), size guards
```

`coordinator/main.py` (353 lines) gets a **route table + `@require(perm)` decorator** and one
error envelope, but stays a single functions_framework entry point.

---

## 6. Feature Re-Architecture

### 6.1 Save slots
- **Filesystem is the single source of truth** for slot existence. `list_slots()` **garbage-collects**
  metadata whose GUID folder is gone (self-healing) instead of only ever adding entries.
- Slot record grows a small, stable schema (`{guid, name, created, last_backup, schema_version}`) with
  a `schema_version` field so future format changes are migratable.

### 6.2 Backups + **Restore** (the headline feature)
- **One backup policy** in `backups.py`: one naming scheme, one retention count `N` (prune-on-write,
  both local and GCS), and a clear split between *operational* per-slot backups
  (pre-switch / pre-delete / manual) and *disaster-recovery* full-disk snapshots (cron).
- New capability: **list backups** (local dir + `gs://…/slots/`) and **restore** a chosen backup into
  its slot (or into a new slot), following the existing safe sequence: stop → snapshot-current → extract → chown → start.
- Retention: keep last `N` per slot; stop relying solely on the blanket 30-day GCS lifecycle
  (which currently treats a last-good pre-delete copy the same as a routine snapshot).

### 6.3 Mods
- Sidecar metadata file `{filename: {source_url, installed_at, enabled}}` (same pattern as slots).
- **Enable/disable = rename** (`.pak` ↔ `.pak.disabled`) instead of delete, so a suspect mod can be
  toggled off without losing its source URL. **No** dependency resolver / per-slot profiles / version
  pinning (over-engineering for experimental Linux mod support).

### 6.4 Authorization boundary (`H1`)
- Primary fix is the **firewall** (§9). Additionally, **propagate the acting user's permissions**
  from the coordinator to the agent (e.g. a signed header the agent verifies) so the agent enforces
  the same `view/power/config/commands/users` model instead of trusting any holder of the shared credential.

---

## 7. Interface / UI/UX Modernization

**Framework decision:** keep single-file **Vue 3**. No Vite/webpack/TS/component-library migration —
disproportionate for 7 tabs and a handful of admins. Improvements are markup/CSS/JS within the current file,
plus one internal refactor (extract the repeated config-field block into a script-defined sub-component).

1. **Language → English + i18n seam.** Extract every user-facing string (template text, `confirm()`,
   `notify()`, tab/permission labels) into a single plain `STRINGS` object keyed by stable ids. English
   becomes the default; a future locale is a data change, not a rewrite. `<html lang="en">`.
2. **Accessibility.** `label[for]`/`id` pairing on every input (loop-generated forms included);
   `role="status" aria-live="polite"` on the toast (`assertive` for errors); `role="alert"` on the login error;
   focus management on tab change.
3. **Feedback & safety.** Generalize the existing `savesBusy`/`modsBusy` pattern into the shared `api()`
   helper so **every** mutating action disables its button (no double-submit on start/stop, save, kick/ban, shutdown).
   A persistent banner when `/api/overview` polling fails repeatedly ("data may be stale"); a clear
   "session expired" message on 401-logout.
4. **Responsive.** Wrap wide tables (players/saves/users) in `overflow-x:auto` so only the table scrolls on mobile.
5. **Theming.** `@media (prefers-color-scheme: light)` variable set + a manual toggle (low priority; cheap).
6. **Security polish.** SRI `integrity` + `crossorigin` on the Vue CDN tag (or self-host the vendored file).
7. **New UI surfaces:** a **Backups/Restore** panel in the Saves tab (list + restore + download), and
   **enable/disable** toggles + source-URL display in the Mods tab.
8. **Retire `panel/index.html`:** replace with a minimal page that redirects to / points at the coordinator UI
   (kills the XSS and the duplicate-maintenance drift). If a break-glass UI is wanted, strip it to
   status + emergency-stop + self-update only, and escape all interpolated data.

---

## 8. Cross-Cutting Engineering

- **Write atomicity everywhere:** `temp-file + os.replace` for local files; `if_generation_match=blob.generation`
  on GCS writes with a 409-retry-on-conflict. One technique, applied in all ~6 spots at once.
- **One error envelope** end-to-end: `{ "ok": bool, "error": str|null, ...data }`, with domain reasons mapped
  to real status codes (400 validation / 404 not-found / 409 conflict) instead of collapsing to 400.
- **INI parser correctness (`M3`,`M4`):** track paren depth in `_split_top_level`; invert the quoting default
  (quote unless known numeric/bool/enum, so a missed schema entry fails safe). Add `tests/test_ini.py`
  round-trip (parse→mutate→serialize→parse is stable) — the single highest-value test.
- **Root reduction (`M8`,`L4`):** run `panel.py` and `idle_watchdog.py` as a non-root service user; grant a
  narrow sudoers allowlist (or a tiny root helper) for just `chown` + `systemctl`. (Requires a `startup.sh`
  edit → batch into the one maintenance-window recreate.)
- **Hardening (`L5`):** `hmac.compare_digest` for the two `==`/`!=` secret compares; bump PBKDF2 to ~300–600k
  (re-hash on next successful login). In-memory sliding-window login throttle in both auth paths.
- **Observability (`L2` + gap):** wrap `_inst.start/stop`; replace raw `str(e)` bodies with a static message +
  `print()` to stdout (Cloud Logging captures it for free). Add a minimal Cloud Monitoring uptime check /
  alert policy for `palworld.service` liveness.
- **Self-update safety (gap):** health-check the freshly-fetched `panel.py` before committing the restart;
  keep the previous version for one-step manual revert.

---

## 9. Deployment Classification (what ships how)

| Class | Mechanism | Player impact | Items |
|-------|-----------|---------------|-------|
| **A · Operator-only** | manual / gcloud | none (or credential rotation) | `C1` rotate secrets, move state off OneDrive → GCS backend; close default SSH rule |
| **B · Terraform apply** | `terraform apply` (no VM change) | none | firewall change (`C2`/`H1`), scope coordinator SA, monitoring/alerts, coordinator code redeploy |
| **C · Hot-deploy (panel)** | `gsutil` + self-update | none (agent restart only, game untouched) | all `panel.py`/`coordinator`/`index.html` code fixes, restore feature, UI modernization, XSS retire |
| **D · VM recreate (batched)** | `startup.sh` edit + planned window | **disconnects players** | root reduction, Secret Manager migration, non-root systemd units |

> **Open design question (Class B):** the coordinator is serverless, so restricting the panel port to
> "the coordinator's egress" needs either a **Serverless VPC connector + NAT egress range** or a
> **signed short-lived token** the agent verifies (keeping the port closed to general internet via firewall +
> a deny-by-default rule). Decide this before implementing the firewall change; the token approach avoids
> new networking infra and is likely the right-sized answer.

---

## 10. Phased Roadmap

Each phase is an independently shippable, mostly non-disruptive increment. Ordered by leverage.

### Phase 0 — Stop the bleeding (Operator, urgent) · Class A
- Rotate `panel_password`, `admin_password`, `internal_token`.
- Move the working tree out of OneDrive **or** migrate Terraform state to the GCS backend already owned;
  exclude `tfstate*`/`tfvars` from sync. Confirm `terraform.tfstate.backup` is handled too.
- Verify/close the default `tcp:22` public SSH rule.

### Phase 1 — Close the surface · Class B (+ small Class C)
- Decide the panel-port access model (token vs VPC connector), then **close the public panel firewall rule**.
- Route the UI's direct-to-VM calls (self-update) through the coordinator or the chosen closed path.
- **Retire `panel/index.html`** (kills XSS `C3`) — Class C.
- Scope the coordinator SA to the instance; add a monitoring uptime check/alert.

### Phase 2 — Correctness & data-integrity · Class C (hot-deploy, non-disruptive)
- Atomic writes + GCS `if_generation_match` (`M5`,`M6`).
- INI parser paren-depth fix + inverted quoting + `test_ini.py` (`M3`,`M4`,`L3`).
- `install_mod_url` size cap + host allowlist; streamed size-capped upload (`M1`,`M2`).
- Slot metadata GC (`M9`); one backup policy + retention pruning (`H2`).
- One error envelope + status codes (`M7`); wrap start/stop, add logging (`L2`).
- Constant-time compares, PBKDF2 bump, login throttle (`L5`).

### Phase 3 — The restore feature + UI/UX modernization · Class C
- Backend restore endpoint + backups listing (`C4`).
- Coordinator: backups/restore proxy routes; route table + `@require` decorator (`L1`).
- Frontend: English + `STRINGS` seam; a11y (labels, aria-live); busy-state generalization; table scroll;
  SRI; error/stale + session-expired banners; **Backups/Restore UI**; **Mods enable/disable + metadata UI**;
  light-theme (optional).

### Phase 4 — Least privilege (batched recreate) · Class D (maintenance window)
- Non-root `panel.py` + `idle_watchdog.py` (sudoers/helper for chown+systemctl).
- Secret Manager migration (secrets out of instance metadata).
- Self-update health-check + one-step revert.
- Do all `startup.sh` edits in **one** planned recreate; announce a window; verify the data disk re-attaches and the world boots.

---

## 11. Non-Goals (Over-Engineering Boundary)

Explicitly **out of scope** — five independent reviewers agreed these do not fit a small live hobby server:

- No database (Cloud SQL/Firestore), no distributed locking, no message queues.
- No microservices / multiple Cloud Functions / framework migration off functions_framework or FastAPI.
- No mTLS, no OAuth/OIDC replacement of Basic Auth, no private-VPC/VPN redesign.
- No full mod-manager (dependency resolution, per-slot profiles, semver pinning).
- No `vue-i18n` / Vite / webpack / TypeScript / component-library migration; no formal WCAG audit suite.
- No broad CI test matrix / end-to-end GCE/GCS mocking before the first unit test exists.
- No enterprise secret rotation program / HSM; no sandboxed per-capability process split.
- No replacing native `confirm()` with a modal framework; theming stays optional.

---

## 12. Implementation Dispatch (how the Sonnet agents build it)

The code work (Classes B/C, and the Class-D *code* that doesn't apply until a window) is implemented by
**Claude Sonnet subagents on a feature branch — nothing is deployed.**
Deploy/apply/recreate remain operator-gated per §9.

> **Implementation revision (adopted):** `panel.py` stays a **single file**, not the package split
> sketched in §5. Splitting it would change the boot-time fetch contract in `startup.sh` (which copies
> three named files: `panel.py`, `index.html`, `idle_watchdog.py`) and complicate the hot-deploy path
> that must be preserved (constraint #3). This also matches the reviewers' guidance to apply *targeted
> fixes, not restructuring*. All backend improvements are made in place, keeping the file well-sectioned.
> To keep parallel agents conflict-free, work is grouped by disjoint file-set rather than by the six
> logical packages: one agent per top-level file/area.

Work packages (parallel where independent, then integrated + reviewed):

1. **`panel` package split + `fsutil`/`ini`/`gus`** (foundation; atomicity + parser fix + tests).
2. **`saves` + `backups` + restore endpoint** (depends on 1).
3. **`mods` hardening + metadata/enable-disable** (depends on 1).
4. **`coordinator/main.py`** error envelope, route table/decorator, restore/backups proxy, throttle, constant-time, PBKDF2 (independent).
5. **`coordinator/index.html`** English/i18n seam, a11y, busy-state, tables, SRI, banners, Restore + Mods UI (independent, integrates with 4).
6. **`panel/index.html` retirement** + **Terraform** (SA scope, monitoring, firewall/token design doc) — *code only, not applied*.

Each package is verified in-tree (Python syntax + `test_ini.py`; HTML/JS sanity) before integration.
A final reviewer pass checks the diff against this plan and the must-preserve constraints (§4).

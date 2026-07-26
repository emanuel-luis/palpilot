# PalPilot console — build plan

This is a large spec (three screens, ~10 domain areas, mock backend, custom design system). Before I write ~40 files, here's how I'll approach it and one stack decision to flag.

## Stack note (important)

The spec pins **React 18 + Vite + `vite-plugin-singlefile` + hash routing**, targeting the coordinator's single-file `index.html` build. This Lovable project is **TanStack Start** (SSR, file routing). I will NOT rewire the build — that would break the Lovable preview and isn't needed to demonstrate the app.

Instead I'll:
- Put the entire console inside `src/routes/index.tsx` as a **client-only SPA** (rendered under `<ClientOnly>`).
- Use an internal **hash router** (`#/console`, `#/users`, `#/account`) exactly as the spec requires — so the client code is portable to the target repo unchanged.
- API base derived from `location.pathname` per spec.
- Mock mode forced ON in the Lovable preview (no backend here).
- When the user ports this to `frontend/` in their PalPilot repo, they swap the Vite/entry shell; every file under `src/palpilot/**` moves verbatim.

I'll isolate all app code under `src/palpilot/` so the port is a clean copy.

## Design thesis

**Concept — Instrument panel for a pastoral machine.** Two visual registers held in tension: the *industrial* (monospace readouts, tabular figures, thin rules, a hard status LED) and the *pastoral* (warm off-white paper tone, muted moss/clay accents, soft-edged cards). The console reads like the dashboard of a small piece of farm equipment, not a SaaS dashboard.

**Palette** (light / dark):
- `--paper` #F5F1E8 / #14140F — background
- `--ink` #1A1A17 / #EDE7D6 — foreground
- `--rule` #D9D3C2 / #2A2822 — borders
- `--moss` #4F6B3A / #8FB06A — primary (running / go)
- `--clay` #B4552A / #D97A4A — destructive / alert
- `--brass` #B8933A / #D4B15A — warning / starting
- `--slate` #6E7378 / #A0A6AC — muted

**Type:**
- Display: **Fraunces** (variable, self-hosted, one weight axis) — for hero numbers and section headers. If size budget is tight I'll drop to system serif (`ui-serif, Georgia`) — thesis holds either way.
- Body: system UI stack (`-apple-system, "Segoe UI", …`).
- Mono: `ui-monospace, "SF Mono", "JetBrains Mono", Menlo` with `font-variant-numeric: tabular-nums` globally on `.mono`, all metrics, all IDs.

**Signature element:** the **Power Console** — a physical-feeling module on the home hero. A large circular power button with a status LED ring that pulses during `starting` (respecting reduced-motion). Below it, three instrument-style readouts (players / uptime / in-game day) rendered as monospace gauges with em-dash placeholders when off. This is where the 2–3 minute wait becomes legible: the ring fills over the expected boot time as a soft progress hint.

**Layout — primary screen (Console):**
```
┌─────────────────────────────────────────────────────────┐
│ HEADER   [VM● RUNNING] [Server● Online]     ☾  ▾acct   │
├──────────┬──────────────────────────────────────────────┤
│          │  ┌──────────────────────────────────────┐    │
│ Console  │  │  SERVER NAME                          │    │
│ · status │  │  ◉ POWER      players 3/16            │    │
│          │  │               uptime  02:14:33        │    │
│ Admin    │  │               day     47              │    │
│ · users  │  │  join  203.0.113.4:8211      [copy]   │    │
│ · account│  └──────────────────────────────────────┘    │
│          │  ▸ Players (3)                                │
│          │  ▸ Saves · Settings · Mods · Commands ·       │
│          │    Watchdog                                   │
└──────────┴──────────────────────────────────────────────┘
```

## Implementation phases

**Phase 1 — Foundation** (single response, ~15 files)
- `src/palpilot/lib/`: `api.ts` (base path, bearer, envelope, all 5 response shapes), `session.ts` (token decode, exp check), `format.ts`, `cn.ts`
- `src/palpilot/i18n/en.ts` — every string
- `src/palpilot/data/settingsMeta.ts` — starter set of ~20 keys (rest ported at integration)
- `src/palpilot/stores/session.ts` (zustand)
- `src/palpilot/hooks/` — query hooks
- `src/palpilot/mocks/` — full fixture set + latency + failure injection + dev state switcher hooks
- Theme system in `src/styles.css` (CSS vars, `[data-theme=light|dark]`, reduced-motion clamp)
- Router (hash-based) + shell + toast/confirm singletons
- Login screen

**Phase 2 — Console screen**
- StatusPills, PowerControl (the signature), JoinAddress, PlayersTable
- Saves section: SlotTable, BackupList, chunked UploadProgress with retry/cancel
- Settings: grouped/filterable editor, diff save, raw INI
- Mods: capability banner, install (upload/URL), enable/disable/delete, UE4SS gating
- Commands: announce, kick/ban/unban, save, restart, graceful shutdown, stop
- Watchdog: poll + grace(minutes) editor + live summary

**Phase 3 — Users & Account**
- User form, user table, roles table, role form, PermissionMatrix (8-perm grid)
- Custom-perm prefill from `effective_perms` (bug fix)
- Account: password change, sign-out-everywhere

**Phase 4 — Polish & verify**
- Contrast check both themes
- Keyboard traversal
- Dev state switcher (offline/starting/online, roles, in-flight import, stale, 503, 409)
- Head metadata

## Explicit deferrals

- **`vite-plugin-singlefile` / `outDir: "../coordinator"`** — not applied here (would break Lovable preview). Documented in a `src/palpilot/PORTING.md` for when they move the code.
- **Full 62-entry `settingsMeta`** — I'll ship ~20 representative entries covering all `ease` variants and enum keys; the rest is a mechanical port at integration time (already called out in their checklist step 3).
- **Fraunces font inlining** — I'll first ship with a system serif stack; if the user wants the inlined variable woff2 I'll add it (adds ~80 KB base64 and a build step consideration).

## Scope check

Ready to build all four phases across the next several turns. Each phase is one batched write of ~10-15 files. If you'd rather I split delivery differently (e.g. Console-only first, ship, then Users/Account), say so.

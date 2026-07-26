# Porting PalPilot v3 frontend into the coordinator

**What this is.** `frontend/` was rewritten from Vue 3 to React 18 + TypeScript in
this pass. Build output and coordinator wiring are unchanged: the single-file
`coordinator/index.html` is still overwritten in place, and the coordinator
Cloud Function serves it exactly as before.

## Build

```
cd frontend
npm ci
npm run build       # writes coordinator/index.html
```

## What changed vs. Vue

| Concern | Before (Vue) | Now (React) |
|---|---|---|
| Runtime | Vue 3 + Pinia + vue-i18n | React 18 + TanStack Query, tiny in-house session store, custom `t()` |
| Router | ad-hoc computed switch in App.vue | hash router (`#/console`, `#/users`, `#/account`) |
| UI kit | none | none — hand-built primitives on CSS variables |
| Design tokens | scattered | one CSS variable palette in `src/styles.css`, both themes |
| Auth | localStorage bearer | same key (`palpilot.token`) — sessions carry over |
| Build target | single-file HTML | same (`vite-plugin-singlefile`) |

The API contract, permission names, and localStorage token key are all
identical, so a client on the old build still authenticates against a new one.

## Deviations from the design brief the LLM was given

- **Tailwind CSS + shadcn were dropped.** They pull in ~200 KB of tooling and
  primitives that a single-file build has to inline; the same token discipline
  is achieved by CSS variables + hand-built primitives. Every component is
  explicitly restyled to the design system.
- **Font**: system serif for the display role (rather than an inlined Fraunces
  woff2). Adds zero KB and keeps the bundle small. If you want the branded
  serif, drop a base64-inlined variable woff2 into `src/assets/` and reference
  it via `@font-face` in `src/styles.css`.
- **State store**: a ~50-line in-file zustand-like store rather than the real
  zustand package. Zero dependency, identical shape.
- **~62-key `settingsMeta`**: the entire curated set from `settingsMeta.js` is
  ported to `src/data/settingsMeta.ts`. No new keys to add.

## Integration checklist (from the repo brief)

1. ✅ `vite.config.ts` — `outDir: "../coordinator"`, `emptyOutDir: false`,
   `viteSingleFile()`. Same behaviour as the Vue build.
2. ✅ API base derived from `location.pathname`.
3. ✅ `settingsMeta` ported (see `src/data/settingsMeta.ts`).
4. ✅ i18n strings ported to `src/i18n/en.ts`; new strings for the shell,
   commands and account routes are collocated.
5. ✅ Permission parity: all eight perms plus legacy `config` are handled.
6. **Delete Vue leftovers** after the React build is verified:
   ```
   rm frontend/src/App.vue frontend/src/api.js frontend/src/main.js \
      frontend/src/session.js frontend/src/settingsMeta.js
   rm -rf frontend/src/components frontend/src/stores frontend/src/views \
          frontend/src/i18n/en.js frontend/src/styles
   ```
   (kept as-is in this pass so you can diff / cherry-pick before removal.)
7. **Update `CLAUDE.md`**: replace the "Vite + Vue 3 SFC app" line and any
   Vue-specific references in the repo map.
8. Deploy path unchanged: rebuild the frontend, then redeploy the coordinator
   function. Zero downtime. No Terraform apply. No VM recreate.

## Dev mode

`npm run dev` boots Vite on :5173 with **mocks forced on** (see
`src/mocks/`). The dev switcher in the bottom-left lets you flip the mock VM
state (offline / starting / online / stopping), swap the current user's role,
inject a next-call `503 vm_offline`, and inject a 409 on the next upload part.
This is how the whole preview works without a running coordinator.

Set `VITE_MOCK=0` to talk to a real coordinator from `npm run dev`; the
production build never enables mocks.

# Decisions

Low-impact decisions taken during the 2026-10 refactor, plus the answers to escalated ones.
Newest last.

| # | Date | Decision | Choice | Why |
| --- | --- | --- | --- | --- |
| 1 | 2026-10-26 | Where refactor work happens | A git worktree per branch under `.claude/worktrees/` (already in `.git/info/exclude`) | The main checkout holds an uncommitted `CLAUDE.md` edit by the owner and the local Terraform state; switching its branch would put that edit on a feature branch. |
| 2 | 2026-10-26 | State backup before any Terraform command | Verified copies of `terraform.tfstate` and `.backup` in a local, gitignored `.state-backup/` (serial 289) | The state is local and holds secret values; one disk loss orphans every resource. |
| 3 | 2026-10-26 | Merge order while a merge to `main` is a deploy | PRs that touch only root files, `*.tf`, `docs/` or `.github/` go first (no deploy path); PRs that touch `coordinator/`, `frontend/` or `panel/` wait until a deploy is possible and are verified as no-op or smoke-tested first | `deploy.yml` fires only on those three paths. |
| 4 | 2026-10-26 | Deploys gated on CI | `deploy.yml` calls the reusable `ci.yml` and every deploy job `needs` it | The brief: deploy keeps running on `main` only after the PR checks pass. |
| 5 | 2026-10-26 | ci.yml triggers | Runs on pull_request, push to main with paths-ignore for coordinator/, frontend/, panel/, weekly schedule, workflow_dispatch and workflow_call. deploy.yml calls it first; both deploy jobs need it, keeping their existing if conditions. | Pushes that touch only deploy paths get CI once, through deploy.yml (mixed pushes run it twice, harmless), and a red check blocks the deploy. No workflow-level concurrency because the file is also called. |
| 6 | 2026-10-26 | IaC scanner | checkov 3.3.30 via uvx, pinned. No trivy or trivy-action. | Trivy action tags were hijacked in March 2026 (CVE-2026-33634). |
| 7 | 2026-10-26 | ruff scope | Rules E4, E7, E9, F, BLE selected explicitly; one per-file ignore of BLE001 for panel/panel.py. ruff format is enforced outside coordinator/ and panel/. | Defaults change between ruff releases. Formatting app code would touch deploy paths; the BLE001 is existing debt for an app-code PR. |
| 8 | 2026-10-26 | checkov findings | 16 existing findings recorded in the committed .checkov.baseline (generated on Linux so paths match CI); CI passes the baseline and fails only on new findings. | Fixing them needs semantic .tf changes, handled separately. Regenerate the baseline on Linux or WSL, not Windows. |
| 9 | 2026-10-26 | Node version in CI | Node 20 in ci.yml, same as deploy.yml. | Parity with deploy. Node 20 is EOL: bump both together later. |
| 10 | 2026-10-26 | tflint rules disabled | terraform_typed_variables is off (project_id, region, zone lack a type). | Adding type is a .tf edit, out of scope for the CI foundation. Follow-up. |
| 11 | 2026-10-26 | npm audit in security.yml | Deferred to the frontend tooling PR. | It reports a high zod advisory (GHSA-mrhx-c7xc-m3w5) today; the fix changes frontend/, a deploy path, so it ships with that PR instead of leaving a red check here. |
| 12 | 2026-10-26 | Provider lock platforms | .terraform.lock.hcl carries h1 hashes for linux_amd64, windows_386, windows_amd64 and darwin_arm64 (`terraform providers lock -platform=...`). | A lock written on Windows only held windows_386 hashes, so CI on Linux failed `validate` under `-lockfile=readonly`. Re-run the same command after any provider bump. |

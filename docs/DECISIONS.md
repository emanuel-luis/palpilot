# Decisions

Low-impact decisions taken during the 2026-10 refactor, plus the answers to escalated ones.
Newest last.

| # | Date | Decision | Choice | Why |
| --- | --- | --- | --- | --- |
| 1 | 2026-10-26 | Where refactor work happens | A git worktree per branch under `.claude/worktrees/` (already in `.git/info/exclude`) | The main checkout holds an uncommitted `CLAUDE.md` edit by the owner and the local Terraform state; switching its branch would put that edit on a feature branch. |
| 2 | 2026-10-26 | State backup before any Terraform command | Verified copies of `terraform.tfstate` and `.backup` in a local, gitignored `.state-backup/` (serial 289) | The state is local and holds secret values; one disk loss orphans every resource. |
| 3 | 2026-10-26 | Merge order while a merge to `main` is a deploy | PRs that touch only root files, `*.tf`, `docs/` or `.github/` go first (no deploy path); PRs that touch `coordinator/`, `frontend/` or `panel/` wait until a deploy is possible and are verified as no-op or smoke-tested first | `deploy.yml` fires only on those three paths. |
| 4 | 2026-10-26 | Deploys gated on CI | `deploy.yml` calls the reusable `ci.yml` and every deploy job `needs` it | The brief: deploy keeps running on `main` only after the PR checks pass. |

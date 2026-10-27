# CI/CD — auto-deploy on push

> **Deploys are paused.** The GCP project is offline by choice (billing disabled), so the deploy jobs
> are gated on the repository variable `DEPLOY_ENABLED`. While it is unset, a push to `main` runs the CI
> checks and skips both deploy jobs. To bring the server back, follow [`REVIVAL.md`](REVIVAL.md) and
> then set `DEPLOY_ENABLED=true` under Settings → Secrets and variables → Actions → Variables.

`.github/workflows/deploy.yml` deploys automatically when you push to `main`:

| Changed paths | Action | Player impact |
|---|---|---|
| `frontend/**` or `coordinator/**` | build the console + `gcloud run deploy palpilot-coordinator --source=coordinator` | none (serverless) |
| `panel/**` | push panel code to the panel bucket (fetched by the VM on next boot) | none (no live restart) |

**It never runs Terraform and never touches the VM** — so it can't recreate the machine or interrupt a live game.
Infra changes (`*.tf`, `startup.sh`) are still applied manually (`terraform apply`) in a maintenance window.

Keyless auth via **Workload Identity Federation** (no service-account JSON keys stored in GitHub).

---

## CI checks

`.github/workflows/ci.yml` runs on pull requests, on pushes to `main` that change at least one file outside the deploy paths, weekly, and by hand. Pushes that do touch `coordinator/`, `frontend/` or `panel/` get the same checks through `deploy.yml`, which calls `ci.yml` as its first job; both deploy jobs `needs` it, so a failed check blocks the deploy. A push that mixes deploy paths with other files runs the checks twice (once on its own, once through `deploy.yml`); that is harmless.

| Job | What it checks |
|---|---|
| `lint-python` | `ruff check` and `ruff format --check` (format skips `coordinator/` and `panel/`) |
| `terraform` | `fmt -check`, `init -backend=false` with the lock file read-only, `validate`, tflint, checkov against `.checkov.baseline` (only new findings fail) |
| `actionlint` | workflow syntax |
| `frontend` | `npm ci`, then `npm run lint` (ESLint 9), `npm run typecheck`, `npm test` (Vitest) and `npm run build` (includes `tsc -b`); uploads the build for the test job |
| `test-python` | `uv run pytest` over `coordinator/tests` and `panel/tests`, using that build |

`security.yml` runs weekly and on changes to the dependency files. `pip-audit` checks `coordinator/requirements.txt`; `npm-audit` runs `npm audit --omit=dev --audit-level=high` in `frontend/` (production dependencies only, so dev-tool advisories do not block). Run the same checks locally with `make lint`, `make test` and `make tf-check`; `make lint` and `make test` include the frontend lint, typecheck and tests.

## One-time setup

Replace the placeholders with your values: `<PROJECT_ID>` is the GCP project, `<PANEL_BUCKET>` is the panel bucket (`<PROJECT_ID>-palworld-panel`). Region `southamerica-east1`, repo `emanuel-luis/palpilot`.

```bash
PROJECT=<PROJECT_ID>
PNUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
REPO=emanuel-luis/palpilot
DEPLOYER=palpilot-deployer@$PROJECT.iam.gserviceaccount.com

# 1) Deployer service account
gcloud iam service-accounts create palpilot-deployer \
  --project="$PROJECT" --display-name="PalPilot CI deployer"

# 2) Roles it needs (Cloud Run source deploy + bucket push + deploy-as the runtime SA)
for R in roles/run.admin roles/cloudfunctions.developer roles/cloudbuild.builds.editor \
         roles/artifactregistry.writer roles/storage.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOYER" --role="$R"
done
# act as the coordinator's runtime SA
gcloud iam service-accounts add-iam-policy-binding \
  "palworld-coordinator@$PROJECT.iam.gserviceaccount.com" \
  --project="$PROJECT" --member="serviceAccount:$DEPLOYER" --role=roles/iam.serviceAccountUser

# act as the DEFAULT COMPUTE SA too — a source deploy builds via Cloud Build, which
# runs as this account. Without it the deploy dies with
#   "Caller is missing permission 'iam.serviceaccounts.actAs' on service account
#    <PNUM>-compute@developer.gserviceaccount.com"
# even though auth and every project-level role above succeeded.
gcloud iam service-accounts add-iam-policy-binding \
  "$PNUM-compute@developer.gserviceaccount.com" \
  --project="$PROJECT" --member="serviceAccount:$DEPLOYER" --role=roles/iam.serviceAccountUser

# 3) Workload Identity Federation pool + provider, locked to this repo
gcloud iam workload-identity-pools create github \
  --project="$PROJECT" --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --project="$PROJECT" --location=global --workload-identity-pool=github \
  --display-name="GitHub" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='$REPO'"

# 4) Let the repo impersonate the deployer SA
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --project="$PROJECT" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PNUM/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"

echo "GCP_WIF_PROVIDER=projects/$PNUM/locations/global/workloadIdentityPools/github/providers/github"
echo "GCP_DEPLOY_SA=$DEPLOYER"
```

### GitHub repo config
Secrets (`gh secret set NAME`) and variables (`gh variable set NAME`):

```bash
gh secret   set GCP_WIF_PROVIDER --repo emanuel-luis/palpilot --body "projects/$PNUM/locations/global/workloadIdentityPools/github/providers/github"
gh secret   set GCP_DEPLOY_SA    --repo emanuel-luis/palpilot --body "$DEPLOYER"
gh variable set GCP_PROJECT      --repo emanuel-luis/palpilot --body "<PROJECT_ID>"
gh variable set GCP_REGION       --repo emanuel-luis/palpilot --body "southamerica-east1"
gh variable set PANEL_BUCKET     --repo emanuel-luis/palpilot --body "<PANEL_BUCKET>"
```

---

## Notes
- Runtime **env vars/secrets and the runtime service account are preserved** across `gcloud run deploy`; the
  workflow re-asserts only the non-secret service config (memory/timeout/instances) so it stays deterministic.
- **Panel** changes take effect on the **next VM boot**. To apply immediately, start the VM (or use the panel
  self-update) — CI does not restart a live server.
- `workflow_dispatch` (the "Run workflow" button) forces both jobs regardless of changed paths, once
  `DEPLOY_ENABLED` is `true`; handy for a first smoke test after setup.
- Simpler alternative to WIF: a service-account JSON key in a `GCP_SA_KEY` secret + `credentials_json:` in the auth
  step. Not recommended (long-lived key), but supported by `google-github-actions/auth`.

---

## Container

The coordinator image (`coordinator/Dockerfile`) is built from source by `gcloud run deploy --source=coordinator`, and
the `container` job in `ci.yml` builds and smoke-tests the same Dockerfile on every change.

- **Non-root.** The runtime stage runs as a fixed UID (10001). CI fails if `id -u` is 0.
- **Hashed lock.** Dependencies install from `coordinator/requirements.lock` with `pip --require-hashes`, in a
  builder stage; only the venv is copied into the runtime image. Edit `coordinator/requirements.txt`, then run
  `make lock` and commit both. CI regenerates the lock and fails on any diff. The base image is pinned by tag and
  digest; bump them together.
- **Console asserted at build time.** `index.html` and `assets/` are build output (gitignored, produced by
  `npm run build`). The Dockerfile fails the build when they are absent, so an upload without the console can never
  become an image that serves a blank page.
- **Smoke.** CI runs the image with fake credentials and no GCP access, then checks `GET /` 200, the first
  `/assets/*.js` 200 and `GET /api/overview` 401, the same checks as the post-deploy smoke.
- **Upload set.** `coordinator/.gcloudignore` is explicit and does not include `.gitignore` (the built console is
  gitignored, and gcloud only reads a `.gitignore` inside the source directory). It excludes `tests/`, bytecode and
  the ignore files. After `make build`, list what would be uploaded with
  `gcloud meta list-files-for-upload coordinator` (read-only, local); it must show `index.html`, `assets/*`,
  `main.py`, `discord_bot.py`, `Dockerfile` and `requirements.*`.

## Analytics

`.github/workflows/analytics.yml` is separate from `ci.yml` so the main CI never installs dbt. It runs on pull requests and
pushes to main that touch `analytics/**`, `pyproject.toml`, `uv.lock`, `Makefile` or the workflow itself (plus manual dispatch):
ruff check and format check on `analytics/`, the analytics tests, then `make demo` (synthetic data, no GCP access, no
secrets). Locally: `make demo` and `make analytics-test` (the demo computes the window end with GNU `date`, so run it on Linux or WSL). Details in `analytics/README.md`.

## Diagrams

`.github/workflows/diagrams.yml` checks that the SVGs in `docs/diagrams/` match their D2 sources. It installs the
pinned D2 (v0.9.0, sha256 in the Makefile) with `make d2-install`, runs `make diagrams-check` and uploads the rendered
SVGs as the `diagrams` artifact (kept 7 days, also on failure). It runs on pull requests and pushes to `main` that touch
`docs/diagrams/**`, the `Makefile`, `.gitattributes` or the workflow itself, plus manual dispatch: the repo is private
and pays for Actions minutes, so the job stays off unrelated changes. `main` has no required status checks, so the path
filter cannot block a pull request. None of these paths is a deploy path, so a diagram change never starts `deploy.yml`.

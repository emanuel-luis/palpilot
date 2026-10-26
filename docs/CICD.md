# CI/CD — auto-deploy on push

`.github/workflows/deploy.yml` deploys automatically when you push to `main`:

| Changed paths | Action | Player impact |
|---|---|---|
| `frontend/**` or `coordinator/**` | build the single-file UI + `gcloud functions deploy palworld-coordinator` | none (serverless) |
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
| `frontend` | `npm ci` and `npm run build` (includes `tsc -b`); uploads the build for the test job |
| `test-python` | `uv run pytest` over `coordinator/tests` and `panel/tests`, using that build |

`security.yml` audits the coordinator's Python dependencies (pip-audit) weekly and on changes to `coordinator/requirements.txt`. Run the same checks locally with `make lint`, `make test` and `make tf-check`.

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

# 2) Roles it needs (gen2 function deploy + bucket push + deploy-as the runtime SA)
for R in roles/run.admin roles/cloudfunctions.developer roles/cloudbuild.builds.editor \
         roles/artifactregistry.writer roles/storage.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOYER" --role="$R"
done
# act as the coordinator's runtime SA
gcloud iam service-accounts add-iam-policy-binding \
  "palworld-coordinator@$PROJECT.iam.gserviceaccount.com" \
  --project="$PROJECT" --member="serviceAccount:$DEPLOYER" --role=roles/iam.serviceAccountUser

# act as the DEFAULT COMPUTE SA too — a gen2 deploy builds via Cloud Build, which
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
- Runtime **env vars/secrets and the runtime service account are preserved** across `gcloud functions deploy`; the
  workflow re-asserts only the non-secret service config (memory/timeout/instances) so it stays deterministic.
- **Panel** changes take effect on the **next VM boot**. To apply immediately, start the VM (or use the panel
  self-update) — CI does not restart a live server.
- `workflow_dispatch` (the "Run workflow" button) forces both jobs regardless of changed paths — handy for a first
  smoke test after setup.
- Simpler alternative to WIF: a service-account JSON key in a `GCP_SA_KEY` secret + `credentials_json:` in the auth
  step. Not recommended (long-lived key), but supported by `google-github-actions/auth`.

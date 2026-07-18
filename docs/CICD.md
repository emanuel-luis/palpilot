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

## One-time setup

Values for this project: `PROJECT=palworld-502616-e9`, `REGION=southamerica-east1`, repo `emanuel-luis/palpilot`.

```bash
PROJECT=palworld-502616-e9
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
gh variable set GCP_PROJECT      --repo emanuel-luis/palpilot --body "palworld-502616-e9"
gh variable set GCP_REGION       --repo emanuel-luis/palpilot --body "southamerica-east1"
gh variable set PANEL_BUCKET     --repo emanuel-luis/palpilot --body "palworld-502616-e9-palworld-panel"
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

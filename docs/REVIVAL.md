# Reviving PalPilot

PalPilot is offline by choice: billing is disabled on its GCP project, the deploy jobs are paused
(`DEPLOY_ENABLED` is unset), and the world data was not kept. This runbook brings the stack back in a
safe order. Run every command yourself and read each output before the next step.

While billing was off, Google may have deleted some or all resources ("some resources might be
deleted and might not be fully recoverable",
[Cloud Billing docs](https://docs.cloud.google.com/billing/docs/how-to/modify-project)). Expect to
recreate most of the infrastructure.

![Sequence of the revival runbook: the owner picks the project, links a billing account and takes a read-only inventory; creates a private, versioned state bucket and migrates the local Terraform state into it, checking serial and lineage; plans, reads every replacement, applies, and checks the VM's IAM policy after a replace; sets DEPLOY_ENABLED and runs the deploy workflow by hand, which deploys and smoke-tests; then hardens: Direct VPC egress to close port 8080, rotated passwords and token, no default-allow-ssh](diagrams/user-flows-revival.svg)

Source: [user-flows-revival.d2](diagrams/user-flows-revival.d2).

## 1. Pick the project

- **Same project:** keeps the project ID, the Workload Identity Federation setup and the repo
  variables. The local Terraform state (on the owner's machine, never in git) still describes the
  last apply, so the first plan will show recreations for whatever Google deleted.
- **New project:** a clean start. Skip the state migration in step 4 and start from an empty remote
  state; update `GCP_PROJECT`, `GCP_REGION`, `PANEL_BUCKET` and the WIF secrets in the repo.

## 2. Re-enable billing

Link an active billing account in the console (Billing → Account management → My projects), or:

```bash
gcloud billing projects link <PROJECT_ID> --billing-account=<BILLING_ACCOUNT_ID>
```

Stopped services can take up to 24 hours to come back, and some need a manual restart.

## 3. Inventory what survived (read-only)

```bash
gcloud compute instances list --project <PROJECT_ID>
gcloud compute disks list --project <PROJECT_ID>
gcloud compute addresses list --project <PROJECT_ID>
gcloud storage buckets list --project <PROJECT_ID>
gcloud run services list --project <PROJECT_ID>
```

## 4. Move the Terraform state to GCS before any apply

The local state holds plaintext secrets (instance metadata) and is a single point of failure.

```bash
# 4.1 Back up the local state and note its hash
cp terraform.tfstate terraform.tfstate.pre-migration.bak
sha256sum terraform.tfstate terraform.tfstate.pre-migration.bak

# 4.2 Versioned, private bucket for the state (same region as the stack)
gcloud storage buckets create gs://<PROJECT_ID>-tfstate --project=<PROJECT_ID> \
  --location=<REGION> --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://<PROJECT_ID>-tfstate --versioning

# 4.3 Opt in to the backend
cp backend.tf.example backend.tf
cp backend.hcl.example backend.hcl      # fill in the bucket name; backend.hcl is gitignored

# 4.4 Copy the state into the bucket (answer "yes" to the copy prompt)
terraform init -migrate-state -backend-config=backend.hcl

# 4.5 Serial and lineage must match before and after; then move the local copies out of the tree
python -c "import json; s=json.load(open('terraform.tfstate.pre-migration.bak')); print(s['serial'], s['lineage'])"
terraform state pull | python -c "import json,sys; s=json.load(sys.stdin); print(s['serial'], s['lineage'])"
```

For a new project, first move `terraform.tfstate*` out of the working tree (otherwise Terraform offers
to copy the old project's state, secrets included, into the new bucket; answer "no" if asked), then
run `terraform init -backend-config=backend.hcl` instead of 4.4 to start an empty remote state.
Commit `backend.tf` once the backend works.

## 5. Plan, read, apply

```bash
terraform plan -out=revival.tfplan     # *tfplan* is gitignored; it holds attribute values
```

Read every `must be replaced` line. A replaced `google_compute_instance.palworld` recreates the boot
disk; a recreated `google_compute_disk.palworld_data` starts with empty worlds. Then
`terraform apply revival.tfplan`.

After any VM replace, check that the coordinator can still power the VM (see `CLAUDE.md`):

```bash
gcloud compute instances get-iam-policy palworld-tf-vm --zone <ZONE> --project <PROJECT_ID>
```

An empty `{"etag": ...}` means the binding is gone; re-run `terraform apply`.

## 6. Re-enable deploys

1. Check the repo secrets `GCP_WIF_PROVIDER` and `GCP_DEPLOY_SA` and the variables `GCP_PROJECT`,
   `GCP_REGION`, `PANEL_BUCKET` (see [`CICD.md`](CICD.md)).
2. Set the repository variable `DEPLOY_ENABLED=true` (Settings → Secrets and variables → Actions →
   Variables).
3. Run the deploy workflow by hand (Actions → deploy → Run workflow) and watch its smoke test.

## 7. Hardening worth doing at revival

- Close the panel port to the internet with Direct VPC egress ([`SECURITY.md`](SECURITY.md)).
- Rotate the panel password, the admin password and the internal token. `enable_secret_manager`
  alone does not remove them from instance metadata or the state; see [`SECURITY.md`](SECURITY.md).
- Look for a legacy `default-allow-ssh` rule on the `default` network; Terraform does not manage it.

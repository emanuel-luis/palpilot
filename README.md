# PalPilot

**A cost-aware control plane for an on-demand Palworld dedicated server on Google Cloud.**

PalPilot runs your Palworld server on a GCE VM that **powers itself off when empty** and
back on from a web dashboard — so you pay for compute only while people are actually playing.
It adds a full admin panel on top: live status, in-game commands, a schema-aware settings editor,
**save-slot management with backups & restore**, and **mod installation** — all behind per-user
permissions.

> This is a **fresh start** for the idea: a re-architected, hardened, and modernized take on an
> earlier Terraform-based Palworld server. See **[Credits & Original Source](#credits--original-source)**.

---

## Why

A Palworld dedicated server on an always-on 4-vCPU VM costs roughly **$100/month**. Most of that
is burned while nobody is online. PalPilot keeps the server **off by default** and:

- **Coordinator** (always-on, serverless, cheap) hosts the dashboard and starts/stops the VM.
- An **idle watchdog** on the VM powers the machine off after it has been empty for a grace period.
- Players' worlds live on a **persistent data disk** that survives every power cycle and VM recreate.

You keep the convenience of a hosted server without the always-on bill.

---

## Features

- **On-demand power** — start/stop the VM from the browser; auto power-off when empty (configurable poll + grace).
- **Live status** — players online, metrics (FPS, uptime, in-game day), server info.
- **In-game commands** — announce, kick, ban/unban, save, graceful shutdown.
- **Settings editor** — schema-aware, searchable, grouped editor for `PalWorldSettings.ini`, plus a raw editor.
- **Save slots** — create, switch, and delete worlds; the active world is selected safely (stop → backup → switch → restart).
- **Backups & restore** — per-slot backups to the VM disk **and** Google Cloud Storage, with retention pruning and one-click restore.
- **Mods** — install `.pak` mods by upload or URL, enable/disable without deleting, with source metadata.
- **Users & permissions** — `view` / `power` / `config` / `commands` / `users` per account.

---

## Architecture

```
  Browser ──HTTPS──▶  Coordinator (Cloud Function, always-on)
                      • dashboard UI + user/permission model
                      • start/stop the VM
                      • signed proxy to the VM agent
                          │
                          ▼  (RBAC-signed requests)
                      Palworld VM (GCE, start/stop billing)
                      • agent: config / saves / mods / backups / restore
                      • idle watchdog: auto power-off when empty
                      • palworld.service  +  persistent data disk
```

- **Two tiers on purpose:** the always-on control plane is tiny and serverless; the expensive VM only
  runs while players are on. State (users, watchdog config) lives in GCS JSON; worlds/mods live on the disk.
- **Hot-deployable agent:** the VM-side code is delivered from a GCS bucket, so most updates ship
  **without a Terraform apply or VM recreate**.

For the full design, assessment, security posture, and roadmap, see
**[`docs/MODERNIZATION_PLAN.md`](docs/MODERNIZATION_PLAN.md)**.

---

## Deploy

### Prerequisites
- A Google Cloud project (new accounts get $300 free credit).
- `terraform`, `gcloud`, and `gsutil` installed and authenticated.
- **Budget awareness:** roughly **$100/month** while running as configured (much less if the server sleeps often).

### Steps
1. Enable the Compute Engine API in the GCP Console.
2. Clone this repo and `cd` into it.
3. Copy the example vars to `terraform.tfvars` and set `project_id`, `region`, `zone`, and the
   passwords/token. **Never commit `terraform.tfvars` or `terraform.tfstate`** (both are gitignored).
4. `terraform init && terraform plan && terraform apply`.
5. Wait ~15 minutes for first provisioning; open the coordinator URL from `terraform output`.

> **Security note:** local Terraform state and `.tfvars` hold plaintext secrets. Keep the working
> tree **out of any cloud-synced folder** (e.g. OneDrive/Dropbox) or use a remote state backend, and
> rotate credentials if they may have been exposed. See `docs/MODERNIZATION_PLAN.md` §9–§10.

---

## Project status

PalPilot is under active modernization. Work is tracked in `docs/MODERNIZATION_PLAN.md`, which
classifies every change by deployment blast radius (operator-only / `terraform apply` /
hot-deploy / VM-recreate) because **this runs a live server with real players**.

---

## Credits & Original Source

PalPilot began as a fresh reimplementation building on the idea and groundwork of:

- **[notaSWE/palworld-terraform](https://github.com/notaSWE/palworld-terraform)** — the original
  Terraform project this work started from (on-demand Palworld server on GCE). PalPilot keeps that
  cost-aware core and rebuilds the control plane, admin panel, save/mod tooling, and security around it.
- **[A1RM4X/HowTo-Palworld](https://github.com/A1RM4X/HowTo-Palworld)** — reference for Palworld
  dedicated-server setup on Linux.

Thanks to the original authors. This repository is an independent, rewritten continuation of that idea.

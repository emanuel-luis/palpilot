# PalPilot

**A cost-aware control plane for an on-demand Palworld dedicated server on Google Cloud.**

PalPilot runs your Palworld server on a GCE VM that **powers itself off when empty** and back on from a web
console — so you pay for compute only while people are actually playing. On top of that it adds a full admin
console: live status, in-game commands, a schema-aware settings editor, **save slots with per-save settings,
mods, backups & restore**, and **users, roles, and per-feature permissions**.

> A fresh, independent implementation building on the idea and groundwork of
> **[notaSWE/palworld-terraform](https://github.com/notaSWE/palworld-terraform)** and
> **[A1RM4X/HowTo-Palworld](https://github.com/A1RM4X/HowTo-Palworld)**. See [Credits](#credits).

---

## Why

A Palworld dedicated server on an always-on 4-vCPU VM burns money while nobody is online. PalPilot keeps the
server **off by default**:

- **Coordinator** — an always-on, serverless control plane that hosts the console and starts/stops the VM.
- **Idle watchdog** — on the VM, powers the machine off after it has been empty for a grace period.
- **Persistent data disk** — worlds and mods survive every power cycle.

You get a hosted server's convenience without the always-on bill (see [Cost](#cost)).

---

## Features

- **On-demand power** — start/stop the VM from the browser; automatic power-off when empty.
- **Unified console** — a single overview: server power state, players, uptime, in-game day, plus every server action.
- **Save slots** — create, switch, clone, rename, delete; the active world is switched safely (stop → backup → switch → restart).
- **Per-save settings & mods** — each save keeps its own `PalWorldSettings.ini` and mod set; they travel with the save when you clone or switch.
- **Backups & restore** — per-slot backups to the VM disk **and** Google Cloud Storage, with retention pruning and one-click restore.
- **Mods** — install `.pak` / LogicMods natively; UE4SS script mods are supported via an optional Proton runtime.
- **Settings editor** — schema-aware, searchable editor for `PalWorldSettings.ini`, plus a raw editor.
- **In-game commands** — announce, kick, ban/unban, save, and restart/stop the game (without powering off the VM).
- **Users, roles & permissions** — session-based login; assign users a role (owner/operator/moderator/viewer or a custom one) built from granular per-feature permissions.
- **Discord bot** — `/palworld status|address|players|start` for players and `/paladmin announce|kick|ban|shutdown|user-create|…` for admins, mapped from Discord roles to the same permissions. Serverless: no bot process to host. See **[`docs/DISCORD.md`](docs/DISCORD.md)**.

---

## Architecture

```
  Browser ──HTTPS──▶  Coordinator  (Cloud Function, always-on)
  Discord ──signed──▶  • slash commands (Ed25519-verified interactions endpoint)
                      • single-page console (built, self-contained)
                      • session-token auth, users/roles, watchdog config
                      • start/stop the VM
                      • signed, permission-checked proxy to the VM agent
                          │
                          ▼  (RBAC-signed requests over the VM's IP)
                      Palworld VM (GCE, start/stop billing)
                      • agent: settings / saves / mods / backups / restore
                      • idle watchdog: auto power-off when empty
                      • palworld.service  +  persistent data disk
```

Two tiers on purpose: the always-on control plane is tiny and serverless; the expensive VM only runs while
players are on. The VM-side agent is delivered from a GCS bucket, so most updates ship **without a Terraform
apply or VM recreate**.

Full diagrams and data model: **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**.

---

## Deploy

### Prerequisites
- A Google Cloud project (new accounts get free credit).
- `terraform`, `gcloud`, `gsutil` installed and authenticated.

### First deploy
1. Enable the Compute Engine API.
2. Clone the repo and `cd` into it.
3. Copy `terraform.tfvars.example` to `terraform.tfvars` and fill in `project_id`, `region`, `zone`, and the
   passwords/token. **Never commit `terraform.tfvars` or `terraform.tfstate`** (both are gitignored).
4. `terraform init && terraform plan && terraform apply`.
5. Wait ~15 minutes for first provisioning; open the coordinator URL from `terraform output`.

### Ongoing changes
- **Console / control-plane** code deploys by redeploying the coordinator (Cloud Function).
- **VM-agent** code deploys by pushing to the panel bucket (applied on the VM's next boot).
- **Automatically on push:** GitHub Actions handles both — see **[`docs/CICD.md`](docs/CICD.md)**.
- **Infrastructure** changes (`*.tf`, `startup.sh`) are applied with `terraform apply` in a maintenance window,
  since editing `startup.sh` recreates the VM.

> **Security:** local Terraform state and `.tfvars` hold plaintext secrets. Keep the working tree **out of any
> cloud-synced folder** (OneDrive/Dropbox) or use a remote state backend, and rotate credentials if exposed.

---

## Cost

Because the server is off by default, cost is a small fixed floor plus a per-play-hour rate (São Paulo, approx):

| | Estimate |
|---|---|
| Fixed floor (VM off): static IP + disks | **~$14/month** |
| Per play-hour: compute + egress | **~$0.18/hour** |
| Example — 2 h/day · 4 h/day · 8 h/day | **~$27 · ~$40 · ~$65 / month** |

The console, backups, roles, per-save settings, mods, watchdog, and monitoring cost effectively nothing —
the money is in VM compute (only while running), the static IP, and the persistent disks.

---

## Credits

PalPilot is an independent reimplementation building on:
- **[notaSWE/palworld-terraform](https://github.com/notaSWE/palworld-terraform)** — the original on-demand
  Palworld-on-GCE Terraform project this started from.
- **[A1RM4X/HowTo-Palworld](https://github.com/A1RM4X/HowTo-Palworld)** — Palworld dedicated-server reference.

Thanks to the original authors.

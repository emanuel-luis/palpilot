# Security notes

Known risks in the infrastructure as written, why each one is still there, and the fix. The GCP
project is offline by choice, so none of this is exposed today; apply the fixes when reviving
([`REVIVAL.md`](REVIVAL.md)).

## Panel port open to the internet

The firewall rule `palworld-panel-<panel_port>` (`main.tf`) allows `var.panel_allowed_cidrs`, which
defaults to `0.0.0.0/0`. The VM agent behind it speaks plain HTTP. The coordinator calls it at
`http://<static external IP>:<panel_port>` (`VM_IP`/`VM_PORT` env, `coordinator.tf`) with
HMAC-signed `X-Coord-*` headers keyed by `INTERNAL_TOKEN`; an empty token fails closed.

Narrowing the CIDR alone would cut the console off: Cloud Run has no fixed egress IP. The fix moves
the coordinator's traffic inside the VPC:

1. Give the Cloud Run service Direct VPC egress on the `default` network and the region's subnet
   (`template { vpc_access { network_interfaces { network, subnetwork }
   egress = "PRIVATE_RANGES_ONLY" } }` in `google_cloud_run_v2_service.coordinator`).
2. Point the coordinator at the VM's internal IP
   (`google_compute_instance.palworld.network_interface[0].network_ip`) instead of the static
   external address.
3. Set `panel_allowed_cidrs` to the subnet range only.
4. Add a startup probe to the service: egress can take a while to become ready on a new instance.

Facts from the
[Direct VPC egress docs](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc): there is
no connector charge, only network traffic (same-region traffic between Google Cloud resources is
free); the subnet must be /26 or larger (auto-mode subnets are /20); each instance uses about four
IP addresses. None of these steps recreates the VM, but read the plan before applying.

## Secrets in instance metadata and in the state

`enable_secret_manager` defaults to `false`, so the panel password, the admin password and the
internal token travel in instance metadata and sit in plain text in the Terraform state. Keep the
state in the versioned, private GCS bucket from the revival runbook, then set
`enable_secret_manager = true` (VM recreate) and rotate the three values.

## Static analysis

CI runs checkov against `.checkov.baseline`, which records the 16 findings that existed when CI was
added (bucket logging and public access prevention, bucket versioning, customer-supplied disk keys,
default service account on the VM, public IP, project-wide SSH keys, Artifact Registry and Cloud Run
invoker settings). New findings fail the build. Trivy is not used: its GitHub Action tags were
hijacked in March 2026 (CVE-2026-33634).

## SSH on the default network

`palworld-ssh-restricted` only allows Google's IAP range plus `var.ssh_admin_cidrs`. The `default`
network may still carry a legacy `default-allow-ssh` rule open to `0.0.0.0/0`, created outside
Terraform. Remove it by hand when reviving.

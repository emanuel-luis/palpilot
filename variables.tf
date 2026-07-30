variable "project_id" {
  description = "The ID of the project in which resources will be provisioned."
}

variable "region" {
  description = "The region to host the instance in."
}

variable "zone" {
  description = "The zone to host the instance in."
}

variable "panel_port" {
  description = "TCP port the admin panel listens on."
  type        = number
  default     = 8080
}

variable "panel_user" {
  description = "Basic-auth username for the admin panel."
  type        = string
  default     = "admin"
}

variable "panel_password" {
  description = "Basic-auth password for the admin panel."
  type        = string
  sensitive   = true
}

variable "admin_password" {
  description = "Palworld REST API / in-game admin password (AdminPassword in PalWorldSettings.ini)."
  type        = string
  sensitive   = true
}

variable "rest_api_port" {
  description = "Palworld REST API port (localhost only, proxied by the panel)."
  type        = number
  default     = 8212
}

variable "internal_token" {
  description = "Shared secret the VM watchdog uses to call the coordinator stop endpoint."
  type        = string
  sensitive   = true
}

variable "idle_poll_seconds" {
  description = "How often the watchdog checks player activity."
  type        = number
  default     = 60
}

variable "idle_grace_seconds" {
  description = "How long the server may stay empty before the VM is powered off."
  type        = number
  default     = 1800
}

#
# --- Modernization additions (see docs/MODERNIZATION_PLAN.md §9/§10) ---
#

variable "panel_allowed_cidrs" {
  description = <<-EOT
    CIDR ranges allowed to reach the VM panel port (var.panel_port) directly.
    RISK (finding C2): default of 0.0.0.0/0 preserves current behavior but
    exposes a plaintext-HTTP, root-owned, single-shared-credential admin
    surface to the whole internet. Restrict this to the coordinator's
    egress range and/or your own admin IPs once the signed-header RBAC
    propagation (H1) is deployed; do not rely on Basic Auth alone as the
    perimeter.
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ssh_admin_cidrs" {
  description = <<-EOT
    Additional CIDR ranges (beyond Google's fixed IAP range) allowed to SSH
    (tcp:22) into the VM, for break-glass access without IAP. Empty by
    default -- use `gcloud compute ssh --tunnel-through-iap` instead. Note:
    this module only manages the restricted rule below; the *default*
    network may still carry its own implicit/legacy 0.0.0.0/0 tcp:22 rule
    (see MODERNIZATION_PLAN.md Phase 0 / Class A) -- verify and remove that
    one manually, it is outside Terraform's control here.
  EOT
  type        = list(string)
  default     = []
}

variable "enable_secret_manager" {
  description = <<-EOT
    When true, provisions Secret Manager secrets for panel_password,
    admin_password and internal_token, grants the VM service account
    accessor rights, and has startup.sh fetch them from Secret Manager
    instead of instance metadata. Defaults to false so existing
    deployments are unaffected until the operator opts in (Phase 4,
    requires a VM recreate to take effect either way).
  EOT
  type        = bool
  default     = false
}

variable "enable_monitoring" {
  description = "Create a minimal Cloud Monitoring uptime check + alert policy for the coordinator URL."
  type        = bool
  default     = true
}

variable "notification_channel_email" {
  description = <<-EOT
    Email address to notify on monitoring alerts (coordinator down, etc).
    Leave empty to still create the uptime check/alert policy but with no
    notification channel attached (visible in Cloud Console only).
  EOT
  type        = string
  default     = ""
}

#
# --- Discord bot (see docs/DISCORD.md) ---
# All optional: an empty discord_public_key leaves the interactions endpoint
# disabled (404) and changes nothing about the rest of the deployment.
#

variable "discord_public_key" {
  description = <<-EOT
    Discord application PUBLIC KEY (General Information page). The coordinator
    verifies every interaction's Ed25519 signature against it. Empty (default)
    disables /api/discord/interactions entirely. This is a public value -- the
    bot token is never given to the coordinator.
  EOT
  type        = string
  default     = ""
}

variable "discord_guild_id" {
  description = "Discord server (guild) ID allowed to use the bot. Empty = accept any guild the app is in."
  type        = string
  default     = ""
}

variable "discord_admin_role_ids" {
  description = <<-EOT
    Discord role IDs granted every PalPilot permission: /paladmin (announce,
    kick, ban, shutdown, poweroff) and console-user management. Comma-separated.
    Empty = nobody gets the elevated commands.
  EOT
  type        = string
  default     = ""
}

variable "discord_user_role_ids" {
  description = <<-EOT
    Discord role IDs allowed the plain-member commands (/palworld status,
    address, players, start -> "view" + "power"). Comma-separated. Empty means
    any member of the guild may run them.
  EOT
  type        = string
  default     = ""
}

#
# --- Dual-mode server runtime (see docs/FRONTEND_V2_PLAN.md "Runtime dual-mode") ---
#

variable "runtime_mode" {
  description = <<-EOT
    Server runtime: "native" (default) or "proton" (EXPERIMENTAL, opt-in).

    "native" reproduces today's behavior byte-for-byte: startup.sh installs
    the Linux PalServer build via steamcmd and runs it directly under
    systemd. This is the only mode that has ever been booted/validated.

    "proton" makes startup.sh install GE-Proton and the WINDOWS PalServer
    build instead (needed for UE4SS/RE-UE4SS script mods), and launches
    PalServer.exe through Proton from the systemd unit. It is guarded
    behind `[ "$RUNTIME_MODE" = "proton" ]` in startup.sh, has NOT been
    booted/tested (reviewed for consistency only), wants a bigger
    machine_type than native (see the commented option next to
    google_compute_instance.palworld in main.tf), and -- like any
    startup.sh/metadata change to this VM -- only takes effect after a
    stop/apply/start cycle (this project's "recreate": the persistent data
    disk survives, but connected players are disconnected). Treat flipping
    this variable as a planned maintenance-window change, never a routine
    `terraform apply`.
  EOT
  type        = string
  default     = "native"

  validation {
    condition     = contains(["native", "proton"], var.runtime_mode)
    error_message = "runtime_mode must be either \"native\" or \"proton\"."
  }
}

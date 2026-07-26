#
# Coordenador serverless (Cloud Function gen2): liga/desliga a VM,
# hospeda o painel e faz proxy de config/REST pro agente na VM.
#

#
# APIs necessárias
#
resource "google_project_service" "apis" {
  for_each = toset([
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "monitoring.googleapis.com",
    "secretmanager.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}


#
# Objeto do watchdog no bucket do painel (baixado pela VM no boot)
#
resource "google_storage_bucket_object" "panel_watchdog" {
  name   = "idle_watchdog.py"
  bucket = google_storage_bucket.palworld_panel.name
  source = "${path.module}/panel/idle_watchdog.py"

  lifecycle {
    ignore_changes = [source, detect_md5hash]
  }
}


#
# Service account do coordenador (pode ligar/desligar a instância)
#
resource "google_service_account" "coordinator" {
  account_id   = "palworld-coordinator"
  display_name = "Palworld Coordinator"
}

# --- Scoped compute control (fixes the over-grant noted in the assessment
# gaps: coordinator previously held roles/compute.instanceAdmin.v1 at
# PROJECT scope, i.e. start/stop/reconfigure/delete power over every
# instance in the project, when it only ever calls .get/.start/.stop on the
# single palworld VM -- see coordinator/main.py). We define a custom role
# with just those three permissions and bind it at the single-instance
# resource scope instead of the project.
resource "google_project_iam_custom_role" "coordinator_vm_ops" {
  role_id     = "palworldCoordinatorVmOps"
  title       = "Palworld Coordinator VM Ops"
  description = "Least-privilege role for the coordinator function: get/start/stop the Palworld VM only."
  stage       = "GA"
  permissions = [
    "compute.instances.get",
    "compute.instances.start",
    "compute.instances.stop",
  ]
}

resource "google_compute_instance_iam_member" "coordinator_vm_ops" {
  project       = var.project_id
  zone          = var.zone
  instance_name = google_compute_instance.palworld.name
  role          = google_project_iam_custom_role.coordinator_vm_ops.id
  member        = "serviceAccount:${google_service_account.coordinator.email}"
}

# Coordenador lê/grava users.json no bucket do painel
resource "google_storage_bucket_iam_member" "coordinator_users" {
  bucket = google_storage_bucket.palworld_panel.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.coordinator.email}"
}

# Quem roda o terraform precisa de actAs sobre o SA do coordenador para
# deployar a função com esse SA.
data "google_client_openid_userinfo" "me" {}

# O Cloud Build (gen2) usa o SA default do Compute como build SA. Nesse
# projeto ele está sem permissões, então o build falha. Concede o papel.
data "google_project" "this" {}

resource "google_project_iam_member" "build_sa_builder" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.builder"
  member  = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

resource "google_service_account_iam_member" "deployer_actas" {
  service_account_id = google_service_account.coordinator.name
  role               = "roles/iam.serviceAccountUser"
  member             = "user:${data.google_client_openid_userinfo.me.email}"
}


#
# Código-fonte do coordenador -> zip -> bucket do painel
#
data "archive_file" "coordinator" {
  type        = "zip"
  source_dir  = "${path.module}/coordinator"
  output_path = "${path.module}/.build/coordinator.zip"
}

resource "google_storage_bucket_object" "coordinator_src" {
  # md5 no nome força novo deploy quando o código muda
  name   = "coordinator-${data.archive_file.coordinator.output_md5}.zip"
  bucket = google_storage_bucket.palworld_panel.name
  source = data.archive_file.coordinator.output_path
}


#
# Cloud Function gen2 (HTTP)
#
resource "google_cloudfunctions2_function" "coordinator" {
  name     = "palworld-coordinator"
  location = var.region

  build_config {
    runtime     = "python312"
    entry_point = "coordinator"
    source {
      storage_source {
        bucket = google_storage_bucket.palworld_panel.name
        object = google_storage_bucket_object.coordinator_src.name
      }
    }
  }

  service_config {
    available_memory      = "512M"
    timeout_seconds       = 300
    min_instance_count    = 0
    max_instance_count    = 2
    ingress_settings      = "ALLOW_ALL"
    service_account_email = google_service_account.coordinator.email

    environment_variables = {
      PROJECT_ID     = var.project_id
      VM_ZONE        = var.zone
      VM_INSTANCE    = "palworld-tf-vm"
      VM_IP          = google_compute_address.palworld_ip.address
      VM_PORT        = tostring(var.panel_port)
      GAME_PORT      = "8211" # matches the UDP firewall rule in main.tf
      PANEL_BUCKET   = google_storage_bucket.palworld_panel.name
      PANEL_USER     = var.panel_user
      PANEL_PASSWORD = var.panel_password
      INTERNAL_TOKEN = var.internal_token

      IDLE_POLL_DEFAULT  = tostring(var.idle_poll_seconds)
      IDLE_GRACE_DEFAULT = tostring(var.idle_grace_seconds)

      # Discord bot (docs/DISCORD.md). Empty public key = endpoint disabled.
      DISCORD_PUBLIC_KEY     = var.discord_public_key
      DISCORD_GUILD_ID       = var.discord_guild_id
      DISCORD_ADMIN_ROLE_IDS = var.discord_admin_role_ids
      DISCORD_USER_ROLE_IDS  = var.discord_user_role_ids
    }
  }

  depends_on = [
    google_project_service.apis,
    google_service_account_iam_member.deployer_actas,
    google_project_iam_member.build_sa_builder,
  ]
}


#
# Permitir invocação pública (o app faz basic auth por conta própria)
#
resource "google_cloud_run_service_iam_member" "coordinator_invoker" {
  location = var.region
  service  = google_cloudfunctions2_function.coordinator.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}


#
# Monitoring (gap noted in the assessment: "nobody is told if the service
# crash-loops or a recreate fails to come back"). Minimal uptime check on
# the coordinator's public HTTPS endpoint + an alert policy. Controlled by
# var.enable_monitoring (default true, cheap/no player impact -- Class B).
# Attach a notification channel by setting var.notification_channel_email;
# left empty the alert still exists (visible in Cloud Console) but nothing
# is paged.
#
resource "google_monitoring_notification_channel" "email" {
  count        = var.enable_monitoring && var.notification_channel_email != "" ? 1 : 0
  display_name = "Palworld coordinator alerts (email)"
  type         = "email"

  labels = {
    email_address = var.notification_channel_email
  }
}

resource "google_monitoring_uptime_check_config" "coordinator" {
  count        = var.enable_monitoring ? 1 : 0
  display_name = "palworld-coordinator-https"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = "/"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      host = replace(replace(google_cloudfunctions2_function.coordinator.url, "https://", ""), "/", "")
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "coordinator_down" {
  count        = var.enable_monitoring ? 1 : 0
  display_name = "Palworld coordinator uptime check failing"
  combiner     = "OR"

  conditions {
    display_name = "Coordinator HTTPS uptime check failed"

    condition_threshold {
      filter          = "resource.type=\"uptime_url\" AND metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.coordinator[0].uptime_check_id}\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_email != "" ? [google_monitoring_notification_channel.email[0].id] : []

  user_labels = {
    severity = "critical"
  }

  depends_on = [google_project_service.apis]
}

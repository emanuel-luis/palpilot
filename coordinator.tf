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

resource "google_project_iam_member" "coordinator_compute" {
  project = var.project_id
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:${google_service_account.coordinator.email}"
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
    available_memory      = "256M"
    timeout_seconds       = 60
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
      PANEL_USER     = var.panel_user
      PANEL_PASSWORD = var.panel_password
      INTERNAL_TOKEN = var.internal_token
    }
  }

  depends_on = [google_project_service.apis]
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

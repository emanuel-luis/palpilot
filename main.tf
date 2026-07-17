provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}


#
# IP externo estático (persiste entre recriações da VM)
#
resource "google_compute_address" "palworld_ip" {
  name         = "palworld-ip"
  region       = var.region
  address_type = "EXTERNAL"
}


#
# Firewall Palworld
#
resource "google_compute_firewall" "palworld_udp" {
  name    = "palworld-udp-8211"
  network = "default"

  allow {
    protocol = "udp"
    ports    = ["8211"]
  }

  source_ranges = ["0.0.0.0/0"]
}


#
# Firewall painel admin (TCP)
#
resource "google_compute_firewall" "palworld_panel_tcp" {
  name    = "palworld-panel-${var.panel_port}"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = [tostring(var.panel_port)]
  }

  # RISK (finding C2): var.panel_allowed_cidrs defaults to 0.0.0.0/0 to
  # preserve current behavior. This port serves plaintext HTTP on a
  # root-owned process behind only a shared Basic-Auth credential (no
  # per-user RBAC) -- see docs/MODERNIZATION_PLAN.md. Narrow this variable
  # once the coordinator's signed-header RBAC propagation (H1) is in place.
  source_ranges = var.panel_allowed_cidrs
}


#
# Firewall SSH restrito (fecha o gap de tcp:22 aberto por padrão)
#
resource "google_compute_firewall" "palworld_ssh_restricted" {
  name    = "palworld-ssh-restricted"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  # 35.235.240.0/20 is Google's fixed IAP TCP-forwarding range (SSH via
  # `gcloud compute ssh --tunnel-through-iap`). var.ssh_admin_cidrs adds
  # any break-glass admin CIDRs on top; empty by default.
  source_ranges = concat(["35.235.240.0/20"], var.ssh_admin_cidrs)

  target_tags = ["https-server"]
}

# NOTE: this rule only ever *adds* a restricted allow. The GCP "default"
# auto-mode network historically ships its own implicit/legacy
# `default-allow-ssh` rule open to 0.0.0.0/0, created outside this
# Terraform config. That rule must be located and removed/tightened by the
# operator directly (Class A, see MODERNIZATION_PLAN.md Phase 0) --
# Terraform does not manage or import it here, so this module cannot
# delete it for you.


#
# Bucket para backup dos saves
#
resource "google_storage_bucket" "palworld_backup" {

  name = "${var.project_id}-palworld-backups"

  location      = "SOUTHAMERICA-EAST1"
  storage_class = "STANDARD"

  uniform_bucket_level_access = true


  versioning {
    enabled = true
  }


  lifecycle_rule {

    condition {
      age = 30
    }

    action {
      type = "Delete"
    }
  }
}



#
# Bucket com o código do painel admin (desacoplado da VM: atualize com
# gsutil + botão "Atualizar painel" sem precisar de terraform apply/recreate)
#
resource "google_storage_bucket" "palworld_panel" {
  name          = "${var.project_id}-palworld-panel"
  location      = "SOUTHAMERICA-EAST1"
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
}

resource "google_storage_bucket_object" "panel_py" {
  name   = "panel.py"
  bucket = google_storage_bucket.palworld_panel.name
  source = "${path.module}/panel/panel.py"

  # Uploads iniciais só; atualizações posteriores via gsutil não são revertidas.
  lifecycle {
    ignore_changes = [source, detect_md5hash]
  }
}

resource "google_storage_bucket_object" "panel_html" {
  name   = "index.html"
  bucket = google_storage_bucket.palworld_panel.name
  source = "${path.module}/panel/index.html"

  lifecycle {
    ignore_changes = [source, detect_md5hash]
  }
}


#
# Disco persistente do Palworld
#
resource "google_compute_disk" "palworld_data" {

  name = "palworld-data"

  type = "pd-balanced"

  zone = var.zone

  size = 40


  labels = {
    purpose = "palworld-server"
  }
}



#
# VM Palworld
#
resource "google_compute_instance" "palworld" {

  name         = "palworld-tf-vm"
  machine_type = "e2-standard-4"
  # machine_type = "e2-standard-8"
  #
  # var.runtime_mode = "proton" (EXPERIMENTAL, see variables.tf and
  # docs/FRONTEND_V2_PLAN.md) runs the Windows PalServer build through
  # GE-Proton, which is heavier (Wine/DXVK translation overhead) than the
  # native Linux build. If/when you opt into proton for real, bump this to
  # a bigger machine_type first, e.g.:
  #   machine_type = "e2-standard-8"
  # `allow_stopping_for_update = true` below lets Terraform resize in
  # place (stop -> update -> start; the persistent data disk survives) --
  # it is NOT a delete+recreate, but it still disconnects players, so do
  # it in the same maintenance window as flipping runtime_mode.
  zone = var.zone

  # Permite trocar machine_type sem recriar (para/liga a VM, mantém discos).
  allow_stopping_for_update = true


  tags = [
    "https-server"
  ]

  # Painel baixa o código do bucket no boot; garanta que os objetos existam.
  depends_on = [
    google_storage_bucket_object.panel_py,
    google_storage_bucket_object.panel_html,
    google_storage_bucket_object.panel_watchdog,
  ]


  #
  # Disco do sistema
  #
  boot_disk {

    auto_delete = true


    initialize_params {

      image = "debian-cloud/debian-13"

      size = 20

      type = "pd-balanced"

    }
  }



  #
  # Disco persistente dos dados
  #
  attached_disk {

    source = google_compute_disk.palworld_data.id

    device_name = "palworld-data"

  }



  network_interface {

    network = "default"


    access_config {

      nat_ip       = google_compute_address.palworld_ip.address
      network_tier = "PREMIUM"

    }
  }



  metadata = {

    enable-osconfig = "TRUE"

    # Admin panel config consumed by startup.sh. Code lives in GCS
    # (panel-bucket), so panel changes never require a terraform apply.
    panel-bucket   = google_storage_bucket.palworld_panel.name
    panel-port     = tostring(var.panel_port)
    panel-user     = var.panel_user
    panel-password = var.panel_password
    admin-password = var.admin_password
    rest-api-port  = tostring(var.rest_api_port)

    # Dual-mode server runtime (opt-in, see var.runtime_mode in
    # variables.tf and docs/FRONTEND_V2_PLAN.md "Runtime dual-mode").
    # Default "native" reproduces today's behavior unchanged. startup.sh
    # reads this and guards every proton-specific step behind
    # `[ "$RUNTIME_MODE" = "proton" ]`; it also exports it as
    # RUNTIME_MODE= in the palworld-panel.service Environment so panel.py
    # can be capability-aware (e.g. gate UE4SS mod installs). Changing this
    # value only takes effect on the VM's next stop/apply/start cycle, same
    # as any other startup.sh/metadata edit -- plan a maintenance window.
    runtime-mode = var.runtime_mode

    # Coordinator (serverless) + idle watchdog config
    coordinator-url    = google_cloudfunctions2_function.coordinator.url
    coordinator-token  = var.internal_token
    idle-poll-seconds  = tostring(var.idle_poll_seconds)
    idle-grace-seconds = tostring(var.idle_grace_seconds)

    # Secret Manager (Phase 4, opt-in). When enabled, startup.sh fetches
    # panel-password/admin-password/coordinator-token from Secret Manager
    # by these secret_ids instead of trusting the plaintext metadata values
    # above. Off by default so existing deployments are unaffected; see
    # var.enable_secret_manager. The plaintext metadata values above are
    # still set either way for backward compatibility / rollback.
    use-secret-manager       = tostring(var.enable_secret_manager)
    secret-panel-password-id = try(google_secret_manager_secret.panel_password[0].secret_id, "")
    secret-admin-password-id = try(google_secret_manager_secret.admin_password[0].secret_id, "")
    secret-internal-token-id = try(google_secret_manager_secret.internal_token[0].secret_id, "")

  }



  metadata_startup_script = file("${path.module}/startup.sh")



  #
  # Permissão para backup no GCS
  #
  service_account {

    scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]

  }



  shielded_instance_config {

    enable_secure_boot = false

    enable_vtpm = true

    enable_integrity_monitoring = true

  }



  scheduling {

    automatic_restart = true

    on_host_maintenance = "MIGRATE"

    preemptible = false

    provisioning_model = "STANDARD"

  }

}



#
# Permitir VM gravar backups
#
resource "google_storage_bucket_iam_member" "palworld_backup_permission" {

  bucket = google_storage_bucket.palworld_backup.name


  role = "roles/storage.objectAdmin"


  member = "serviceAccount:${google_compute_instance.palworld.service_account[0].email}"

}


#
# Permitir VM ler (e o painel re-sincronizar) o código do painel
#
resource "google_storage_bucket_iam_member" "palworld_panel_read" {

  bucket = google_storage_bucket.palworld_panel.name

  role = "roles/storage.objectViewer"

  member = "serviceAccount:${google_compute_instance.palworld.service_account[0].email}"

}


#
# Secret Manager (Phase 4, M8/H1) -- opt-in via var.enable_secret_manager.
# Moves panel_password/admin_password/internal_token out of instance
# metadata (readable by anyone who can read instance metadata, e.g. via
# the metadata server from inside the VM) into Secret Manager, with a
# narrow accessor grant to the VM's own service account. Nothing here is
# created, and startup.sh keeps reading metadata, until the operator flips
# the flag and recreates the VM (Class D).
#
resource "google_secret_manager_secret" "panel_password" {
  count     = var.enable_secret_manager ? 1 : 0
  secret_id = "palworld-panel-password"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "panel_password" {
  count       = var.enable_secret_manager ? 1 : 0
  secret      = google_secret_manager_secret.panel_password[0].id
  secret_data = var.panel_password
}

resource "google_secret_manager_secret" "admin_password" {
  count     = var.enable_secret_manager ? 1 : 0
  secret_id = "palworld-admin-password"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "admin_password" {
  count       = var.enable_secret_manager ? 1 : 0
  secret      = google_secret_manager_secret.admin_password[0].id
  secret_data = var.admin_password
}

resource "google_secret_manager_secret" "internal_token" {
  count     = var.enable_secret_manager ? 1 : 0
  secret_id = "palworld-internal-token"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "internal_token" {
  count       = var.enable_secret_manager ? 1 : 0
  secret      = google_secret_manager_secret.internal_token[0].id
  secret_data = var.internal_token
}

# VM service account may read (but not manage) the three secrets above.
resource "google_secret_manager_secret_iam_member" "panel_password_accessor" {
  count     = var.enable_secret_manager ? 1 : 0
  secret_id = google_secret_manager_secret.panel_password[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_compute_instance.palworld.service_account[0].email}"
}

resource "google_secret_manager_secret_iam_member" "admin_password_accessor" {
  count     = var.enable_secret_manager ? 1 : 0
  secret_id = google_secret_manager_secret.admin_password[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_compute_instance.palworld.service_account[0].email}"
}

resource "google_secret_manager_secret_iam_member" "internal_token_accessor" {
  count     = var.enable_secret_manager ? 1 : 0
  secret_id = google_secret_manager_secret.internal_token[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_compute_instance.palworld.service_account[0].email}"
}
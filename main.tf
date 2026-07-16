provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
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

  source_ranges = ["0.0.0.0/0"]
}


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
  machine_type = "e2-standard-8"
  zone         = var.zone


  tags = [
    "https-server"
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

      network_tier = "PREMIUM"

    }
  }



  metadata = {

    enable-osconfig = "TRUE"

    # Admin panel: source files + config consumed by startup.sh
    panel-py       = file("${path.module}/panel/panel.py")
    panel-html     = file("${path.module}/panel/index.html")
    panel-port     = tostring(var.panel_port)
    panel-user     = var.panel_user
    panel-password = var.panel_password
    admin-password = var.admin_password
    rest-api-port  = tostring(var.rest_api_port)

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
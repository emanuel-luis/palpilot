output "palworld_ip" {
  value = google_compute_instance.palworld.network_interface[0].access_config[0].nat_ip
}


output "backup_bucket" {
  value = google_storage_bucket.palworld_backup.name
}


output "panel_url" {
  value = "http://${google_compute_address.palworld_ip.address}:${var.panel_port}"
}


output "panel_bucket" {
  value = google_storage_bucket.palworld_panel.name
}
output "palworld_ip" {
  value = google_compute_instance.palworld.network_interface[0].access_config[0].nat_ip
}


output "backup_bucket" {
  value = google_storage_bucket.palworld_backup.name
}


output "panel_url" {
  value = "http://${google_compute_instance.palworld.network_interface[0].access_config[0].nat_ip}:${var.panel_port}"
}
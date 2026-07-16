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

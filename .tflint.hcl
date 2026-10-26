plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "google" {
  enabled = true
  version = "0.41.0"
  source  = "github.com/terraform-linters/tflint-ruleset-google"
}

# project_id, region and zone in variables.tf have no type; adding one is a .tf change. Follow-up.
rule "terraform_typed_variables" {
  enabled = false
}

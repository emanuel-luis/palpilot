# Atualiza o código do painel sem terraform apply / recreate.
# 1) sobe panel.py + index.html pro bucket GCS
# 2) manda o painel puxar o código novo e reiniciar (endpoint /api/self-update)
#
# Uso:  pwsh scripts/deploy-panel.ps1
# Requer: gcloud/gsutil autenticado, terraform outputs disponíveis.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    $bucket = (terraform output -raw panel_bucket)
    $url    = (terraform output -raw panel_url)

    Write-Host "Enviando código para gs://$bucket ..."
    gsutil cp "$root/panel/panel.py"   "gs://$bucket/panel.py"
    gsutil cp "$root/panel/index.html" "gs://$bucket/index.html"

    Write-Host "Disparando self-update em $url ..."
    # Lê a senha do painel do terraform.tfvars (gitignored).
    $tfvars = Get-Content "$root/terraform.tfvars" -Raw
    $u = ([regex]'panel_user\s*=\s*"([^"]*)"').Match($tfvars).Groups[1].Value
    $p = ([regex]'panel_password\s*=\s*"([^"]*)"').Match($tfvars).Groups[1].Value
    if (-not $u) { $u = "admin" }
    $token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${u}:${p}"))
    try {
        Invoke-RestMethod -Method Post -Uri "$url/api/self-update" `
            -Headers @{ Authorization = "Basic $token" } -TimeoutSec 30 | Out-Null
        Write-Host "Painel atualizado e reiniciando." -ForegroundColor Green
    } catch {
        Write-Host "Upload OK, mas self-update falhou ($($_.Exception.Message))." -ForegroundColor Yellow
        Write-Host "Use o botão 'Atualizar painel' na UI."
    }
} finally {
    Pop-Location
}

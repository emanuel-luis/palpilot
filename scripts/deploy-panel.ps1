# Atualiza o código do painel sem terraform apply / recreate.
# 1) sobe panel.py + index.html pro bucket GCS (via API JSON + token ADC)
# 2) manda o painel puxar o código novo e reiniciar (/api/self-update)
#
# Uso:  pwsh scripts/deploy-panel.ps1
# Requer: `gcloud auth application-default login` feito, terraform outputs disponíveis.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    $bucket = (terraform output -raw panel_bucket)
    $url    = (terraform output -raw panel_url)

    $token = (gcloud auth application-default print-access-token).Trim()
    $auth  = @{ Authorization = "Bearer $token" }

    function Upload($file, $name, $ctype) {
        $uri = "https://storage.googleapis.com/upload/storage/v1/b/$bucket/o?uploadType=media&name=$name"
        $bytes = [IO.File]::ReadAllBytes($file)
        Invoke-RestMethod -Method Post -Uri $uri -Headers $auth `
            -ContentType $ctype -Body $bytes | Out-Null
        Write-Host "  ↑ $name"
    }

    Write-Host "Enviando código para gs://$bucket ..."
    Upload "$root/panel/panel.py"   "panel.py"   "text/x-python"
    Upload "$root/panel/index.html" "index.html" "text/html"

    Write-Host "Disparando self-update em $url ..."
    $tfvars = Get-Content "$root/terraform.tfvars" -Raw
    $u = ([regex]'panel_user\s*=\s*"([^"]*)"').Match($tfvars).Groups[1].Value
    $p = ([regex]'panel_password\s*=\s*"([^"]*)"').Match($tfvars).Groups[1].Value
    if (-not $u) { $u = "admin" }
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${u}:${p}"))
    try {
        Invoke-RestMethod -Method Post -Uri "$url/api/self-update" `
            -Headers @{ Authorization = "Basic $b64" } -TimeoutSec 30 | Out-Null
        Write-Host "Painel atualizado e reiniciando." -ForegroundColor Green
    } catch {
        Write-Host "Upload OK, mas self-update falhou ($($_.Exception.Message))." -ForegroundColor Yellow
        Write-Host "Use o botão 'Atualizar painel' na UI."
    }
} finally {
    Pop-Location
}

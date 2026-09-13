$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$outDir = Join-Path $root "Results"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$secret = $null
$base = "https://sig-ip-quiz.onrender.com"
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
  Get-Content -Path $envFile -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $key = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if ($key -eq "ADMIN_SECRET") { $secret = $val }
    if ($key -eq "BASE_URL") { $base = $val.TrimEnd("/") }
  }
}

if (-not $secret) {
  Write-Host "ADMIN_SECRET not found in .env"
  Read-Host "Press Enter to close"
  exit 1
}

$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$outFile = Join-Path $outDir "quiz-results-$stamp.csv"
$url = "$base/admin/results.csv"

Write-Host "Downloading $url"
curl.exe -sS -f -H "X-Admin-Secret: $secret" -o $outFile $url
if ($LASTEXITCODE -ne 0) {
  Write-Host "Download failed. Check ADMIN_SECRET in .env and that Render is live."
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host "Saved $outFile"
Start-Process explorer.exe -ArgumentList "/select,`"$outFile`""

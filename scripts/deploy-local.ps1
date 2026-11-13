# deploy-local.ps1
#
# Builds the dashboard against the local self-hosted Supabase gateway and
# installs it into C:\Ninja\analytics-web, then (re)registers the logon task
# that serves it on http://127.0.0.1:4173. Run from the repository root:
#
#   powershell -File scripts\deploy-local.ps1
#
# Browser-safe values only: the publishable key is read from the stack's .env
# at build time and never printed. No secret key or Google credential is used.

param(
    [string]$StackEnv = "C:\Ninja\supabase\.env",
    [string]$InstallDir = "C:\Ninja\analytics-web",
    [int]$Port = 4173
)

$ErrorActionPreference = "Stop"

function Get-EnvValue($name) {
    $line = Get-Content $StackEnv | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
    if (-not $line) { throw "$name not found in $StackEnv" }
    return ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
}

$env:VITE_SUPABASE_URL = "http://127.0.0.1:8000"
$env:VITE_SUPABASE_PUBLISHABLE_KEY = Get-EnvValue "SUPABASE_PUBLISHABLE_KEY"
$env:VITE_APP_URL = "http://127.0.0.1:$Port"

npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed" }

New-Item -ItemType Directory -Force "$InstallDir\dist" | Out-Null
Remove-Item "$InstallDir\dist\*" -Recurse -Force
Copy-Item "dist\*" "$InstallDir\dist" -Recurse
Copy-Item "scripts\serve-local.mjs" $InstallDir -Force
git rev-parse HEAD | Set-Content "$InstallDir\DEPLOYED_COMMIT.txt"

$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$InstallDir\serve-local.mjs`" `"$InstallDir\dist`" $Port" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "NinjaAnalytics-LocalDashboard" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Stop-ScheduledTask -TaskName "NinjaAnalytics-LocalDashboard" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'serve-local\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName "NinjaAnalytics-LocalDashboard"
Write-Host "Dashboard: http://127.0.0.1:$Port (commit $(Get-Content "$InstallDir\DEPLOYED_COMMIT.txt"))"

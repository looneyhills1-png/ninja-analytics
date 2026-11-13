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
# No login screen: serve-local.mjs attaches admin access server-side (loopback only).
$env:VITE_LOCAL_ACCESS = "true"

npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed" }

New-Item -ItemType Directory -Force "$InstallDir\dist" | Out-Null
Remove-Item "$InstallDir\dist\*" -Recurse -Force
Copy-Item "dist\*" "$InstallDir\dist" -Recurse
Copy-Item "scripts\serve-local.mjs", "scripts\local-access.mjs" $InstallDir -Force

# Non-secret server config. The JWT secret is read from the stack .env at server start.
$adminId = (docker exec supabase-db psql -U postgres -At -c "select user_id from private.admin_users limit 1").Trim()
if ($adminId -notmatch '^[0-9a-f-]{36}$') { throw "could not resolve the admin user id" }
@{ adminUserId = $adminId; stackEnv = $StackEnv; gateway = "http://127.0.0.1:8000" } |
    ConvertTo-Json | Set-Content "$InstallDir\local-access.json"
git rev-parse HEAD | Set-Content "$InstallDir\DEPLOYED_COMMIT.txt"

$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$InstallDir\serve-local.mjs`" `"$InstallDir\dist`" $Port" -WorkingDirectory $InstallDir
# At logon, plus a 5-minute repeat: if the server dies, the next tick starts it
# again (a running instance is left alone). Task Scheduler does not restart a
# task just because its process exited.
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$trigger = @($logon, $repeat)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "NinjaAnalytics-LocalDashboard" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Stop-ScheduledTask -TaskName "NinjaAnalytics-LocalDashboard" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'serve-local\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName "NinjaAnalytics-LocalDashboard"
Write-Host "Dashboard: http://127.0.0.1:$Port (commit $(Get-Content "$InstallDir\DEPLOYED_COMMIT.txt"))"

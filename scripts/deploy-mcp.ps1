# deploy-mcp.ps1
#
# Installs the private read-only MCP server into C:\Ninja\ninja-mcp and
# (re)registers the logon task that runs it on 127.0.0.1:47831. Run from the
# repository root:
#
#   powershell -File scripts\deploy-mcp.ps1
#
# Secrets live only in C:\Ninja\mcp\mcp.env (per-user ACL, outside Git): the
# read-only database login and the bearer token. This script never prints them.

param(
    [string]$InstallDir = "C:\Ninja\ninja-mcp",
    [string]$EnvFile = "C:\Ninja\mcp\mcp.env"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $EnvFile)) { throw "$EnvFile not found (database login and token)." }

New-Item -ItemType Directory -Force "$InstallDir" | Out-Null
Remove-Item "$InstallDir\lib" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "tools\ninja-mcp\server.mjs" $InstallDir -Force
Copy-Item "tools\ninja-mcp\lib" "$InstallDir\lib" -Recurse -Force

# Only the pinned database driver, no dev tooling.
$pgVersion = (Get-Content package.json -Raw | ConvertFrom-Json).dependencies.pg
@{ name = "ninja-mcp-runtime"; private = $true; type = "module"; dependencies = @{ pg = $pgVersion } } |
    ConvertTo-Json | Set-Content "$InstallDir\package.json"
Push-Location $InstallDir
try {
    npm install --omit=dev --no-audit --no-fund --ignore-scripts 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
} finally { Pop-Location }

git rev-parse HEAD | Set-Content "$InstallDir\DEPLOYED_COMMIT.txt"

$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$InstallDir\server.mjs`"" -WorkingDirectory $InstallDir
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
# NINJA_MCP_ENV points the server at the secrets file; nothing secret is in the task.
$env:NINJA_MCP_ENV = $EnvFile
[Environment]::SetEnvironmentVariable("NINJA_MCP_ENV", $EnvFile, "User")
Register-ScheduledTask -TaskName "NinjaAnalytics-MCP" -Action $action -Trigger @($logon, $repeat) -Settings $settings -Force | Out-Null

Stop-ScheduledTask -TaskName "NinjaAnalytics-MCP" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'ninja-mcp.*server\.mjs|tools.ninja-mcp.server\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName "NinjaAnalytics-MCP"
Write-Host "MCP: http://127.0.0.1:47831/mcp (commit $(Get-Content "$InstallDir\DEPLOYED_COMMIT.txt"))"

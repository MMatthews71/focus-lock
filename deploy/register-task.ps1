# Registers (or re-registers) the elevated "FocusLock Guardian" scheduled task
# and starts it fresh. Must run elevated. Called by install-elevated.bat, and
# usable on its own to repair the guardian without a full rebuild.
#
# Why PowerShell and not `schtasks /Create`: schtasks cannot set the
# MultipleInstances policy. The task MUST be "Parallel" — with the default
# "IgnoreNew", once a supervisor is running Task Scheduler treats the task as
# running (the detached node is in its process tree) and ignores every later
# minute-trigger, so a wedged supervisor could never be replaced. Parallel lets
# each trigger fire; supervisor.cjs's heartbeat + PID lock keep exactly one
# healthy copy and reclaim a hung one.

param(
  [string]$Launch = (Join-Path $PSScriptRoot 'guardian-launch.vbs')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $Launch

# --- clean slate ----------------------------------------------------------
# Stop any running supervisor (possibly wedged) and the service, and clear the
# PID/heartbeat locks, so the guardian we start below owns everything cleanly.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*supervisor.cjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$svc = (Get-NetTCPConnection -LocalPort 47615 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($svc) { Stop-Process -Id $svc -Force -ErrorAction SilentlyContinue }
Remove-Item (Join-Path $root 'supervisor.pid') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $root 'supervisor.hb')  -Force -ErrorAction SilentlyContinue

# --- task definition ------------------------------------------------------
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Launch`""

# Two triggers: start at logon, and a minute backstop that revives the guardian
# within ~1 minute if it ever stops. The minute trigger fires once now and then
# repeats indefinitely — leaving the repetition Duration UNSET is what means
# "indefinitely"; do NOT use [TimeSpan]::MaxValue, which overflows Task
# Scheduler's duration field and makes registration fail.
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$minute  = New-ScheduledTaskTrigger -Once -At (Get-Date)
$minute.Repetition = New-CimInstance -ClientOnly `
  -Namespace 'Root/Microsoft/Windows/TaskScheduler' `
  -ClassName 'MSFT_TaskRepetitionPattern' `
  -Property @{ Interval = 'PT1M' }

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest -LogonType Interactive

# ExecutionTimeLimit 0 = unlimited, so the long-lived supervisor is never reaped.
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances Parallel `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask -TaskName 'FocusLock Guardian' -Force `
  -Action $action -Trigger @($atLogon, $minute) -Principal $principal -Settings $settings | Out-Null

# Start it now. Use the native cmdlet, NOT `schtasks /Run /TN FocusLock Guardian`
# via Start-Process: Start-Process joins ArgumentList with spaces and does not
# quote, so schtasks sees `/TN FocusLock Guardian` as two args and fails with
# "Invalid argument/option - 'Guardian'". The task then only starts on its next
# minute-trigger, making it look like the install never started the service.
try {
  Start-ScheduledTask -TaskName 'FocusLock Guardian' -ErrorAction Stop
  Write-Host 'FocusLock Guardian registered (Parallel, at-logon + minute backstop) and started.'
} catch {
  Write-Host "FocusLock Guardian registered, but immediate start failed: $($_.Exception.Message)"
  Write-Host 'It will start automatically within ~1 minute (minute backstop trigger).'
}

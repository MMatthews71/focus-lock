@echo off
REM ============================================================================
REM  FocusLock - guarded uninstall (commitment device)
REM
REM  FocusLock will NOT uninstall on a whim. Removal uses a 7-day cooldown:
REM
REM    1. Run this once. If no removal is pending, it starts the 7-day clock
REM       and exits WITHOUT removing anything - FocusLock keeps blocking.
REM    2. Come back any time after 7 full days and run it again. Only then are
REM       the background tasks, the running service, and the watchdog removed.
REM
REM  Cancel any time before the 7 days are up from the FocusLock app
REM  ("Cancel removal"), which keeps you protected.
REM
REM  The cooldown is enforced by the service, whose state file is signed - you
REM  cannot shorten the wait by editing a file or re-running this script.
REM ============================================================================

REM --- self-elevate (the guardian task + its service run elevated, so removing
REM     them needs admin too) --------------------------------------------------
net session >nul 2>&1
if %errorlevel% NEQ 0 (
    echo   Requesting administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "VBS=%~dp0.focuslock-watchdog.vbs"
set "TASK_WATCH=FocusLock Service Watchdog"
set "TASK_LOGON=FocusLock Service Startup"
set "TASK_GUARD=FocusLock Guardian"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "ORIGIN=http://127.0.0.1:47615"
set "DEPLOY=%LOCALAPPDATA%\FocusLock"

echo(
echo   FocusLock - uninstall
echo   =====================
echo(

REM --- Make sure the service is up so we can read/advance the cooldown --------
call :ensure_service

REM --- Ask the service for the current removal status -------------------------
REM  Response is JSON: {"requested":bool,"unlocked":bool,...,"remainingMs":N}
for /f "usebackq delims=" %%R in (`powershell -NoProfile -Command ^
  "try { $r = Invoke-RestMethod -Uri '%ORIGIN%/removal' -TimeoutSec 5; if ($r.unlocked) {'UNLOCKED'} elseif ($r.requested) {'WAIT ' + [int][math]::Ceiling($r.remainingMs/3600000)} else {'NONE'} } catch { 'NOSVC' }"`) do set "STATUS=%%R"

if "%STATUS%"=="NOSVC" (
    echo   [!] Could not reach the FocusLock service to check the cooldown.
    echo       The service may be starting - wait a moment and run this again.
    pause
    exit /b 1
)

if "%STATUS%"=="NONE" (
    echo   Starting the 7-day removal cooldown now.
    powershell -NoProfile -Command "try { Invoke-RestMethod -Uri '%ORIGIN%/removal/request' -Method Post -TimeoutSec 5 | Out-Null } catch {}"
    echo(
    echo   FocusLock will KEEP BLOCKING for the next 7 days.
    echo   Come back and run this again after that to finish removing it.
    echo   To stop the removal, open FocusLock and click "Cancel removal".
    echo(
    pause
    exit /b 0
)

echo %STATUS% | findstr /b "WAIT" >nul
if not errorlevel 1 (
    for /f "tokens=2" %%H in ("%STATUS%") do set "HRS=%%H"
    echo   Removal is pending but the cooldown has NOT elapsed yet.
    echo   About !HRS! hour^(s^) remain. FocusLock stays fully active until then.
    echo(
    echo   Run this again once the 7 days are up, or cancel from the app.
    echo(
    pause
    exit /b 0
)

REM --- STATUS == UNLOCKED: cooldown elapsed, proceed with real removal ---------
echo   The 7-day cooldown has elapsed. Removing FocusLock's background pieces...
echo(

echo   Removing scheduled tasks...
schtasks /Delete /TN "%TASK_GUARD%" /F >nul 2>nul
schtasks /Delete /TN "%TASK_WATCH%" /F >nul 2>nul
schtasks /Delete /TN "%TASK_LOGON%" /F >nul 2>nul

REM  Stop the elevated supervisor FIRST. It re-launches the service within ~20s,
REM  so killing only the service left FocusLock running after "uninstall".
echo   Stopping the guardian supervisor...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*supervisor.cjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul

echo   Stopping the service on port 47615...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :47615 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>nul
)

if exist "%VBS%" del /f /q "%VBS%" >nul 2>nul
if exist "%STARTUP%\FocusLock.vbs" del /f /q "%STARTUP%\FocusLock.vbs" >nul 2>nul
REM  Remove the deployed guardian (code, Electron runtime, logs). Your rules and
REM  stats in %USERPROFILE%\.focuslock are left in place.
if exist "%DEPLOY%\supervisor.cjs" rd /s /q "%DEPLOY%" >nul 2>nul

echo(
echo   Done. FocusLock's always-on protection has been removed.
echo   (Disable the FocusLock browser extension at chrome://extensions as well.)
echo(
pause
exit /b 0

REM ---------------------------------------------------------------------------
:ensure_service
REM  Start the service hidden if it is not answering, then wait briefly for it.
powershell -NoProfile -Command "try { Invoke-RestMethod -Uri '%ORIGIN%/health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 goto :eof
REM  Old per-user installs use the watchdog VBS; elevated installs use the
REM  guardian launcher in %LOCALAPPDATA%\FocusLock.
if exist "%VBS%" wscript "%VBS%"
if exist "%DEPLOY%\guardian-launch.vbs" wscript "%DEPLOY%\guardian-launch.vbs"
for /l %%i in (1,1,30) do (
    powershell -NoProfile -Command "try { Invoke-RestMethod -Uri '%ORIGIN%/health' -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
    if not errorlevel 1 goto :eof
    timeout /t 1 >nul
)
goto :eof

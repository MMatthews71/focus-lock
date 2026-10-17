@echo off
REM ============================================================================
REM  FocusLock - install the ELEVATED always-on guardian
REM
REM  Why elevated: a normal (unelevated) process cannot force-close a program
REM  that runs at a higher integrity level. Games launched elevated - or via an
REM  elevated launcher - shrug off `taskkill /F`. Running the guardian with
REM  admin rights is what lets it actually close them.
REM
REM  What this does (needs admin - it self-elevates):
REM    1. Builds the core + service, and deploys them into %LOCALAPPDATA%.
REM    2. Copies the supervisor + its hidden launcher into the deploy folder.
REM    3. Removes the OLD unelevated launchers (Startup-folder VBS + old tasks)
REM       so there is exactly ONE authoritative, elevated guardian.
REM    4. Registers a Scheduled Task that runs the guardian with HIGHEST
REM       privileges every minute (so it starts ~1 min after login and is
REM       revived within ~1 min if it - or the supervisor - ever dies).
REM    5. Starts it now.
REM
REM  Remove it with uninstall-background.bat (7-day cooldown still applies).
REM ============================================================================

REM --- self-elevate ----------------------------------------------------------
net session >nul 2>&1
if %errorlevel% NEQ 0 (
    echo   Requesting administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

setlocal
cd /d "%~dp0"

set "REPO=%~dp0"
set "DEPLOY=%LOCALAPPDATA%\FocusLock"
set "TASK=FocusLock Guardian"

echo(
echo   FocusLock - elevated guardian install
echo   =====================================
echo(

REM --- 1. Build core + service ----------------------------------------------
echo   Building core + service...
call npm run build --workspace @focuslock/core
if errorlevel 1 goto :buildfail
call npm run build --workspace @focuslock/service
if errorlevel 1 goto :buildfail
if not exist "%REPO%packages\service\dist\index.js" (
    echo   [X] Service build missing ^(packages\service\dist\index.js^).
    pause
    exit /b 1
)

REM --- 2. Deploy built code into %LOCALAPPDATA% ------------------------------
echo   Deploying to "%DEPLOY%"...
if not exist "%DEPLOY%\service" mkdir "%DEPLOY%\service"
if not exist "%DEPLOY%\node_modules\@focuslock\core\dist" mkdir "%DEPLOY%\node_modules\@focuslock\core\dist"
if not exist "%DEPLOY%\overlay" mkdir "%DEPLOY%\overlay"
copy /y "%REPO%packages\service\dist\*.js"      "%DEPLOY%\service\" >nul
copy /y "%REPO%packages\service\dist\*.js.map"  "%DEPLOY%\service\" >nul 2>nul
xcopy /y /e /q "%REPO%packages\core\dist\*"     "%DEPLOY%\node_modules\@focuslock\core\dist\" >nul
xcopy /y /e /q "%REPO%apps\overlay\*"           "%DEPLOY%\overlay\" >nul

REM  Deploy the Electron runtime the block screen needs. Without electron.exe
REM  next to the overlay, a blocked app (e.g. Terraria) is closed WITHOUT ever
REM  showing the block screen — so this copy is not optional.
if not exist "%REPO%node_modules\electron\dist\electron.exe" (
    echo   Electron runtime not found - fetching it ^(npm install^)...
    call npm install --no-audit --no-fund
)
if exist "%REPO%node_modules\electron\dist\electron.exe" (
    echo   Deploying Electron runtime for the block screen...
    if not exist "%DEPLOY%\electron" mkdir "%DEPLOY%\electron"
    xcopy /y /e /q "%REPO%node_modules\electron\dist\*" "%DEPLOY%\electron\" >nul
) else (
    echo   [X] Electron runtime is still missing - the app block screen cannot be shown.
    echo       Run setup.bat ^(or double-click FocusLock.vbs once^) to download Electron,
    echo       then re-run this installer.
    pause
    exit /b 1
)

REM --- 3. Copy the supervisor + hidden launcher -----------------------------
echo   Installing supervisor + launcher...
copy /y "%REPO%deploy\supervisor.cjs"       "%DEPLOY%\supervisor.cjs"       >nul
copy /y "%REPO%deploy\guardian-launch.vbs"  "%DEPLOY%\guardian-launch.vbs"  >nul
copy /y "%REPO%deploy\register-task.ps1"    "%DEPLOY%\register-task.ps1"    >nul
set "LAUNCH=%DEPLOY%\guardian-launch.vbs"

REM --- 4. Remove OLD unelevated launchers -----------------------------------
echo   Removing old unelevated launchers...
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%STARTUP%\FocusLock.vbs" del /f /q "%STARTUP%\FocusLock.vbs" >nul 2>nul
schtasks /Delete /TN "FocusLock Service Watchdog" /F >nul 2>nul
schtasks /Delete /TN "FocusLock Service Startup"  /F >nul 2>nul

REM  Stop any running unelevated supervisor + service so the elevated one owns
REM  the port. (Once elevated, the service cannot be killed by unelevated tools.)
echo   Stopping any running guardian...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :47615 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>nul
REM  Kill any running supervisor, including one that is wedged (alive but not
REM  restarting the service). Elevated, so we can read command lines and reach it.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*supervisor.cjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul
if exist "%DEPLOY%\supervisor.pid" del /f /q "%DEPLOY%\supervisor.pid" >nul 2>nul
if exist "%DEPLOY%\supervisor.hb"  del /f /q "%DEPLOY%\supervisor.hb"  >nul 2>nul

REM --- 5. Register the elevated guardian task + start it ---------------------
echo   Registering elevated task "%TASK%"...
schtasks /Delete /TN "%TASK%" /F >nul 2>nul
REM  Registration lives in register-task.ps1 (it needs MultipleInstances=Parallel,
REM  which schtasks cannot set). The script also starts the guardian immediately.
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEPLOY%\register-task.ps1" -Launch "%LAUNCH%"
if errorlevel 1 (
    echo   [X] Could not create the elevated task.
    pause
    exit /b 1
)

echo(
echo   Done. FocusLock's guardian now runs with HIGHEST privileges:
echo     - starts within ~1 minute of login,
echo     - is revived within ~1 minute if it ever stops, and
echo     - can force-close blocked apps even when they run elevated.
echo(
echo   Verify any time with:  schtasks /Query /TN "%TASK%"
echo(
pause
endlocal
exit /b 0

:buildfail
echo   [X] Build failed. Fix the errors above and re-run.
pause
exit /b 1

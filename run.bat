@echo off
REM ============================================================================
REM  FocusLock - verbose launcher (shows a console with logs)
REM
REM  For the normal, NO-TERMINAL experience, double-click FocusLock.vbs instead.
REM  Use this script only when you want to see build output and app logs in a
REM  console (e.g. for troubleshooting).
REM
REM  Fast by default: it only builds when something is actually missing. To force
REM  a clean rebuild, run:  run.bat rebuild
REM
REM  Requires Node.js >= 18   (https://nodejs.org)
REM ============================================================================

setlocal
cd /d "%~dp0"

REM Build only when needed. If the UI bundle, the service, the core build, or the
REM Electron binary is missing (or "rebuild" was passed), run setup; otherwise go
REM straight to launching. This is what stops every launch taking minutes.
set "NEED_BUILD="
if /i "%~1"=="rebuild" set "NEED_BUILD=1"
if not exist "%~dp0apps\desktop\dist\index.html" set "NEED_BUILD=1"
if not exist "%~dp0packages\service\dist\index.js" set "NEED_BUILD=1"
if not exist "%~dp0packages\core\dist\index.js" set "NEED_BUILD=1"
if not exist "%~dp0node_modules\electron" set "NEED_BUILD=1"

if defined NEED_BUILD (
    call "%~dp0setup.bat" rebuild
    if errorlevel 1 exit /b 1
) else (
    echo   Already built - launching. ^(Run "run.bat rebuild" to force a rebuild.^)
)

echo(
echo   Launching FocusLock (verbose)...
echo   The app starts the background service on 127.0.0.1:47615 if needed.
echo(
echo   Tip: to load the browser extension, open chrome://extensions, enable
echo   Developer mode, choose "Load unpacked", and select the apps\extension folder.
echo(

REM Run Electron in this console so you can see its logs.
call npm run electron --workspace @focuslock/desktop

echo(
echo   FocusLock window closed. The background service may still be running
echo   in the background (by design). You can close this window.
echo(
pause
endlocal

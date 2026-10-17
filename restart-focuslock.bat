@echo off
REM ============================================================================
REM  FocusLock - force restart
REM
REM  Stops the background service (even an old one left running from a previous
REM  version) and relaunches the app so the latest code takes effect. Use this
REM  if the app seems to be enforcing stale rules.
REM ============================================================================

cd /d "%~dp0"

echo Stopping any FocusLock service on port 47615...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :47615 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>nul
    echo   stopped process %%a
)

echo Relaunching FocusLock...
start "" wscript "%~dp0FocusLock.vbs"
exit /b 0

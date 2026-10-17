@echo off
REM ============================================================================
REM  FocusLock doctor - one-click diagnostic
REM
REM  Double-click this when a blocked app did NOT show the block screen. It checks
REM  the service, your rules, whether the app is actually blocked, and whether the
REM  block-screen pieces are installed, then prints a plain-English verdict.
REM
REM  Optional: pass the game's process name, e.g.  focuslock-doctor.bat tModLoader.exe
REM  (defaults to Terraria.exe).
REM ============================================================================

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo   [X] Node.js was not found on your PATH. Install it from https://nodejs.org
    pause
    exit /b 1
)

node "%~dp0deploy\doctor.cjs" %*

echo(
pause
endlocal

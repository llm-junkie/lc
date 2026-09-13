@echo off
REM ============================================================
REM  run_dev.cmd — Tauri dev build
REM  Usage: run_dev.cmd [--no-pause]
REM ============================================================

setlocal
cd /d "%~dp0"
set "EXIT_CODE=0"

echo.
echo [1/2] Installing or updating npm dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed.
    set "EXIT_CODE=1"
    goto :end
)

echo.
echo [2/2] Staging development resources and starting Tauri...
REM npm run tauri:dev owns development resource staging; keep that contract in
REM package.json so direct use and this wrapper behave alike.
call npm run tauri:dev
if errorlevel 1 (
    echo ERROR: Tauri dev failed.
    set "EXIT_CODE=1"
    goto :end
)

:end
echo.
if /i not "%~1"=="--no-pause" pause
endlocal & exit /b %EXIT_CODE%

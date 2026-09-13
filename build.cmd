@echo off
REM ============================================================
REM  build.cmd — clean + production Tauri build
REM  Usage: build.cmd [--no-pause]
REM ============================================================

setlocal
cd /d "%~dp0"
set "EXIT_CODE=0"

echo.
echo [1/4] Cleaning previous build artifacts...
call clean.cmd --no-pause
if errorlevel 1 (
    echo ERROR: cleanup failed.
    set "EXIT_CODE=1"
    goto :end
)

echo.
echo [2/4] Installing exact npm dependencies from package-lock.json...
call npm ci
if errorlevel 1 (
    echo ERROR: npm ci failed.
    set "EXIT_CODE=1"
    goto :end
)

echo.
echo [3/4] Validating release license policy (no artifacts generated)...
call npm run licenses:check
if errorlevel 1 (
    echo ERROR: release license policy check failed.
    set "EXIT_CODE=1"
    goto :end
)

echo.
echo [4/4] Building Tauri and its frontend (production)...
REM npm run tauri:build owns frontend preparation, production notices,
REM verification, and the release-config Tauri invocation.
call npm run tauri:build
if errorlevel 1 (
    echo ERROR: Tauri build failed.
    set "EXIT_CODE=1"
    goto :end
)

echo.
echo ============================================================
echo  BUILD SUCCESSFUL
echo  Output root: src-tauri\target\release\
echo ============================================================

:end
echo.
if /i not "%~1"=="--no-pause" pause
endlocal & exit /b %EXIT_CODE%

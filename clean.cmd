@echo off
REM ============================================================
REM  clean.cmd — clean
REM  Usage: clean.cmd [--no-pause]
REM ============================================================

setlocal
cd /d "%~dp0"
set "CLEAN_FAILED=0"

echo.
echo Cleaning previous build artifacts...
for %%D in (
    node_modules
    dist
    dist-ssr
    dist-portable
    release
    build
    out
    coverage
    htmlcov
    test-results
    playwright-report
    logs
    ".cache"
    ".parcel-cache"
    ".turbo"
    ".webpack"
    ".vite"
    ".vite-temp"
    ".nyc_output"
    ".npm"
    ".pnpm-store"
    ".yarn-cache"
    ".next"
    ".nuxt"
    ".svelte-kit"
    "playwright\.cache"
    "public\excalidraw-assets"
    "src-tauri\target"
    "src-tauri\gen"
    "src-tauri\WixTools"
) do (
    if exist "%%~D" (
        rmdir /s /q "%%~D"
        if exist "%%~D" (
            echo ERROR: could not remove %%~D.
            set "CLEAN_FAILED=1"
        ) else (
            echo        %%~D removed.
        )
    )
)

REM Extracted 7z fixture outputs under scripts\fixtures\ (disposable,
REM gitignored). The committed .7z archives and the tracked docs-sync-check
REM corpus are kept — only the extract-on-demand dirs are removed (regenerated
REM by the test suite via scripts\fixture-lc-archives.mjs).
for /d %%D in (scripts\fixtures\*) do (
    if /i not "%%~nxD"=="docs-sync-check" (
        rmdir /s /q "%%~D"
        if exist "%%~D" (
            echo ERROR: could not remove %%~D.
            set "CLEAN_FAILED=1"
        ) else (
            echo        %%~D removed.
        )
    )
)

REM Generated files kept inside tracked source directories. Delete them
REM individually so public/icons and src-tauri/resources/.gitignore survive.
for %%F in (
    "src-tauri\resources\models-cache.json"
    "src-tauri\resources\models-dev.json"
    "src-tauri\resources\spine-builder.html"
    "src-tauri\resources\LICENSE"
    "src-tauri\resources\NOTICE"
    "src-tauri\resources\THIRD_PARTY_LICENSES.md"
    "THIRD_PARTY_LICENSES.md"
    "legal\EXCALIDRAW_FONTS_LICENSES.md"
    "src-tauri\cargo_check.txt"
    ".eslintcache"
    ".stylelintcache"
    ".prettiercache"
    "junit.xml"
) do (
    if exist "%%~F" (
        del /f /q "%%~F" >nul 2>&1
        if exist "%%~F" (
            echo ERROR: could not remove %%~F.
            set "CLEAN_FAILED=1"
        ) else (
            echo        %%~F removed.
        )
    )
)

del /s /q *.tsbuildinfo >nul 2>&1
echo        *.tsbuildinfo removed.
del /s /q *.log >nul 2>&1
del /s /q *.log.* >nul 2>&1
echo        *.log and *.log.* removed.
del /q .dev-*.out .build-*.out .tauri-*.out *.lcov npm-debug.log* yarn-debug.log* yarn-error.log* pnpm-debug.log* >nul 2>&1
echo        transient reports and debug output removed.

REM Intentionally retained: LICENSE and NOTICE are source legal files.
if "%CLEAN_FAILED%"=="0" (
    echo        Done.
    echo.
    echo ============================================================
    echo  CLEAN SUCCESSFUL
    echo ============================================================
) else (
    echo.
    echo ============================================================
    echo  CLEAN FAILED - one or more paths remain
    echo ============================================================
)
if /i not "%~1"=="--no-pause" pause
endlocal & exit /b %CLEAN_FAILED%

#!/usr/bin/env bash
# ============================================================
#  build.sh — clean + production Tauri build (Linux/macOS)
#  Usage: bash build.sh [--no-pause]
# ============================================================

set -euo pipefail
cd -- "$(dirname -- "$0")"

NO_PAUSE=false
if [[ "${1:-}" == "--no-pause" ]]; then
  NO_PAUSE=true
fi

pause_if_needed() {
  if [[ "$NO_PAUSE" == false && -t 0 ]]; then
    read -r -p "Press Enter to close..."
  fi
}

fail() {
  echo "ERROR: $1"
  pause_if_needed
  exit 1
}

echo ""
echo "[1/4] Cleaning previous build artifacts..."
bash clean.sh --no-pause || fail "cleanup failed."

echo ""
echo "[2/4] Installing exact npm dependencies from package-lock.json..."
npm ci || fail "npm ci failed."

echo ""
echo "[3/4] Validating release license policy (no artifacts generated)..."
npm run licenses:check || fail "release license policy check failed."

echo ""
echo "[4/4] Building Tauri and its frontend (production)..."
# npm run tauri:build owns frontend preparation, production notices,
# verification, and the release-config Tauri invocation.
npm run tauri:build || fail "Tauri build failed."
# build linux installer deb only:
# npm run tauri:build -- --bundles deb || fail "Tauri build failed."
# for linux installer rpm only:
# npm run tauri:build -- --bundles rpm || fail "Tauri build failed."

echo ""
echo "============================================================"
echo " BUILD SUCCESSFUL"
echo " Output root: src-tauri/target/release/"
echo "============================================================"

pause_if_needed

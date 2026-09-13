#!/usr/bin/env bash
# ============================================================
#  run_dev.sh — Tauri dev build (Linux/macOS)
#  Usage: bash run_dev.sh [--no-pause]
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
echo "[1/2] Installing or updating npm dependencies..."
npm install || fail "npm install failed."

echo ""
echo "[2/2] Staging development resources and starting Tauri..."
# npm run tauri:dev owns development resource staging; keep that contract in
# package.json so direct use and this wrapper behave alike.
npm run tauri:dev || fail "Tauri dev failed."

pause_if_needed

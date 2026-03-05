#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${HOME}/Applications/Heiwa DJ.app"
DESKTOP_RUNTIME_DIR="${ROOT_DIR}/packages/desktop/runtime"
TIMEOUT_SECONDS="${HEIWA_VALIDATION_TIMEOUT_SECONDS:-90}"

STATE_PATHS=(
  "${HOME}/Library/Application Support/heiwa-dj"
  "${HOME}/Library/Application Support/Heiwa DJ"
  "${HOME}/Library/Caches/heiwa-dj"
  "${HOME}/Library/Caches/Heiwa DJ"
  "${HOME}/Library/Preferences/ltd.heiwa.dj.plist"
  "${HOME}/Library/Saved Application State/ltd.heiwa.dj.savedState"
  "${HOME}/Library/Logs/Heiwa DJ"
)

wait_for_url() {
  local url="$1"
  local name="$2"
  local retries=$(( TIMEOUT_SECONDS * 2 ))
  while (( retries > 0 )); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "${name} ready: ${url}"
      return 0
    fi
    sleep 0.5
    retries=$(( retries - 1 ))
  done
  echo "Timed out waiting for ${name}: ${url}" >&2
  return 1
}

echo "[1/5] Stopping running Heiwa DJ processes..."
pnpm --dir "${ROOT_DIR}" heiwa:stop

echo "[2/5] Removing app bundle and local Heiwa DJ state..."
if [[ -d "${APP_BUNDLE}" ]]; then
  rm -rf "${APP_BUNDLE}"
  echo "Removed app bundle: ${APP_BUNDLE}"
else
  echo "App bundle not present: ${APP_BUNDLE}"
fi

for path in "${STATE_PATHS[@]}"; do
  if [[ -e "${path}" ]]; then
    rm -rf "${path}"
    echo "Removed: ${path}"
  fi
done

if [[ -d "${DESKTOP_RUNTIME_DIR}" ]]; then
  rm -rf "${DESKTOP_RUNTIME_DIR}"
  echo "Removed runtime cache: ${DESKTOP_RUNTIME_DIR}"
fi

echo "[3/5] Building and reinstalling Heiwa DJ.app..."
pnpm --dir "${ROOT_DIR}" heiwa:app:build

echo "[4/5] Launching packaged app..."
open -a "${APP_BUNDLE}"

echo
echo "Manual gate: in Heiwa DJ Setup Wizard, ensure required checks pass, then click 'Launch Heiwa DJ'."
if [[ -t 0 ]]; then
  read -r -p "Press Enter after launching Heiwa DJ from the wizard..."
else
  echo "Non-interactive shell detected; waiting for launch-triggered endpoints."
fi

echo "[5/5] Verifying runtime endpoints..."
wait_for_url "http://localhost:3001/api/status" "API"
wait_for_url "http://localhost:4321/engine" "Engine"

echo "API response:"
curl -fsS "http://localhost:3001/api/status"
echo
echo "Engine response header:"
curl -fsS "http://localhost:4321/engine" | head -n 1

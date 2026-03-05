#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="${ROOT_DIR}/packages/desktop/release"
DEST_APP="${HOME}/Applications/Heiwa DJ.app"

mkdir -p "${HOME}/Applications"

APP_SOURCE="$(find "${RELEASE_DIR}" -maxdepth 3 -type d -name 'Heiwa DJ.app' | head -n 1 || true)"
if [[ -z "${APP_SOURCE}" ]]; then
  echo "No packaged app found under ${RELEASE_DIR}."
  echo "Run: pnpm desktop:build"
  exit 1
fi

rm -rf "${DEST_APP}"
cp -R "${APP_SOURCE}" "${DEST_APP}"

echo "Installed: ${DEST_APP}"

DMG_PATH="$(find "${RELEASE_DIR}" -maxdepth 2 -type f -name 'Heiwa-DJ-*.dmg' | head -n 1 || true)"
if [[ -n "${DMG_PATH}" ]]; then
  echo "DMG: ${DMG_PATH}"
fi

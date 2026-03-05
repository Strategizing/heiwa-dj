#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

MODE="dev"
LOCAL_MODE="0"
EMBEDDED_ENGINE="0"

for arg in "$@"; do
  case "${arg}" in
    --prod)
      MODE="prod"
      ;;
    --local)
      LOCAL_MODE="1"
      ;;
    --embedded)
      EMBEDDED_ENGINE="1"
      ;;
    *)
      echo "Unknown argument: ${arg}"
      echo "Usage: bash scripts/heiwa-start.sh [--prod] [--local] [--embedded]"
      exit 1
      ;;
  esac
done

PIDS=()

cleanup() {
  if [[ ${#PIDS[@]} -gt 0 ]]; then
    echo
    echo "Shutting down Heiwa DJ..."
    for pid in "${PIDS[@]}"; do
      kill "${pid}" 2>/dev/null || true
    done
    wait "${PIDS[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

wait_for_url() {
  local url="$1"
  local name="$2"
  local retries=80

  while (( retries > 0 )); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "${name} ready: ${url}"
      return 0
    fi
    sleep 0.5
    retries=$((retries - 1))
  done

  echo "Timed out waiting for ${name}: ${url}" >&2
  return 1
}

find_server_entry() {
  local candidates=(
    "${ROOT_DIR}/packages/server/dist/packages/server/src/index.js"
    "${ROOT_DIR}/packages/server/dist/src/index.js"
    "${ROOT_DIR}/packages/server/dist/index.js"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -f "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

echo "Clearing existing Heiwa DJ ports..."
bash "${ROOT_DIR}/scripts/heiwa-stop.sh" >/dev/null 2>&1 || true

if [[ "${MODE}" == "prod" ]]; then
  echo "Installing dependencies (if needed)..."
  pnpm install >/dev/null
  echo "Building production artifacts..."
  pnpm build
fi

if [[ "${MODE}" == "dev" ]]; then
  SERVER_ARGS=(--dir "${ROOT_DIR}" --filter server dev --)
  if [[ "${LOCAL_MODE}" == "1" ]]; then
    SERVER_ARGS+=(--local)
    if [[ "${EMBEDDED_ENGINE}" == "1" ]]; then
      SERVER_ARGS+=(--embedded-engine)
    fi
  fi
  HEIWA_DJ_NO_AUTO_OPEN=1 HEIWA_DJ_MODEL_CANDIDATES=qwen2.5-coder:7b pnpm "${SERVER_ARGS[@]}" &
  PIDS+=("$!")
  pnpm --dir "${ROOT_DIR}" --filter ui dev &
  PIDS+=("$!")
else
  SERVER_ENTRY="$(find_server_entry || true)"
  if [[ -z "${SERVER_ENTRY}" ]]; then
    echo "No server build entry found. Run: pnpm build" >&2
    exit 1
  fi
  SERVER_ARGS=()
  if [[ "${LOCAL_MODE}" == "1" ]]; then
    SERVER_ARGS+=(--local)
    if [[ "${EMBEDDED_ENGINE}" == "1" ]]; then
      SERVER_ARGS+=(--embedded-engine)
    fi
  fi
  HEIWA_DJ_SERVE_UI_DIST=1 \
  HEIWA_DJ_NO_AUTO_OPEN=1 \
  HEIWA_DJ_ROOT_DIR="${ROOT_DIR}" \
  HEIWA_DJ_UI_DIST_DIR="${ROOT_DIR}/packages/ui/dist" \
  HEIWA_DJ_MODEL_CANDIDATES=qwen2.5-coder:7b \
  node "${SERVER_ENTRY}" "${SERVER_ARGS[@]}" &
  PIDS+=("$!")
fi

wait_for_url "http://localhost:3001/api/status" "API"

if [[ "${MODE}" == "dev" ]]; then
  wait_for_url "http://localhost:5173" "UI"
  open "http://localhost:5173"
else
  open "http://localhost:3001"
fi

if [[ "${LOCAL_MODE}" == "1" ]]; then
  if [[ "${EMBEDDED_ENGINE}" == "1" ]]; then
    open "http://localhost:4321/engine"
  else
    open "http://localhost:4321"
  fi
else
  open "https://strudel.cc"
  if curl -fsS "http://localhost:3001/snippet" >/tmp/heiwa-snippet.js 2>/dev/null; then
    pbcopy < /tmp/heiwa-snippet.js || true
    echo "Strudel bridge snippet copied to clipboard."
  fi
fi

echo
echo "Heiwa DJ is running."
if [[ "${MODE}" == "dev" ]]; then
  echo "UI: http://localhost:5173"
else
  echo "UI: http://localhost:3001"
fi
echo "API: http://localhost:3001/api/status"
echo "Snippet: http://localhost:3001/snippet"
echo
echo "Keep this terminal open. Press Ctrl+C to stop."

wait

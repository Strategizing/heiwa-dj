#!/usr/bin/env bash
set -euo pipefail

PORTS=(3001 5173 9999 4321)

for port in "${PORTS[@]}"; do
  pids="$(lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "Stopping processes on port ${port}: ${pids}"
    # shellcheck disable=SC2086
    kill ${pids} 2>/dev/null || true
  fi
done

# Give processes a moment to shut down cleanly.
sleep 1

for port in "${PORTS[@]}"; do
  pids="$(lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "Force stopping lingering processes on port ${port}: ${pids}"
    # shellcheck disable=SC2086
    kill -9 ${pids} 2>/dev/null || true
  fi
done

echo "Heiwa DJ ports are clear."

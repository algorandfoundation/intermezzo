#!/usr/bin/env bash
#
# setup_localnet.sh — start AlgoKit LocalNet and sync its genesis values
# into `.env` so pawn signs transactions against the correct chain.
#
# LocalNet generates a fresh genesis hash whenever its data dir is reset,
# so the values committed to `.env` cannot be trusted across runs. This
# script reads the live `genesis-id` / `genesis-hash` from algod and
# writes them into `.env`.
#
# This script is intentionally narrow in scope. It does NOT bring up the
# docker compose stack, initialize Vault, or prefund accounts — see
# `fund_manager.sh` for that.
#
# Usage:
#   ./scripts/setup_localnet.sh
#   SKIP_LOCALNET_START=1 ./scripts/setup_localnet.sh   # assume LocalNet is already up
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

ALGOD_URL="${ALGOD_URL:-http://localhost:4001}"
ALGOD_TOKEN="${ALGOD_TOKEN:-$(printf 'a%.0s' {1..64})}"

log() { printf '\n=== %s ===\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. Start AlgoKit LocalNet and wait for algod.
# ---------------------------------------------------------------------------
if [ "${SKIP_LOCALNET_START:-0}" != "1" ]; then
  log "Starting AlgoKit LocalNet"
  algokit localnet start
fi

log "Waiting for algod at ${ALGOD_URL} to be ready"
for i in $(seq 1 60); do
  if curl -fs -H "X-Algo-API-Token: ${ALGOD_TOKEN}" \
    "${ALGOD_URL}/v2/status" >/dev/null; then
    echo "algod is ready"
    break
  fi
  if [ "${i}" -eq 60 ]; then
    echo "algod failed to become ready" >&2
    exit 1
  fi
  sleep 2
done

# ---------------------------------------------------------------------------
# 2. Sync GENESIS_ID / GENESIS_HASH from the running algod into .env.
# ---------------------------------------------------------------------------
log "Syncing GENESIS_ID / GENESIS_HASH into .env"
PARAMS_JSON="$(curl -fs -H "X-Algo-API-Token: ${ALGOD_TOKEN}" \
  "${ALGOD_URL}/v2/transactions/params")"
GENESIS_ID="$(printf '%s' "${PARAMS_JSON}" | jq -r '.["genesis-id"]')"
GENESIS_HASH="$(printf '%s' "${PARAMS_JSON}" | jq -r '.["genesis-hash"]')"
echo "GENESIS_ID=${GENESIS_ID}"
echo "GENESIS_HASH=${GENESIS_HASH}"

# Render the new .env to a tmp path then overwrite via `cat >`. This only
# requires `.env` itself to be writable (not its parent directory, as
# `sed -i` would — that has been a recurring failure mode on CI runners).
TMP_ENV="$(mktemp)"
awk -v gid="${GENESIS_ID}" -v gh="${GENESIS_HASH}" '
  /^GENESIS_ID=/   {print "GENESIS_ID=" gid;   next}
  /^GENESIS_HASH=/ {print "GENESIS_HASH=" gh;  next}
  {print}
' .env > "${TMP_ENV}"

# Defensively make sure .env is writable by the current user. Previous
# runs with the pawn container can leave `.env` owned by another uid via
# the bind mount.
if [ ! -w .env ] && sudo -n true 2>/dev/null; then
  sudo chown "$(id -u):$(id -g)" .env 2>/dev/null || true
fi
chmod u+w .env || true

cat "${TMP_ENV}" > .env
rm -f "${TMP_ENV}"

echo "Resulting .env GENESIS_* lines:"
grep -E '^GENESIS_(ID|HASH)=' .env
# Fail fast if the values didn't actually land in .env.
grep -qF "GENESIS_ID=${GENESIS_ID}" .env
grep -qF "GENESIS_HASH=${GENESIS_HASH}" .env

log "LocalNet is ready and .env is in sync"

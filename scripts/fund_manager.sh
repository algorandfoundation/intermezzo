#!/usr/bin/env bash
#
# fund_manager.sh — prefund the Vault-managed manager Algorand account on
# the running AlgoKit LocalNet.
#
# Prerequisites:
#   - AlgoKit LocalNet is running (see `setup_localnet.sh`).
#   - Vault has been initialized via `yarn vault:development:init`, which
#     writes the manager address to `manager-address.txt` in the repo root.
#
# E2E tests that create assets / transfer algos from the manager require
# the manager account to have a balance, so this step is needed after a
# fresh LocalNet bring-up.
#
# Usage:
#   ./scripts/fund_manager.sh
#   PREFUND_AMOUNT=2000000000 ./scripts/fund_manager.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

PREFUND_AMOUNT="${PREFUND_AMOUNT:-1000000000}"

log() { printf '\n=== %s ===\n' "$*"; }

if [ ! -f manager-address.txt ]; then
  echo "manager-address.txt not found — run 'yarn vault:development:init' first" >&2
  exit 1
fi
MANAGER_ADDRESS="$(cat manager-address.txt)"
echo "Manager address: ${MANAGER_ADDRESS}"

# Capture the full output before parsing — piping `algokit goal account
# list` directly into `awk '... exit'` closes the pipe early and crashes
# algokit's Python logger with BrokenPipeError (exit 120).
ACCOUNT_LIST="$(algokit goal account list)"
echo "${ACCOUNT_LIST}"

# Pick the highest-balance account from the default wallet as the funder.
# Output format is: `[online]\t<addr>\t<addr>\t<microalgos> microAlgos`.
FUNDER="$(printf '%s\n' "${ACCOUNT_LIST}" \
  | awk -F'\t' 'NF>=4 {gsub(/ microAlgos/, "", $4); if ($4+0 > max) {max=$4+0; addr=$3}} END {print addr}')"
if [ -z "${FUNDER}" ]; then
  echo "Could not determine a funder account from algokit goal account list" >&2
  exit 1
fi
echo "Funder: ${FUNDER}"

log "Sending ${PREFUND_AMOUNT} microAlgos to manager"
algokit goal clerk send \
  --from "${FUNDER}" \
  --to "${MANAGER_ADDRESS}" \
  --amount "${PREFUND_AMOUNT}"

echo "Manager balance after prefund:"
algokit goal account balance --address "${MANAGER_ADDRESS}" || true

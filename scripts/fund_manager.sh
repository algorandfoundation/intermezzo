#!/usr/bin/env bash
#
# fund_manager.sh — prefund the Vault-managed manager Algorand accounts on
# the running AlgoKit LocalNet.
#
# The transit (ed25519) manager identity in `manager-address.txt` is always
# funded: DID/OID4VC deploys and signs with it whichever scheme the wallet
# manager uses. With VAULT_MANAGER_ACCOUNT_TYPE=falcon1024 the wallet
# manager is a *separate* account, in `pq-manager-address.txt`, and is
# funded as well — funding one does not fund the other.
#
# Prerequisites:
#   - AlgoKit LocalNet is running (see `setup_localnet.sh`).
#   - Vault has been initialized via `yarn vault:development:init`, which
#     writes the manager address(es) to the repo root.
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

# A Falcon wallet manager (per `.env`, as vault/development-init.ts reads it)
# is a separate account from the transit identity, so fund it too.
ADDRESS_FILES=(manager-address.txt)
if [ "$(sed -n 's/^VAULT_MANAGER_ACCOUNT_TYPE=//p' .env 2>/dev/null | tail -n1 | tr -d '\042\047')" = falcon1024 ]; then
  if [ ! -f pq-manager-address.txt ]; then
    echo "pq-manager-address.txt not found — run 'yarn vault:development:init' first" >&2
    exit 1
  fi
  ADDRESS_FILES+=(pq-manager-address.txt)
fi

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

for ADDRESS_FILE in "${ADDRESS_FILES[@]}"; do
  MANAGER_ADDRESS="$(cat "${ADDRESS_FILE}")"
  log "Sending ${PREFUND_AMOUNT} microAlgos to ${ADDRESS_FILE} (${MANAGER_ADDRESS})"
  algokit goal clerk send \
    --from "${FUNDER}" \
    --to "${MANAGER_ADDRESS}" \
    --amount "${PREFUND_AMOUNT}"

  echo "Balance after prefund:"
  algokit goal account balance --address "${MANAGER_ADDRESS}" || true
done

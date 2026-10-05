#!/usr/bin/env bash
set -euo pipefail

# Builds the Algorand PQ Vault plugin into the directory Vault loads plugins
# from (bind-mounted at /vault/plugins).
#
# The build platform is taken from the Vault image itself, not from the host:
# Vault execs the plugin inside its own container, so a binary built for a
# different architecture dies before the go-plugin handshake and Vault only
# reports "Failed to read any lines from plugin's stdout".
#
# Run `yarn vault:development:init` afterwards to re-register the new binary's
# sha256 with Vault, otherwise Vault keeps running the previous one.

cd "$(dirname "$0")/.."

VAULT_IMAGE=$(awk '/image: hashicorp\/vault/ {print $2; exit}' docker-compose.yml)
docker pull -q "$VAULT_IMAGE" >/dev/null
PLATFORM=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$VAULT_IMAGE")
echo "Building PQ plugin for ${PLATFORM} (from ${VAULT_IMAGE})"

DOCKER_BUILDKIT=1 docker build --platform "$PLATFORM" --output type=local,dest=volumes/vault/plugins vault/plugin

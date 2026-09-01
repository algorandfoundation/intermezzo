#!/usr/bin/env bash
set -euo pipefail

# Builds the Algorand PQ Vault plugin into the directory Vault loads plugins
# from (bind-mounted at /vault/plugins). No --platform: the host-native build
# matches the architecture the Vault container runs.
# Run `yarn vault:development:init` afterwards to re-register the new binary's
# sha256 with Vault, otherwise Vault keeps running the previous one.

cd "$(dirname "$0")/.."

DOCKER_BUILDKIT=1 docker build --output type=local,dest=volumes/vault/plugins vault/plugin

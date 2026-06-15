#!/usr/bin/env bash
set -euo pipefail

if [ ! -f .env ]; then
  cp .env.template .env;
fi

algokit localnet reset;

docker compose down;
docker compose up -d --build;

docker compose exec pawn yarn run vault:development:init;
./scripts/fund_manager.sh;
docker compose exec pawn sh;

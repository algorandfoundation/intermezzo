docker compose down;
docker compose up -d --build;

docker compose exec pawn yarn run vault:development:init;
docker compose exec pawn sh;

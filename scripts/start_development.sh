docker compose down;
docker compose up -d --build;

# Ensure pawn is running before attempting to exec into it. Fail early if not.
CID=$(docker compose ps -q pawn || true)
if [ -z "$CID" ]; then
	echo "error: pawn container not running after compose up" >&2
	exit 1
fi

docker compose exec pawn yarn run vault:development:init;

# Because Pawn calls the Vault to initialize it, the secrets get created inside
# the pawn container. We need to copy the Sponsor-relevant secrets out to the host 
# so they can be bind-mounted into the sponsor container.
set -e
if [ -n "$CID" ]; then
		mkdir -p .secrets
		# Only copy the sponsor-related helper files to host so Sponsor has the minimum required secrets.
		SPONSOR_FILES=(
			"pawn_sponsor_approle_role_id"
			"pawn_sponsor_approle_secret_id"
			"sponsor_public_key_base64"
			"sponsor_address"
		)
		for f in "${SPONSOR_FILES[@]}"; do
			# check existence and copy per-file to avoid moving unrelated secrets
			if docker compose exec pawn sh -c "[ -f /opt/app/.secrets/$f ]" >/dev/null 2>&1; then
				docker cp ${CID}:/opt/app/.secrets/$f ./.secrets/ || echo "warning: failed to copy $f from pawn container"
				docker compose exec pawn sh -c "rm -f /opt/app/.secrets/$f || true"
			else
				echo "warning: $f not found in pawn container"
			fi
		done
	# adjust ownership so the host user can read the files
	if command -v id >/dev/null 2>&1; then
		HOST_UID=$(id -u)
		HOST_GID=$(id -g)
		chown -R ${HOST_UID}:${HOST_GID} .secrets || true
	fi
	# restart sponsor so it sees the new bind-mounted files (safe even if already running)
	docker compose up -d --no-deps --force-recreate sponsor || docker compose restart sponsor || true
else
	echo "error: pawn container not running; cannot copy .secrets" >&2
	exit 1
fi

docker compose exec pawn sh;
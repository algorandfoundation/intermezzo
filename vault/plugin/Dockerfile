# Builds the Vault secrets-engine plugin binary. The Falcon library is cgo, and
# the Vault image is Alpine, so we build against musl and link statically —
# the binary then runs in the Vault container regardless of its libc.
# The scratch stage exists so `docker build --output` exports only the binary
# (see scripts/build_vault_plugin.sh).
#
# Go is pinned to 1.23 (and go.mod matches): Vault 1.15 injects
# GODEBUG=x509sha1=1 into every plugin process it spawns, and that setting was
# removed in Go 1.24 — a plugin built with a newer toolchain aborts with
# "removed GODEBUG ... set to old value" before the go-plugin handshake, which
# Vault reports as an unhelpful "Failed to read any lines from plugin's stdout".
# Raise this only together with the Vault image.
FROM golang:1.23-alpine AS build

RUN apk add --no-cache build-base

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -ldflags '-s -w -extldflags "-static"' -o /out/vault-plugin-algorand-pq .

FROM scratch
COPY --from=build /out/vault-plugin-algorand-pq /vault-plugin-algorand-pq

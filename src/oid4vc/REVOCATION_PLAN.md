# Credential status and revocation — implementation plan

**Branch:** `feat/credentials-status-and-revoke`
**Scope:** fresh installations; per-session revocation of issued SD-JWT VCs,
with automatic rollover beyond one million allocated status entries.
No migration, legacy `default` alias, or status-free wallet compatibility.

The original phases 0–6 implemented issuance, Vault storage, revocation,
public status JWTs, local resolution, tests, and documentation. The work
below removes the original single-list ceiling and concurrency shortcuts.
The integration branch is intended to ship as one PR to `master`; publishing
or merging that PR is separate from this implementation.

## Implemented

- [x] UUIDv4 list IDs using Node's `crypto.randomUUID()`.
- [x] Automatic rollover with Vault compare-and-set (CAS), including
  competing first allocations, competing rollovers, and restart recovery.
- [x] Authoritative Vault reads before reusing cached signed lists.
- [x] Conditional session appends and durable, resumable status operations.
- [x] Conditional Credo state mirroring so it cannot overwrite revocation.
- [x] Wallet authentication requires an issuer UUID status reference.
- [x] Unit and HTTP tests for races, failures, rollover, and enforcement.
- [x] Separate opt-in million-allocation check and real-Vault validation.

## Data and allocation

Each `StatusListRecord` contains a UUID, `bits: 1`, `size: 16384`,
`nextIndex`, and the compressed bitstring. Zero means valid; one means
revoked. Credentials share the list URI and have distinct numeric indices.

Vault paths:

- `intermezzo/oid4vc/status-lists/records/<uuid>`: public list data.
- `intermezzo/oid4vc/status-lists/active`: private pointer `{ listId }`.
- Issuance sessions retain `statusEntries: [{ listId, idx }, ...]`, audit
  fields, and `statusChange: { id, value, pending, requestedAt, reason? }`.

The allocator CAS-elects an active UUID before creating its list. If the
process stops between those writes, the next allocator creates the same
list with CAS version zero. Once full, the active pointer advances using
its observed version; losing writers reread it. Old lists stay published
and remain mutable for revocation. No index is recycled. Failed issuance
can consume a slot, since a failed response does not prove non-delivery.

One million allocations require 62 lists, or 124 KiB of raw bitstrings
before encoding and record metadata. This is not the storage cost of
sessions, Vault history, or Credo records, and not a throughput guarantee.

## Session concurrency and recovery

1. Issuance finds the local session, reserves an entry, and conditionally
   appends it. A pending status operation or revoked session rejects the
   append, aborting issuance. A competing successful append is included
   when revocation retries its session CAS.
2. Revoke/reactivate conditionally persists its target value and unique
   operation ID before changing bits. A request matching a pending target
   resumes that operation and preserves the original reason. The opposite
   target returns 409 until the pending operation finishes.
3. Entries are grouped by list and updated together. For each CAS attempt,
   the service reads the **list first**, then checks the session operation
   ID, then writes the list conditionally. This ordering fences delayed
   workers: a newer operation either changes the ID before the check or
   changes the list version before the write. Even unchanged bits require
   a CAS commit to preserve that fence.
4. Completion and audit fields are written conditionally. Failure is
   returned to the caller, leaving retryable intent. No bit changes are
   rolled back. Retrying the same endpoint/session finishes partial work,
   including after a process restart. There is no background retry worker.
5. Credo state mirroring uses the same session CAS path. Ordinary session
   `save` is used for initial offer creation, not concurrent mutation.

Reactivation blocks issuance while pending and reopens it on completion.
A successful operation has updated every captured entry and persisted
completion. Verification already in flight may have read status before
that operation committed.

## Publication and freshness

Every local or HTTP status fetch reads the current list from Vault before
using the process's cached JWT. Unchanged `encodedList` reuses the signature;
allocation changes the Vault record version without changing those bits,
so allocation does not force signing. Another instance's committed change
is visible on the next authoritative read. Vault failures fail closed even
when a JWT is cached.

The existing process queue serializes list allocation, list writes, and
JWT construction. Vault CAS provides cross-process correctness. Keep this
queue until measured contention justifies per-list queues.

Public responses preserve exact `application/statuslist+jwt` and
`Cache-Control: no-store`. JWTs contain `iss`, `sub`, and `iat`, and currently
omit `ttl` and `exp`. Independent third-party token caches can delay
revocation. Defining an external token freshness interval is separate work;
adding `exp` requires periodic refresh even when no bits change.

List URLs must remain reachable for the lifetime of their credentials.
The public endpoint never creates lists; unknown/non-UUID IDs return 404.

## Dependency constraints retained

- `@sd-jwt/jwt-status-list` stays pinned at `0.7.2`; no new dependency.
- Credo verifies the credential and status JWT with the credential issuer's
  key, so status JWTs use the manager's Vault transit key.
- `status` is excluded from selective disclosure and written after custom
  claims so metadata cannot override the actual reference.
- W3C `jwt_vc_json` issuance stays status-free: installed Credo does not
  support its credential-status verification.
- The local fetcher wraps a private Credo method. Keep its integration tests
  when updating Credo; it avoids loopback HTTP, not Vault network traffic.
- The existing Vault signing return-type mismatch and W3C custom-claim
  serialization defect remain outside this work.

## Validation

Routine checks:

```sh
yarn test --runInBand
yarn test:e2e --runInBand status-list
yarn lint
yarn format
yarn build
```

Capacity check, deliberately outside the routine test workload:

```sh
STATUS_LIST_CAPACITY_TEST=1 yarn test --runInBand \
  src/oid4vc/status/oid4vc-status.service.spec.ts -t '1,000,001'
```

This runs 1,000,001 allocations through the service and real repositories
with a versioned in-memory Vault transport. It verifies distinct consecutive
indices and 62 lists. It does not issue one million signed credentials.

Real Vault check (disposable local dev Vault only):

```sh
docker run --rm -d --name intermezzo-status-check \
  -p 127.0.0.1:18200:8200 -e VAULT_DEV_ROOT_TOKEN_ID=status-check-only \
  hashicorp/vault:1.15.6 server -dev -dev-listen-address=0.0.0.0:8200
STATUS_LIST_VAULT_URL=http://127.0.0.1:18200 \
STATUS_LIST_VAULT_TOKEN=status-check-only \
  yarn test:e2e --runInBand status-list-vault
docker stop intermezzo-status-check
```

The test creates unique KV/transit mounts and removes only those mounts on
completion. It uses the real Vault client and transit signatures, checks
cross-instance revocation/reactivation, and reports latency for 200 session
creations/allocations with two workers plus 200 warm SD-JWT verifications.
This small synthetic dev-server workload is not a production SLO or a test
of an entire replicated Credo deployment.

### Recorded validation (2026-09-10)

All 28 unit suites passed (270 tests; capacity test separately selected).
The four HTTP integration tests and real-Vault check passed. Focused
coverage for status-list code, session repositories, and wallet guard was
100% lines and 96.66% branches; status-list code alone had 100% branch
coverage. Build, lint, and formatting passed.

The capacity check passed with 1,000,001 allocations across 62 lists.
The isolated Vault 1.15.6 dev-server run passed with real KV/transit:
200 session creations/allocations with two workers measured 185.63/s,
p50 6.28 ms, p95 36.41 ms, and no caller-level 503 retries. The 200 warm
SD-JWT checks measured p50 5.44 ms and p95 7.01 ms. These are one local
synthetic run, not production sizing numbers or full OID4VC issuance latency.

## Deferred, with explicit boundaries

- Session listing still scans all Vault records sequentially. Indexed
  pagination is required before claiming million-session administration.
- No Redis, invalidation bus, new database, or per-list queues. Add only
  when representative production measurements justify them.
- No suspension or device-wide sweep across sessions.
- No credential expiry/list retirement policy. Old list URLs remain served.
- Real deployment sizing still needs its own issuance/verification rates,
  Vault topology, retention settings, and latency targets.

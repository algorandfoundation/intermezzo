# Algorand PQ accounts

Add opt-in Falcon-1024 user accounts without changing existing ed25519 behavior.
Work lives on `feat/pq-accounts`; it is not yet merged to `master`.

## Status

| Increment | Status | Evidence |
| --- | --- | --- |
| 1. Vault Falcon plugin and dev wiring | Done | `f01a566` |
| 2. `VaultService` PQ methods | Done | `372922f` |
| 3. Account creation, resolution, and listing | Done | `2280c87` |
| 4. Transaction signing and fees | Done | `e068545` |
| 5a. Legacy compatibility hardening | Done | `54bff03` |
| 5b. Atomic account-type claim | Implemented; rollout pending | CAS claim and live race test pass |

PQ accounts can be created, listed, resolved, and used for payments, asset
transactions, app calls, and mixed groups. The remaining release work is an
existing-data audit and controlled deployment.

## Compatibility contract

- Ed25519 remains the default. Omitting `account_type` preserves existing create
  behavior.
- User responses add `account_type`; other existing request and response fields
  are unchanged.
- Manager accounts remain ed25519 because the DID/OID4VC stack uses the existing
  Algorand transaction signer interface.
- An existing ed25519 account cannot be converted into a PQ account: its key
  scheme determines its address. PQ accounts must be created fresh with a new
  address.
- Algorand rekeying is the only workaround: a new PQ account can become the
  authorized signer for an existing ed25519 address. That preserves the old
  address but is not a conversion, and this service does not support it.
- Runtime resolution remains transit-first, then PQ on a transit miss. The
  account-type claim coordinates creation only; it does not become the
  source of truth for keys.
- PQ signing uses `algosdk@3.7.0` only for PQ addresses and envelopes. Existing
  transaction building remains on algokit-utils.

## Shipped behavior

- `POST /v1/wallet/user/` accepts optional
  `account_type: "ed25519" | "falcon1024"`.
- Falcon keys are generated and signed inside the custom Vault plugin; private
  key material never enters the application.
- The application derives account type from the Vault mount holding the key.
- PQ transactions receive the required `2 * minFee` surcharge before grouping
  and are encoded with the SDK's canonical `pqsig` envelope.
- Existing ed25519 signing and manager signing retain their previous contracts.
- Creation writes one immutable KV claim with CAS 0 before provisioning a key.
  Same-type retries resume; a competing type receives `409 Conflict`.
- New user IDs are restricted to Vault-safe characters, and claim keys normalize
  case so aliases such as `FOO` and `foo` cannot select different account types.
- Algod 5 / consensus v42 or newer is required for PQ transactions.

## Open risk

The application race is closed, but the guarantee only holds after every writer
runs this code. Before rollout, audit both mounts for an existing duplicate ID
and confirm both mounts are available; then pause or drain old writers during
deployment. Direct Vault writers can still bypass the application claim.

## Remaining plan

- [x] Verify Vault authorization, CAS, tombstone, and key-path behavior.
- [x] Add a CAS-0 immutable account-type claim. Tombstones and malformed records
  fail closed; same-type retries can finish provisioning.
- [x] Preserve caller authorization, validate new IDs, normalize case, and cover
  mixed-type races, retries, and separate service instances.
- [ ] Add a read-only collision and mount-availability audit. Existing accounts
  need no claim backfill because cross-mount checks remain in the create path.
- [ ] Cut over operationally: pause or drain creation writers, run the audit,
  deploy claim-aware instances everywhere, then resume creation. Reads and
  signing may continue during the cutover.

Claims live in Vault KV v2 under
`intermezzo/account-types/<sha256(lowercase(user_id))>` and contain only
`{ schemaVersion, userId, accountType }`. Service credentials manage claims;
caller credentials still authorize actual key creation.

## Verification

Current local verification (2026-09-14):

- `yarn build` passes.
- `yarn lint` and `yarn format` pass.
- 238/238 unit tests pass.
- 46/46 e2e tests pass against the local Vault and Algorand stack, including the
  live concurrent HTTP test and all PQ on-chain scenarios.

## Deferred

- PQ manager accounts.
- Mnemonic export.
- Key rotation and deletion.
- Rekeying existing ed25519 addresses to newly created PQ authorizers.
- Stored PQ key schema versioning and consistency validation.
- Distinguishing a missing PQ key from a missing or misconfigured PQ mount at
  runtime; the rollout audit must still check mount availability explicitly.

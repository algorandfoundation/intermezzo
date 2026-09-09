# Algorand PQ (Falcon-1024) accounts — implementation plan

Adds support for Algorand post-quantum Falcon-1024 accounts to intermezzo, split
into incremental PRs on `feat/pq-accounts`. Vault has no native Falcon support,
so a custom secrets-engine plugin does the key handling.

## Compatibility contract

PQ accounts are **additive**. Every existing caller keeps working untouched, and
the ed25519 code paths stay byte-identical. Concretely:

1. **Ed25519 is the default and stays the default.** `POST /v1/wallet/user/`
   gains one optional field; omitting it produces exactly the account it
   produces today. No existing request body, response body, or endpoint changes
    shape. The only response change is one required added field
   (`account_type`).
2. **The manager stays ed25519, permanently (for now).** The manager key signs
   `DIDAlgoStorage` deployments, pays MBR, and drives the whole credo/oid4vc
   stack through `buildVaultTransactionSigner` ([src/did/vault-signer.ts](../src/did/vault-signer.ts)),
   which is typed against algokit's `TransactionSigner`. Making it PQ means
   re-plumbing that interface for a signature type the SDK cannot express, for
   no user-facing gain. `grep` confirms nothing in `src/did/` or `src/oid4vc/`
   touches *user* keys — so scoping PQ to users costs nothing and keeps the
   identity stack out of the blast radius.
3. **`ChainService.addSignatureToTxn` is not modified.** PQ gets a sibling
   method. An ed25519 transaction cannot regress because of a PQ change.
4. **No migration.** A PQ key derives a different address, so an existing
   ed25519 user cannot "become" PQ — that would be a new account with a new
   address and a zero balance. PQ is opt-in at creation time only. If an
   operator wants a user moved, that is an application-level transfer between
   two accounts, not something this feature does implicitly.
5. **Account type is discovered, not recorded.** The two Vault mounts already
   are the source of truth for which kind of key a `user_id` has. Adding a KV
   record would create a second source of truth that can drift. Resolution
   probes **transit first, PQ on 404** — so the existing ed25519 path pays zero
   extra latency and only the new PQ path pays one wasted round trip.

## Spec facts (verified against go-algorand master source)

- Entropy = 32 bytes (the 25-word mnemonic). Scheme keygen seed =
  `SHA512-256("PQK" || scheme || entropy)` — `cmd/algokey/pq_scheme.go`.
- `scheme` is the 2-byte ASCII identifier `f1` (Falcon-1024, deterministic
  signing profile; `f2` = Falcon-512 is reserved/unused) — `protocol/pq_scheme.go`.
- Falcon keygen is deterministic from the 32-byte seed via
  `github.com/algorand/falcon` v0.1.0 (`GenerateKey`); pk 1793 B, sk 2305 B,
  compressed signature ≤ ~1.2 KB — `crypto/falconWrapper.go`.
- Address digest = `SHA512-256("PQA" || scheme || salt || pk)`; canonical salt =
  lowest byte (0..255 scan) whose digest is NOT decodable as an edwards25519
  point (`edwards25519.Point.SetBytes` fails) — `data/basics/pq_address.go`.
  One pk can control up to 256 addresses, so **salt must be persisted** — more
  than the mnemonic alone.
- Address string = standard 58-char base32 of `digest || SHA512-256(digest)[28:]`.
- Signed txn envelope: `pqsig: {sch: "f1", slt: <salt>, pk: <pubkey>, sig: <sig>}`
  — `data/transactions/pqsig.go`. What gets Falcon-signed is the same raw bytes
  ed25519 signs today (`"TX" || msgpack(txn)`, no pre-hash; Falcon hashes
  internally) — `crypto/falconWrapper.go` `SignBytes`.
- Min fee: base + 2× Falcon contribution = **3,000 µAlgo (3×)**.
- Requires consensus v42 / algod v5.0.0 on the target network.
- Official test vector (`cmd/algokey/pq_test.go`): entropy bytes `{1,2,...,32}` →
  address `ZEJ4BLG3XWAUUZQGCEDJLYIC6D2NCWHRSX5DJMDPE54PXXR7G3PCQTARXU`.

### TypeScript SDK gap — blocker for increment 4

**`algosdk@3.7.0` is a hard prerequisite for increment 4, now installed.**
It supplies the PQ envelope support absent from the project's algokit-utils
version. The compatibility notes below describe why this dependency was added.

`@algorandfoundation/algokit-utils` has **no `pqsig` support** — checked through
`10.0.0-beta.4`, the newest version on npm (the project is on `10.0.0-beta.2`).
`SignedTransaction` is still `{txn, sig?, msig?, lsig?, authAddress?}`
(`packages/transact/src/transactions/signed-transaction.d.ts`) and
`encodeSignedTransaction` cannot emit the field. The exported
`FalconSignatureStruct` / `FalconVerifier` belong to the state-proof merkle
signature scheme and are unrelated. Upgrading algokit-utils does not help; it has
to come from somewhere else.

`algosdk@3.7.0` (npm `latest`) has the full feature, added for consensus v42:

- `SignedTransaction({txn, pqsig})` and `EncodedPQSig {sch, slt, pk, sig}`,
  emitted through the SDK's own canonical schema encoder
- `addressFromPQKey(schemeBytes, publicKey) -> {address, salt}` — the same
  derivation (domain separation, salt scan, base32) the Vault plugin implements
- `addressFromPQSig(pqsig)`
- `addressWithSignersFromRawPQSigner({pqScheme, pqPublicKey, pqSigner})`, where
  `pqSigner` is an async `(bytesToSign) => Promise<signature>` callback — the
  shape of a remote signer, i.e. a `VaultService.pqSign` call
- `emptyTxnSigner`, which attaches a pqsig envelope with empty signature bytes so
  that `simulate` with `allowEmptySignatures` makes algod derive the authorizer
  and charge the real post-quantum fee — a fee oracle that costs no Falcon
  signature (see the fee note in increment 4)

The two SDKs interoperate at the byte level, which is what makes this cheap:
encoded transaction bytes go in and out, so no second transaction model enters
the codebase. Verified against the real packages:

- `algosdk.decodeUnsignedTransaction` accepts the output of algokit's
  `encodeTransaction` with the 2-byte `"TX"` prefix stripped, and
  `encodeUnsignedTransaction` re-encodes it byte-identically
- algosdk's `txn.bytesToSign()` equals algokit's `encodeTransaction` output
  exactly, prefix included — so the Falcon signing input is the same bytes the
  ed25519 path already signs
- an ed25519 `SignedTransaction` encoded by algosdk is byte-identical to one
  encoded by algokit-utils, so nothing on the existing path can regress if it
  ever routes through the new code
- `addressFromPQKey` and `addressFromPQSig` agree with each other and with the
  plugin's derivation

So the envelope is **not** assembled by hand and `algorand-msgpack` is **not**
promoted to a direct dependency. Both were the previous plan of record and are
now dropped: hand-rolling canonical msgpack for a money path when the SDK's own
schema encoder is available is the wrong trade.

Scope of the new dependency: `algosdk` is used **only** for the PQ envelope and
the PQ address helpers. Transaction building, grouping and encoding stay on
algokit-utils. algokit-utils v10 decoupled from algosdk deliberately, and this
must not become a route back to a dual-SDK codebase.

## Increment 1: Vault secrets-engine plugin + dev wiring

**Status**: done (commit `f01a566`). Verified against the running dev stack — the
plugin loads, creates, reads and signs, keys survive a Vault restart
byte-identically, and the full e2e suite passes 29/29.

Go plugin `vault/plugin/` (module `intermezzo/vault-plugin-algorand-pq`), built
on `hashicorp/vault/sdk` + `github.com/algorand/falcon` (cgo) +
`filippo.io/edwards25519`. API mirrors transit so app-side changes later are a
path + response-parse change:

- `POST {mount}/keys/{name}` — idempotent create: 32 B entropy from
  `crypto/rand`, derive Falcon keypair + canonical salt, persist. Response
  `{data: {scheme, salt, public_key (b64), address}}`.
- `GET {mount}/keys/{name}` — same shape; 404 if missing.
- `POST {mount}/sign/{name}` body `{input: <b64>}` — compressed Falcon
  signature: `{data: {signature: <b64>}}`. Caller owns the "TX" prefix, exactly
  as with transit today. No `vault:v1:` envelope.
- `LIST {mount}/keys`.
- No delete/rotate/export/versioning (matches transit `allow_deletion: false`
  usage).

Storage per key at `keys/<name>` (barrier-encrypted):
`{entropy, salt, public_key, private_key}`. Entropy is the root secret (future
mnemonic export); salt/pk must persist; private key is cached because deriving
it costs ~17ms against ~4ms to sign.

Wiring: static musl build via docker (`scripts/build_vault_plugin.sh` →
`volumes/vault/plugins/`, host-native arch), compose adds `plugin_directory`,
the plugins volume and a container-reachable `api_addr` to the vault service.

> **Toolchain pin**: the plugin builds with Go 1.23, not the latest release.
> Vault 1.15.6 injects `GODEBUG=x509sha1=1` into every plugin process it spawns
> (regardless of the container's own environment), and Go removed that setting
> in 1.24 — a plugin built with a newer toolchain aborts during runtime init,
> which Vault reports only as "Failed to read any lines from plugin's stdout".
> Raise the pin in `vault/plugin/Dockerfile`, `go.mod` and CI only together with
> the Vault image.

`vault/development-init.ts` registers the plugin in the catalog by semantic
version and sha256, pins that version at the `pawn/pq-users` mount, reloads an
existing mount, then verifies the catalog and running version/SHA (skips with a
warning if the binary isn't built). The backend self-reports the version from
`vault/plugin/VERSION`. `TLSProviderFunc` is intentionally omitted: this plugin
targets the pinned Vault 1.15.6 deployment and does not support pre-AutoMTLS
Vault servers. Policies are already in place: users get
`pawn/pq-users/keys/*` create/read/update; managers additionally list + sign.
CI runs `go test` natively and builds the plugin before `docker compose up`.

### Tests

Go (`cd vault/plugin && go test -race ./...`, also run in CI):

- the official `algokey` vector — entropy `{1..32}` must derive
  `ZEJ4BLG3XWAUUZQGCEDJLYIC6D2NCWHRSX5DJMDPE54PXXR7G3PCQTARXU`, pinning the
  domain separation, scheme bytes, salt scan and address encoding
- create/read/list/sign round-trip, idempotent create, delete unsupported,
  unknown key and undecodable input rejected
- a second backend instance reading a key written by the first — the in-process
  equivalent of a Vault restart, so nothing a caller depends on can live only in
  memory
- concurrent creates of one name all reporting the address that was stored
  (fails without the create mutex)

End-to-end (`test/app.e2e-spec.ts`, "PQ accounts" describe block) against the
real Vault mount, since no service endpoint exposes PQ accounts yet: the
returned address is re-derived independently in TypeScript from the public key
and salt, create is idempotent, signatures are Falcon-sized, and the user
AppRole can create but gets 403 on sign while the manager succeeds.

## Increment 2: `VaultService` PQ methods

**Status**: done. Verified against the running dev stack — create/read/sign/list
round-trip through the real mount, create is idempotent, a miss returns
`undefined`, signatures come back as raw 1226-byte buffers, and the user AppRole
is denied on sign while the manager succeeds. Unit suite 201/201.

Pure addition — no existing method is touched.

```ts
export type PqKey = { scheme: string; salt: number; publicKey: Buffer; address: string };

pqCreateKey(keyName, token): Promise<PqKey>   // POST {mount}/keys/{name}
pqGetKey(keyName, token): Promise<PqKey | undefined>  // GET, undefined on 404
pqSign(keyName, data, token): Promise<Buffer> // POST {mount}/sign/{name}
pqListKeys(token): Promise<string[]>          // LIST, [] on 404
```

Mount path from a new `VAULT_PQ_USERS_PATH=pawn/pq-users` in `.env.template`,
read the same way the transit paths are (`configService.get`), but falling back
to `pawn/pq-users` the way `getKvMount` falls back to `secret`. The fallback is
not cosmetic: `development-init.ts` only seeds `.env` when the file does not
already exist, so every existing developer checkout would otherwise resolve an
undefined mount.

The value stays hard-coded in `test/app.e2e-spec.ts:18` and
`vault/development-init.ts:20`, contrary to the original plan. `development-init`
is what *writes* `.env` from the template, so it cannot read the variable it
creates — which is why its transit paths are literals too. The e2e suite hard-codes
its transit siblings the same way. Converting only the PQ constant would leave
two conventions in one file for no gain.

Two deliberate differences from the transit wrappers, both because the plugin
does not imitate transit's quirks:

- **No `vault:v1:` envelope to strip.** `pqSign` returns raw signature bytes.
  `decodeVaultSignature` in [src/did/vault-signer.ts](../src/did/vault-signer.ts)
  must not be used on them — it asserts a 64-byte ed25519 length and would
  reject every Falcon signature. It stays ed25519-only.
- **`pqGetKey` returns `undefined` on 404** rather than throwing, because the
  account-type probe in increment 3 uses a miss as a normal answer. The transit
  `getKey` keeps throwing, unchanged.

**Tests**: unit tests in the existing axios-mock pattern
(`src/vault/vault.service.spec.ts`) — response parsing, the 404-to-`undefined`
path, and that the signing input is passed through base64 unmodified.

## Increment 3: user account type — creation, resolution, read endpoints

**Status**: done. Unit suite 213/213, e2e 34/34 against the live stack. Four
deviations from what is written below:

- **No resolution cache.** The probe costs one extra Vault round trip for PQ
  accounts only, and account type is immutable, so a cache would be correct —
  but nothing has measured it as a problem yet. Add it when signing starts
  resolving per transaction (increment 4), not before. Increment 4 now reuses
  resolved accounts within each group request; there is no cross-request cache.
- **`UserInfoResponseDto.account_type` is required, not optional.** It is always
  populated on the way out, so an optional field would only weaken the type for
  consumers.
- **`getKeys` now tolerates a 404 from the transit LIST.** Vault answers LIST on
  an empty mount with a 404, which the old code turned into a 500. That is
  reachable for the first time now: a deployment can hold PQ users and no
  transit ones at all.
- **The added field is not invisible to strict assertions.** The existing
  `User detail` e2e case asserted the whole response body with `toStrictEqual`
  and had to be updated. Wire-additive, but a caller that pins an exact shape
  will see it.

### Creation

`CreateUserDto` gains one optional field:

```ts
@IsOptional() @IsIn(['ed25519', 'falcon1024'])
account_type?: 'ed25519' | 'falcon1024';   // default 'ed25519'
```

`WalletService.userCreate` branches on it. The `ed25519` branch is the current
body verbatim. The `falcon1024` branch calls `pqCreateKey` and returns the
plugin's `address` directly — no client-side re-derivation, since the plugin is
the authority and the e2e test already verifies it independently.

One guard: refuse to create a key in one mount when the `user_id` already exists
in the other, with a `409 Conflict`. Without it a `user_id` could resolve to two
different addresses depending on probe order, which is a silent
funds-to-the-wrong-account bug.

### Resolution

One method replaces the scattered `getUserInfo(...).public_address` reads:

```ts
type UserAccount =
  | { type: 'ed25519';    userId: string; address: string; publicKey: Buffer }
  | { type: 'falcon1024'; userId: string; address: string; publicKey: Buffer;
      salt: number; scheme: string };

async resolveUserAccount(user_id, token): Promise<UserAccount>
```

Transit first (existing `getUserPublicKey` + `new Address(pk).toString()`,
unchanged behaviour and unchanged latency for every account that exists today),
`pqGetKey` on 404, `NotFoundException` if neither has it.

`getUserInfo` keeps its signature and response shape and is reimplemented on top
of this — it just reads `.address` instead of deriving one. Its read-only call
sites need no edit. The four call sites that go on to *sign*
(`transferAlgoToAddress`, `transferAsset`, `appCall`, `groupTransaction`) now
retain the resolved `UserAccount` through increment 4, so signing has the
account type, salt and public key without another lookup.

`UserInfoResponseDto` gains a required `account_type`. It is always populated;
the wire change remains additive for clients that ignore unknown fields.

### Listing

`VaultService.getKeys` today lists only the transit mount, so PQ users would be
invisible in `GET /v1/wallet/users/`. It gains the PQ mount listing, merged.

This is also the moment to fix the existing `// TODO: rename public_address that
is actually the public key in base64 format` on `vault.service.ts:360`. The
internal `UserInfoDto` currently carries a base64 *public key* that
`WalletService.getKeys` converts to an address — which is meaningless for a
1793-byte Falcon key. Have both branches return a real `address` string plus
`account_type`, and drop the conversion in `WalletService`. `UserInfoDto` is
internal; the wire DTO `UserInfoResponseDto.public_address` is already a real
address, so nothing observable changes.

**Tests**: extend the e2e "PQ accounts" block to go through the service instead
of straight to Vault — create with `account_type: 'falcon1024'`, confirm the
returned address matches a direct `pqGetKey`, confirm the account appears in
`GET /wallet/users/`, confirm a default-body create is still ed25519 and its
address is unchanged in shape, and confirm the cross-mount 409.

## Increment 4: signing and fees

**Status: implemented and PQ acceptance checks passed.** `algosdk@3.7.0`
is installed. Build and all 226 unit tests pass. Seven on-chain tests pass
against algod 5.0.1: ed25519 and PQ payments, mixed groups, fee simulation,
unfunded PQ asset opt-in, explicit-fee PQ app call, and a 16-payment PQ group.
The full e2e run before the last two cases were added passed 37/39; the two
manager identity/credential failures reference stale DID app 1069 after a
LocalNet reset and are unrelated to PQ signing. Identity state was not changed.

Implementation details differing from the original sketch:

- `pqsig.sch` is encoded as `Buffer.from(scheme)`, not a string; the SDK schema
  requires bytes.
- `signAndSubmit` receives the already-fetched `minFee` and an explicit
  `grouped` flag. Singles remain ungrouped; existing group endpoints still
  group even a single transaction, preserving ed25519 wire bytes.
- Account reuse is scoped to a group request, not a global cache across tokens.
- The fee helper rejects already-grouped transactions to prevent stale hashes.

**Otherwise ready against algod v5 / consensus v42.** Algorand v5 is now
released, so this is no longer blocked on an unavailable node version. LocalNet
setup and CI explicitly require algod major version 5 or newer before running
the suite. Existing 4.7 sandboxes must be refreshed with
`algokit localnet reset --update`; setup fails with that instruction
instead of allowing PQ on-chain tests to fail later for an opaque reason.

### Completed review findings

- [x] **Add `algosdk@3.7.0` to `dependencies`.** Scoped to the PQ envelope and PQ address
  helpers only — transaction building, grouping and encoding stay on
  algokit-utils. This supersedes the earlier item about promoting
  `algorand-msgpack`, which is no longer needed: the envelope is not hand-rolled.
- [x] **Retain the resolved `UserAccount` at every signing call site.**
  `transferAlgoToAddress`, `transferAsset`, `appCall` and `groupTransaction`
  pass the discriminated account to `signTxAsUser(account, ...)`,
  so the signing/submission path can select ed25519 or Falcon and has the PQ
  scheme, salt and public key without resolving it again.
- [x] **Include the PQ surcharge when prefunding an asset opt-in.**
  `transferAsset` reserves one `minFee` for an ed25519 user-signed opt-in.
  A Falcon opt-in needs that base fee plus the two-minimum-fee PQ contribution,
  so its funding calculation must reserve three `minFee` before grouping and
  signing. Cover both ed25519 and Falcon insufficient-balance cases in tests.

### Envelope assembly

New sibling in `ChainService`, leaving `addSignatureToTxn` untouched:

```ts
addPqSignatureToTxn(encodedTxn, pq: { scheme, salt, publicKey, signature }): Uint8Array
```

`encodedTxn` is the `"TX"`-prefixed output of `encodeTransaction`. Strip the
2-byte prefix, hand the rest to algosdk, and let its schema encoder produce the
canonical envelope:

```ts
addPqSignatureToTxn(encodedTxn, { scheme, salt, publicKey, signature }) {
  const txn = algosdk.decodeUnsignedTransaction(encodedTxn.slice(2));
  return algosdk.encodeMsgpack(
    new algosdk.SignedTransaction({
      txn,
      pqsig: { sch: Buffer.from(scheme), slt: salt, pk: publicKey, sig: signature },
    }),
  );
}
```

Key sorting, canonical map encoding and the `pqsig`-before-`txn` ordering are the
SDK's problem, not ours. The `.slice(2)` is the only place the two SDKs meet.

### Signing

`signTxAsUser` takes a resolved `UserAccount` instead of a `user_id` and
branches once. The `ed25519` branch is today's body verbatim — same transit
call, same `vault:v1:` split, same `addSignatureToTxn`. The `falcon1024` branch
calls `pqSign` and `addPqSignatureToTxn`. `signTxAsManager` is not touched.

### Fees

Every `craft*Tx` hardcodes `fee: BigInt(suggested_params.minFee)`, and
`craftAppCallTx` additionally accepts an explicit `fee` used for fee pooling. So
the multiplier cannot simply be applied inside the craft methods without either
breaking pooling or editing six call chains.

Instead, one function applied to an already-encoded transaction, **before**
grouping (a fee change after `setGroupID` invalidates the group hash):

```ts
addPqFeeSurcharge(encodedTxn, minFee): Uint8Array  // fee += 2 * minFee
```

Additive, not multiplicative. A default transaction goes `minFee → 3 × minFee`,
matching the spec; an explicitly pooled fee `F` goes to `F + 2 × minFee`, which
still covers the inner transactions it was sized for. `max(fee, 3 × minFee)`
would silently underpay the pooled case.

Verified against algod 5.0.1: an empty-signature PQ payment fails simulation
at 2,999 microAlgos and succeeds at 3,000, without invoking the Falcon signer.
`PQSchemeFeeContribution` in go-algorand `e763fb0d/config/consensus.go` returns
`2e6` for Falcon-1024, exactly two basic minimum fees. This is independent of
the separate size surcharge for oversized notes, app arguments and programs;
the existing builders' handling of those fields is unchanged.

algosdk gives a way to verify that without guessing. `emptyTxnSigner` from
`addressWithSignersFromRawPQSigner` attaches a `pqsig` envelope with real scheme,
salt and public key but empty signature bytes; under `simulate` with
`allowEmptySignatures`, algod derives the authorizer from that envelope and
charges the genuine post-quantum fee, with no Falcon signature produced. The
on-chain test uses this to pin the fee boundary alongside real signed payments.

### Consolidation

`transferAsset` and `groupTransaction` already contain near-identical
"build unsigned txns → `setGroupID` → loop signing by decoded sender → submit"
blocks, and `transferAlgoToAddress` / `appCall` / `clawbackAsset` are the
single-transaction form of the same thing. Rather than adding a PQ branch to
each, collapse them into one:

```ts
private async signAndSubmit(
  unsignedTxs: Uint8Array[],
  senders: Map<string, UserAccount | 'manager'>,
  vault_token: string,
  minFee: number | bigint,
  grouped = false,
): Promise<string>
```

which applies the surcharge to PQ senders, groups, dispatches each transaction
to the right signer by decoded sender, and submits. The PQ feature then costs
one branch in one place, and removes duplication that exists today — the fee
rule and the envelope rule each have exactly one home.

### Size limits

A PQ envelope includes a 1,793-byte public key as well as a roughly 1.2 KB
signature. The live test confirms a group of 16 PQ payments, each signed
envelope over 3 KB, is accepted. The consensus group limit remains 16, and
`MaxTxnBytesPerBlock` is 5 MiB in v42. There is no single small universal
per-transaction byte ceiling in `ConsensusParams`: field-specific bounds and
the generated `SignedTxnMaxSize` wire bound apply. `PQSig` explicitly feeds
its public-key and signature allocation bounds into that wire bound. See
go-algorand `e763fb0d/config/consensus.go` and `data/transactions/pqsig.go`.

### Tests

- Unit: `addPqSignatureToTxn` against a fixed transaction + fixture signature,
  asserting exact canonical bytes and that `algosdk.addressFromPQSig` on the
  decoded envelope returns the signing account's address; `addPqFeeSurcharge` for both the default and
  the explicitly-pooled case; and that an ed25519 transaction encoded through
  the consolidated path is byte-identical to what the current code produces
  (the actual regression guard for the refactor).
- E2E on algod v5 / consensus v42: a PQ user receives Algo from the manager, then
  sends a payment signed with `pqsig` that the network accepts; the same flow
  for an ed25519 user still passes unchanged; a mixed group with one PQ and one
  ed25519 sender confirms.

## Deferred / out of scope

- **Atomic account-type reservation.** The current cross-mount conflict check
  is check-then-create and therefore non-atomic: concurrent ed25519 and Falcon
  creation for one `user_id` can populate both mounts, after which transit-first
  resolution masks the PQ account. Revisit this during cleanup with one atomic
  account-type reservation/provisioning record shared by both creation paths.
- **Distinguish a missing PQ key from a missing/misconfigured PQ mount.**
  `pqRequest` currently converts every Vault 404 to `undefined`, and
  `pqListKeys` documents an unmounted engine as an empty list. A bad mount path
  can therefore look like “not a PQ account” or “no PQ users.” Add an explicit
  startup/readiness mount check or preserve enough Vault error information to
  treat only a key/list miss as empty while surfacing an unavailable engine.
- **Version and validate stored PQ key entries.** Plugin storage currently has
  no schema version and trusts decoded lengths and relationships. Before the
  format evolves, add a version field and read-time validation for entropy,
  public/private key sizes, canonical salt and derived-key consistency, with a
  deliberate migration or rejection path for unknown versions.
- **Manager PQ accounts.** See compatibility contract, point 2.
- **Mnemonic export.** The plugin persists the 32-byte entropy for it, but no
  path exposes it and none should until there is a reason.
- **Key rotation / deletion.** Matches the transit engine's
  `allow_deletion: false` usage today.
- **Migration of existing users to PQ.** Not possible without changing address;
  see compatibility contract, point 4.

## Local dev gotchas

Vault's file storage and `.env` both outlive an `algokit localnet reset`, which
makes the e2e suite fail in ways that have nothing to do with the code:

- a stale `GENESIS_HASH` in `.env` means every signed transaction is rejected —
  fix with `SKIP_LOCALNET_START=1 ./scripts/setup_localnet.sh`, then recreate
  the pawn container so it reloads `.env`
- the DID app id cached at `secret/intermezzo/manager/app-id` can point at an
  application that no longer exists (`404: application does not exist`) — delete
  that KV path and the registrar redeploys on the next run
- the suite finishes in ~13s but jest then hangs on an open handle; run it with
  `--forceExit` until the handle is tracked down

CI hits none of these: it wipes `volumes/vault` and re-syncs genesis every run.

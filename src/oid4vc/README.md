## OID4VC Module

Nest module exposing
[OpenID for Verifiable Credential Issuance](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html)
(OID4VCI) and
[OpenID for Verifiable Presentations](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html)
(OID4VP) over a [Credo-TS](https://credo.js.org/) agent.

- **Issuer DID**: the manager's `did:algo` (anchored on Algorand). Enforced
  by `Oid4vcAgentProvider.ensureIssuerDid` via `isDidAlgo()` — no fallback.
- **Holder binding**: the wallet-local `did:key`, pinned onto the offer at
  creation time by the manager.
- **Signing**: Vault-held; see [`libs/credo-vault-wallet`](../../libs/credo-vault-wallet/).
- **Trust model**: see [`TRUST_MODEL.md`](./TRUST_MODEL.md).

### Layout

```
src/oid4vc/
├── agent/oid4vc-agent.provider.ts  Credo agent + Express routers
├── algo/                           did:algo host adapters, Vault-backed Askar wallet
├── issuer/                         OID4VCI: offer creation + credential mapper
├── verifier/                       OID4VP: presentation request + result lookup
├── entities/                       Vault session tracking
├── dto/                            Request / response DTOs
├── oid4vc.config.ts                Env-driven configuration
└── oid4vc.module.ts                Nest wiring
```

### Endpoints

App-level orchestration endpoints (Nest):

| Method | Path                                | Purpose                                    |
|--------|-------------------------------------|--------------------------------------------|
| GET    | `/v1/credential/issuer/configurations` | List supported credential configurations   |
| POST   | `/v1/credential/issuer/offers`         | Create a credential offer (returns QR URI) |
| GET    | `/v1/credential/issuer/sessions/:id`   | Inspect an issuance session                |
| POST   | `/v1/credential/verifier/requests`     | Create a presentation request              |
| GET    | `/v1/credential/verifier/sessions/:id` | Inspect a verification session + claims    |
| GET    | `/v1/credential/status/list/:listId`   | **Public.** Signed status list token       |
| POST   | `/v1/credential/status/revoke`         | Revoke one issued credential               |
| POST   | `/v1/credential/status/reactivate`     | Undo a revocation                          |

The OID4VCI/OID4VP **protocol endpoints** themselves (token, credential,
authorization, …) are mounted by Credo on its own Express routers under
`OID4VC_ISSUER_PATH` (`/oid4vci`) and `OID4VC_VERIFIER_PATH` (`/oid4vp`),
attached in `src/main.ts` *before* `setGlobalPrefix('v1')`.

### Credential formats

One configuration is advertised (see
`src/oid4vc/issuer/credential-configurations.ts`):

- `device-attestation-credential` — SD-JWT VC minted by
  `/v1/link/response`; subsequent DID update calls present this credential
  via `CredentialAuthGuard`.

The credential mapper (`Oid4vcIssuerService#buildCredentialMapper`) selects
the `OpenId4VciSignCredential` shape per the wallet's requested format and
populates it from the offer's `issuanceMetadata`.

### Revocation

Every SD-JWT VC is issued with an [IETF Token Status
List](https://datatracker.ietf.org/doc/draft-ietf-oauth-status-list/)
pointer:

```json
"status": { "status_list": { "uri": "https://host/v1/credential/status/list/default", "idx": 42 } }
```

Verification enforces this for free — `@sd-jwt` fetches the list, checks
its signature, reads the bit and rejects the credential unless it is `0`.
Nothing in this repo implements a revocation check; issuing the claim *is*
the integration.

Revoke by issuance session id (the id from
`GET /v1/credential/issuer/sessions`):

```sh
curl -X POST http://localhost:3000/v1/credential/status/revoke \
  -H "Authorization: Bearer $MANAGER_JWT" \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<issuance-session-id>","reason":"device reported stolen"}'
```

`POST .../reactivate` with the same body reverses it. The list itself is
public, because verifiers must be able to dereference it:

```sh
curl -i http://localhost:3000/v1/credential/status/list/default
# Content-Type: application/statuslist+jwt
```

Three things worth knowing:

- **The list URL is load-bearing for the life of every credential that
  points at it.** A failed status fetch fails verification, so moving or
  removing it — including by changing `OID4VC_BASE_URL` — bricks issued
  credentials. Reissuance is the only repair.
- **The list token is signed with the manager `did:algo` key**, the same
  key that signs credentials. Credo configures a single verifier for both,
  so any other signing key fails verification.
- **Credentials issued before this feature carry no `status` claim** and
  are therefore permanently unrevocable: `@sd-jwt` skips the check
  entirely when the claim is absent.

This service resolves its own lists in-process rather than fetching its
own URL (`Oid4vcStatusService#installLocalStatusListFetcher`), so
`CredentialAuthGuard` does no network I/O per request and wallet auth does
not depend on the server reaching itself.

W3C `jwt_vc_json` credentials get **no** status claim: Credo refuses to
verify credential status for JWT VCs, so adding one would break
verification rather than enable it.

### Holder binding

1. The caller (manager-authenticated) hits `POST /v1/credential/issuer/offers`
   with the target wallet-local `did:key` as `holderDidKey`.
2. `Oid4vcIssuerService.createOffer` pins `holderDidKey` into
   `issuanceMetadata._holderDidKey` and persists it on
   `Oid4vcIssuanceSession.holderDidKey`.
3. On redemption, the credential mapper accepts the request only if the
   proof JWT's `holderBinding.didUrl` is the pinned `did:key` (or a
   fragment URL under it).
4. The issued credential's holder (`holder.didUrl` for SD-JWT VC,
   `credentialSubject.id` for W3C JWT VC) is the pinned `did:key`.

### DID methods

The agent registers two DID methods:

- **`did:algo`** — issuer side. `AlgoDidRegistrar` / `AlgoDidResolver`
  from `libs/credo-did-algo`, wired via host adapters in `algo/`.
- **`did:key`** — holder side. Credo's built-in `KeyDidRegistrar` /
  `KeyDidResolver`.

`did:key` is **never** acceptable as the issuer DID: it has no revocation
surface, no on-chain anchor, and would prevent issuer discovery via a
future trust registry (see [`TRUST_MODEL.md`](./TRUST_MODEL.md)).

### Vault-held credential signing

Ed25519 private keys for the manager identity live in HashiCorp Vault
(transit engine, `VAULT_TRANSIT_USERS_PATH`). Nothing in this module
sees private bytes:

- `VaultAskarWallet` (from `libs/credo-vault-wallet`) is an `AskarWallet`
  subclass that overrides Ed25519 `sign()` for keys registered in the
  process-wide `vaultSigningRegistry`. It calls `VaultService.sign`,
  parses `vault:v1:<base64>`, and verifies the signature locally before
  returning.
- `Oid4vcAskarModule` registers the subclass at
  `InjectionSymbols.Wallet` in place of stock `AskarModule`.
- `AlgoDidRegistrar.create` does not generate a key in Askar — it pulls
  the manager's existing Vault transit key via
  `VaultKeyProvisioningAdapter`, registers the binding, and publishes
  the on-chain document.

Per-user `did:algo`s use a different path: `AttestationsService.redeem`
calls `DidService.publishUncontrolledDid` — the manager pays the
on-chain write, but the published document is owned by the wallet's
`did:key`.

### Vault AppRole

The OID4VC subsystem does **not** provision its own AppRole. It reuses
the manager AppRole (`VAULT_ROLE_ID` / `VAULT_SECRET_ID`, the same
credentials backing `ManagerVaultTokenProvider`) via
`AlgoVaultTokenProvider`, since OID4VC operates on behalf of the
manager identity and a separate role would only duplicate Vault
policy surface area.

### Configuration (env)

| Variable                     | Default                                  | Description                                                                       |
|------------------------------|------------------------------------------|-----------------------------------------------------------------------------------|
| `OID4VC_BASE_URL`            | `http://localhost:3000`                  | Public base URL                                                                   |
| `OID4VC_ISSUER_PATH`         | `/oid4vci`                               | OID4VCI protocol path                                                             |
| `OID4VC_VERIFIER_PATH`       | `/oid4vp`                                | OID4VP protocol path                                                              |
| `OID4VC_LABEL`               | `pawn-oid4vc`                            | Credo agent label                                                                 |
| `OID4VC_WALLET_ID`           | `pawn-oid4vc`                            | Askar wallet id                                                                   |
| `OID4VC_WALLET_KEY`          | `pawn-oid4vc-key`                        | Askar wallet master key (**override in prod**)                                    |
| `OID4VC_ISSUER_DISPLAY_NAME` | `Algorand Foundation Rewards`            | Issuer display name                                                               |
| `OID4VC_AUTO_INIT`           | `true`                                   | Initialise the Credo agent on bootstrap                                           |
| `OID4VC_MANAGER_USER_ID`     | `VAULT_MANAGER_KEY` (default `manager`)  | Vault transit key name for the manager identity                                   |

> A trust-registry bridge (e.g. [CREDEBL](https://credebl.id/)) is **not**
> wired in yet. The governance layer in [`TRUST_MODEL.md`](./TRUST_MODEL.md)
> is intentionally pluggable — a future integration will add its own
> env vars here.

### Storage

Credo persists its own records inside the **Askar** wallet (required by
Credo 0.5.x). No ed25519 private material lives in Askar — Vault is the
sole custodian.

App-level mappings persisted in Vault KV:

- `oid4vc_issuance_session` / `oid4vc_verification_session` — correlate
  Credo session ids with the holder `did:key` and credential
  configuration for status queries. The issuance session also carries the
  credential's `statusListId` / `statusListIndex`, plus `revokedAt` /
  `revokedReason` once revoked.
- `intermezzo/oid4vc/status-lists/records/<id>` — one record per status
  list: a 16384-entry bitstring (36 bytes deflated) and the next free
  index.

The Vault key binding map is **in-memory** (manager-only) and rebuilt on
boot by `Oid4vcAgentProvider`.

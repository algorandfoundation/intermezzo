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
  configuration for status queries.

The Vault key binding map is **in-memory** (manager-only) and rebuilt on
boot by `Oid4vcAgentProvider`.

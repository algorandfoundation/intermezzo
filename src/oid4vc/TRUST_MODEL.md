## Trust model

Three layers, each answering exactly one question. Neither alone is
sufficient; composed, they give us governance, cryptographic truth, and
an immutable audit trail.

```
   ┌────────────────────────────────────────────────────────────┐
   │  Governance / policy  ─  (future) trust registry           │
   │  "Which did:algo's are trusted to issue which schemas?"    │
   │  Pluggable. Reference target: CREDEBL ecosystem registry.  │
   └───────────────────────────▲────────────────────────────────┘
                               │ references DIDs by their canonical id
   ┌───────────────────────────┴────────────────────────────────┐
   │  Resolution / DID method  ─  did:algo                      │
   │  "Given an id, what is the current DID Document + keys?"   │
   │  Implemented by libs/credo-did-algo.                       │
   └───────────────────────────▲────────────────────────────────┘
                               │ reads/writes documents
   ┌───────────────────────────┴────────────────────────────────┐
   │  Anchor / audit  ─  Algorand ledger                        │
   │  "Immutable, third-party-auditable history of every DID."  │
   └────────────────────────────────────────────────────────────┘
```

Read top-down for *is this issuer trusted?* and bottom-up for *is this
key really theirs?*. Both questions are answered independently, by
different systems.

### Roles

| DID                 | Owner                    | Purpose                                                                   |
|---------------------|--------------------------|---------------------------------------------------------------------------|
| Manager `did:algo`  | Manager Vault key        | Credential issuer; anchored on Algorand; eligible for trust-registry listing. |
| Per-user `did:algo` | Wallet `did:key` (owner) | On-chain anchor for the wallet's `did:key`. Manager pays the box MBR.     |
| Holder `did:key`    | Wallet device            | Holder binding for issued credentials; key-binding JWT signer.            |

The manager's key signs **issuance** and the **box write** that anchors
per-user DIDs; it never controls per-user DIDs after publish (the
on-chain document's verification method declares the wallet's `did:key`
as controller).

### Invariants

- The OID4VC issuer DID is always a `did:algo`. Enforced by
  `Oid4vcAgentProvider.ensureIssuerDid` via `isDidAlgo()`. No fallback
  to `did:key` or any other method.
- Holder binding is the wallet's `did:key`, pinned onto the offer by
  `Oid4vcIssuerService.createOffer` and enforced at redemption by the
  credential mapper.
- Private ed25519 keys never leave Vault. Credo signs through
  `VaultAskarWallet` → `vaultSigningRegistry` → `VaultSigner`; signature
  bytes are locally verified against the requested public key before
  leaving the agent.
- The host holds **no** local DID cache. The on-chain `DIDAlgoStorage`
  box is the single source of truth; the resolver falls back to
  self-describing the document from the DID identifier's encoded public
  key.
- The host owns **no** per-user record — `did:key` is the caller's
  identity for the lifetime of an offer.
- The governance layer ("is this issuer in the registry?") is
  intentionally **pluggable** and currently **not wired in**. A future
  integration — e.g. the [CREDEBL](https://credebl.id/) ecosystem
  registry — will gate issuer trust without affecting the cryptographic
  path, which always resolves the `did:algo` from Algorand.

### Why `did:algo` for the issuer

- Cryptographic, on-chain, third-party-auditable anchor for the manager
  key. Independent of any registry's database.
- Revocation surface: the document is mutable on chain.
- Discoverable in a future trust registry (e.g. CREDEBL) alongside
  `did:polygon` / `did:indy` — Algorand becomes a peer ledger in the
  registry's resolver matrix.

### Why `did:key` for holders

- Zero infrastructure: no on-chain write or registry entry per device.
- Wallet-local key material, no host custody.
- Bound to the device via the device-attestation credential issued by
  `/v1/link/response`; subsequent DID document updates are gated by
  this credential.

### Registrar-key custody

Today the manager Vault key signs every on-chain DID write. As
additional issuers are onboarded, the long-term target is:

- **Per-org Vault-backed key**, trust-registry-mediated onboarding.
  Each onboarded organisation gets its own Vault transit key; the
  registry (e.g. CREDEBL) holds the policy that gates "this org may
  register `did:algo:<id>`".

A fully self-sovereign variant (org brings its own Algorand account,
registrar just relays signed transactions) remains a possible future
direction but is out of scope for the current trust model.

See [`../../TODO.md`](../../TODO.md) for the milestone roadmap.

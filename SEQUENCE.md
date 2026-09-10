# DID + OID4VC Flows

High-level overview of the `did:algo` and OID4VC flows in this service.

The service exposes three logical surfaces:

- **`/v1/did/*`** — per-user `did:algo` contract deploy + document update,
  driven by the wallet itself and gated by a device-attestation credential.
- **Manager-issued credentials** — pre-authorized OID4VCI offers created by the 
  manager (optionally after device attestation) to mint credentials.
- **`/v1/credential/{issuer,verifier}/*`** — generic OID4VCI / OID4VP
  orchestration over a Credo agent. Credo's own protocol routes are
  mounted under `/oid4vci` and `/oid4vp` (outside the `/v1` prefix).

## 1. Deploy `DIDAlgoStorage` to a network

> [!NOTE]
> Prerequisite for everything else. The deployed app id is recorded as
> `DID_ALGO_APP_ID` and reused for every per-user contract template.

```mermaid
sequenceDiagram
    actor Manager
    participant Network as Algorand Network<br/>(localnet / fnet / testnet / mainnet)

    Manager->>Network: deploy DIDAlgoStorage
    Network-->>Manager: DID_ALGO_APP_ID
```

## 2. Provision a user (Vault key only)

> [!NOTE]
> - `WalletService.userCreate` now only provisions a **Vault transit
>   Ed25519 key** for the user and returns its derived Algorand address.
> - **No DID is published at user creation.** The user's `did:algo` is
>   deployed later by the wallet itself (section 5), owned by the
>   wallet-local `did:key` rather than by the manager.

```mermaid
sequenceDiagram
    actor Manager
    participant Pawn as Pawn (WalletService)
    participant Vault as HashiCorp Vault<br/>(transit)

    Manager->>Pawn: create user (user_id)
    Pawn->>Vault: transitCreateKey(user_id)
    Vault-->>Pawn: ed25519 public key
    Pawn-->>Manager: { user_id, public_address, algoBalance: "0" }
```

## 3. Manager-issued pre-authorized credential

> [!NOTE]
> - The wallet holds a local `did:key` (never leaves the device). 
> - The manager performs any required out-of-band verification (e.g. 
>   device attestation, KYC, or email proof) and then issues a 
>   **pre-authorized OID4VCI offer** pinned to the user's `did:key`.
> - The default credential configuration is `device-attestation-credential`,
>   which is what the `CredentialAuthGuard` expects by default.
> - No on-chain operations occur in this flow.

```mermaid
sequenceDiagram
    actor User
    participant Wallet as Self-Custody Wallet<br/>(device, holds did:key)
    actor Manager
    participant Pawn as Pawn<br/>(Oid4vcIssuerController)
    participant Issuer as OID4VC Issuer<br/>(Credo agent + Vault signer)

    User->>Manager: request credential (supply didKey + attestation)
    Manager->>Manager: verify user / device
    
    Manager->>Pawn: POST /v1/credential/issuer/offers<br/>{ credentialConfigurationIds: ['device-attestation-credential'], holderDidKey: didKey }
    Pawn->>Issuer: createOffer(holderDidKey=didKey)
    Issuer-->>Pawn: issuanceSession (credentialOffer)
    Pawn-->>Manager: { credentialOffer, ... }

    Manager-->>User: deliver credentialOffer (URL / QR)

    User->>Issuer: redeem offer via OID4VCI<br/>(/oid4vci/* protocol routes)
    Issuer-->>User: SD-JWT VC<br/>(device-attestation-credential, cnf.kid = did:key)
```

## 4. Generic OID4VC issuance & verification

> [!NOTE]
> - App-level endpoints under `/v1/credential/{issuer,verifier}/*` are
>   manager-authenticated (`Authorization: Bearer <manager-JWT>`).
>   They orchestrate session lifecycle; the wallet talks to the
>   protocol routes that Credo mounts directly under `/oid4vci` and
>   `/oid4vp`.
> - The issuer DID is the **manager's `did:algo`** (anchored on
>   Algorand and discoverable on-chain). Holder binding pins the
>   target wallet's `did:key` into the offer at creation time.
> - Section 3 is the canonical example of issuance — this flow is the
>   generalised shape (any credential configuration).

### 4a. Issue a credential (OID4VCI)

```mermaid
sequenceDiagram
    actor Manager
    participant Pawn as Pawn<br/>(Oid4vcIssuerController)
    participant Issuer as Credo Issuer<br/>(/oid4vci/*)
    participant Wallet as Self-Custody Wallet<br/>(did:key)

    Manager->>Pawn: POST /v1/credential/issuer/offers<br/>{ credentialConfigurationIds, holderDidKey, issuanceMetadata }
    Pawn->>Issuer: createCredentialOffer (pin holderDidKey)
    Issuer-->>Pawn: credentialOfferUri + sessionId
    Pawn-->>Manager: { id, credentialOffer, holderDidKey, state }

    Manager-->>Wallet: hand over credentialOffer<br/>(QR / deep link)

    Wallet->>Issuer: OID4VCI flow<br/>(token, credential, proof-of-possession with did:key)
    Issuer->>Issuer: verify proof.holderBinding.didUrl == pinned did:key
    Issuer-->>Wallet: signed credential<br/>(SD-JWT VC or W3C JWT VC)

    Manager->>Pawn: GET /v1/credential/issuer/sessions/:id
    Pawn-->>Manager: session state (issued / failed / pending)
```

### 4b. Verify a presentation (OID4VP)

```mermaid
sequenceDiagram
    actor Verifier as Verifier App<br/>(manager-authed)
    participant Pawn as Pawn<br/>(Oid4vcVerifierController)
    participant V as Credo Verifier<br/>(/oid4vp/*)
    participant Wallet as Self-Custody Wallet<br/>(holds credential)

    Verifier->>Pawn: POST /v1/credential/verifier/requests<br/>{ presentationDefinition }
    Pawn->>V: createPresentationRequest
    V-->>Pawn: authorizationRequest URI + sessionId
    Pawn-->>Verifier: { id, authorizationRequest, state }

    Verifier-->>Wallet: present authorizationRequest<br/>(QR / deep link)
    Wallet->>V: OID4VP authorization response<br/>(VP token signed by did:key)
    V->>V: validate VP token + match presentationDefinition

    Verifier->>Pawn: GET /v1/credential/verifier/sessions/:id
    Pawn->>V: refresh session state
    Pawn-->>Verifier: { state, claims }
```

### 4c. Check and change credential status

```mermaid
sequenceDiagram
    actor Manager
    participant Pawn as Pawn
    participant Wallet
    participant Verifier

    Pawn->>Pawn: Allocate on active UUID list<br/>CAS rollover if full; CAS append to session
    Pawn-->>Wallet: Issue SD-JWT VC<br/>status.status_list = { uri, idx }
    Wallet->>Verifier: Present credential
    Verifier->>Pawn: GET /v1/credential/status/list/:listId
    Pawn->>Pawn: Read current list from Vault<br/>Reuse signature only if bits are unchanged
    Pawn-->>Verifier: Signed status list JWT
    Verifier->>Verifier: Check idx<br/>0 = valid, 1 = revoked

    Manager->>Pawn: POST /v1/credential/status/revoke<br/>{ sessionId, reason? }
    Pawn->>Pawn: Persist revocation intent; block issuance<br/>CAS all recorded bits to 1; persist completion
    Manager->>Pawn: POST /v1/credential/status/reactivate<br/>{ sessionId }
    Pawn->>Pawn: Persist reactivation intent<br/>CAS all recorded bits to 0; persist completion
```

## 5. Wallet self-deploys its own `did:algo`

> [!NOTE]
> - Gated by `CredentialAuthGuard`: the wallet presents the
>   `device-attestation-credential` from section 3 in
>   `X-Credential-Presentation`. The credential's `cnf.kid` is the
>   `did:key` that will own the new contract — callers cannot spoof
>   a different owner.
> - The host **builds** the atomic group but **does not sign the
>   `applicationCreate`**: the wallet signs position 2 with its
>   `did:key`, which makes the wallet's address the on-chain
>   contract creator. The host signs positions 0 + 1 (manager-funded
>   `pay` txns) only at submit time, after byte-for-byte
>   revalidation of the wallet-signed bytes.
> - On confirmation, the new app id is persisted to Vault KV
>   (`did:key → appId`) and the canonical `did:algo:<network>:<appId>`
>   is returned.

```mermaid
sequenceDiagram
    actor User
    participant Wallet as Self-Custody Wallet
    participant Pawn as Pawn<br/>(DidController + CredentialAuthGuard)
    participant Vault as Vault<br/>(manager transit + KV)
    participant Network as Algorand Network

    Wallet->>Pawn: POST /v1/did/create/transactions<br/>X-Credential-Presentation: <SD-JWT VC>
    Pawn->>Pawn: verify credential, extract did:key = cnf.kid
    Pawn->>Pawn: build 3-txn group<br/>[funder pay, manager→user pay, appl create]
    Pawn-->>Wallet: { txnGroup, indexesToSign: [2] }

    Wallet->>Wallet: sign txn[2] with did:key

    Wallet->>Pawn: POST /v1/did/create/submit<br/>{ signedTxns } + same credential
    Pawn->>Pawn: rebuild canonical group from did:key<br/>validate wallet-signed bytes
    Pawn->>Vault: sign txn[0], txn[1] via manager transit
    Vault-->>Pawn: manager signatures
    Pawn->>Network: broadcast atomic group
    Network-->>Pawn: appId
    Pawn->>Vault: kvWrite(did:key → appId)
    Pawn-->>Wallet: { appId, appAddress, did, txId }
```

## 6. Wallet updates its own DID document

> [!NOTE]
> - Same `CredentialAuthGuard` gate as section 5 — the credential-bound
>   `did:key` selects which per-user `DIDAlgoStorage` contract is
>   mutated, and the supplied document's `id` must equal the canonical
>   `did:algo:<network>:<appId>` derived from that key.
> - The host returns a flat list of 16-txn-packed atomic groups
>   covering the full swap (`startDelete`, `deleteData×N`,
>   `mbrPay + startUpload`, `upload×K`, `finishUpload`). The MBR `pay`
>   is pre-signed by the manager via Vault Transit; every app-call
>   is left unsigned for the wallet to sign with its `did:key`.
> - The on-chain contract refunds the prior box MBR via inner txns,
>   so the wallet pays only the net MBR delta.

```mermaid
sequenceDiagram
    actor Wallet as Self-Custody Wallet
    participant Pawn as Pawn<br/>(DidController + CredentialAuthGuard)
    participant Vault as Vault<br/>(manager transit)
    participant Network as Algorand Network

    Wallet->>Pawn: POST /v1/did/update/transactions<br/>{ document } + X-Credential-Presentation
    Pawn->>Pawn: verify credential → did:key → appId<br/>assert document.id == did:algo:...:appId
    Pawn->>Vault: pre-sign MBR pay positions (manager)
    Vault-->>Pawn: manager signatures
    Pawn-->>Wallet: groups[] with indexesToSign per group<br/>(app-calls unsigned, MBR pay pre-signed)

    Wallet->>Wallet: sign app-call positions with did:key

    Wallet->>Pawn: POST /v1/did/update/submit<br/>{ signedGroups } + same credential
    Pawn->>Network: broadcast groups in execution order
    Network-->>Pawn: txIds
    Pawn-->>Wallet: { txIds }
```

## 7. DID module orchestration endpoints

> [!NOTE]
> - Manager-authenticated read endpoints for inspecting the per-user
>   DID registry. The public resolver lets any caller resolve a
>   cached document by `did:key`.

```mermaid
flowchart LR
    subgraph Clients
        M[Manager]
        A[Self-Custody Wallet]
        P[Public]
    end

    subgraph DID Module
        L[GET /v1/did/identities<br/>list user did:algo entries — manager]
        G[GET /v1/did/identities/:didKey<br/>resolve by did:key — manager]
        C1[POST /v1/did/create/transactions<br/>build deploy group]
        C2[POST /v1/did/create/submit<br/>broadcast deploy group]
        U1[POST /v1/did/update/transactions<br/>build update groups]
        U2[POST /v1/did/update/submit<br/>broadcast update groups]
    end

    Network[(Algorand Network<br/>DIDAlgoStorage)]

    M --> L
    M --> G
    A -->|X-Credential-Presentation| C1
    A -->|X-Credential-Presentation| C2
    A -->|X-Credential-Presentation| U1
    A -->|X-Credential-Presentation| U2

    C2 --> Network
    U2 --> Network
```

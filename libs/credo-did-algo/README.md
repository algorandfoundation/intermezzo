## `@algorandfoundation/credo-did-algo`

A [Credo-TS](https://credo.js.org/) DID method plugin for `did:algo` — an
Algorand-anchored DID method. Provides a host-agnostic resolver and
registrar that any Credo agent can register through `DidsModule`.

The package has no KMS / Vault dependency: signing custody is exposed as
an opaque `keyRef` and lives in the host's wallet implementation. See
[`@algorandfoundation/credo-vault-wallet`](../credo-vault-wallet/) for a
HashiCorp-Vault-backed companion.

### Install

```sh
yarn add @algorandfoundation/credo-did-algo
```

Peer dependency: `@credo-ts/core`.

### Usage

```ts
import { AlgoDidResolver, AlgoDidRegistrar } from '@algorandfoundation/credo-did-algo';

const dids = new DidsModule({
  resolvers: [new AlgoDidResolver(reader)],
  registrars: [new AlgoDidRegistrar(writer, keyProvisioning, keyRefRegistry)],
});
```

`reader`, `writer`, `keyProvisioning`, and `keyRefRegistry` are host
implementations of the ports described below. Verify-only hosts wire
only `reader`; issuing hosts wire all four.

### Ports

| Port                     | Required for                | Purpose                                                                                              |
|--------------------------|-----------------------------|------------------------------------------------------------------------------------------------------|
| `DidAlgoChainReaderPort` | resolve (everyone)          | Read the on-chain DID Document from the `DIDAlgoStorage` contract identified by the DID's appId.    |
| `DidAlgoChainWriterPort` | issue                       | `uploadDocument` / `deleteDocument` on chain. Takes an opaque `keyRef` resolved by the host's KMS.   |
| `KeyProvisioningPort`    | issue                       | Resolves (or lazy-creates) the ed25519 key material backing a controller at publish time.            |

`AlgoDidResolver` always consults `DidAlgoChainReaderPort` — there is
no self-describe fallback and no in-process cache. Credo-level caching
is also disabled (`allowsCaching = false`, `allowsLocalDidRecord = false`)
so the chain remains the single source of truth and the package can
never be a source of stale-document bugs.

### API

- `AlgoDidResolver(reader, logger?)` — Credo `DidResolver` for `did:algo`; reads documents from chain via `DidAlgoChainReaderPort`.
- `AlgoDidRegistrar(writer, keyProvisioning, keyRefRegistry?)` — Credo
  `DidRegistrar` for `did:algo`; supports create / update / deactivate.
- `parseDidAlgo(did)` / `isDidAlgo(did)` / `DID_ALGO_PATTERN` —
  identifier helpers.
- `buildCredoDidDocumentFromKey(did, publicKey)` — synthesise a Credo
  `DidDocument` from a `did:algo` identifier and its ed25519 key.
- `encodePublicKeyMultibase(publicKey)` — ed25519 / base58btc helper.

### Scope

Included:

- `did:algo` resolution and registration as a Credo DID method.
- Identifier and multibase helpers.

Excluded:

- KMS / signing custody (see `credo-vault-wallet`).
- DIDComm, AnonCreds, connection / proof protocols.
- The Algorand smart-contract client (consumed via the host's writer
  adapter; see [`libs/did-algo`](../did-algo/) for the in-repo client).
- Holder DIDs (`did:key`) — use Credo's built-in `KeyDidResolver` /
  `KeyDidRegistrar`.

### Layout

```
libs/credo-did-algo/
├── ports.ts                # DidAlgoChainReaderPort, DidAlgoChainWriterPort, KeyProvisioningPort
├── algo-did.resolver.ts    # AlgoDidResolver, buildCredoDidDocumentFromKey
├── algo-did.registrar.ts   # AlgoDidRegistrar
├── identifier.ts           # parseDidAlgo, isDidAlgo, DID_ALGO_PATTERN
├── multibase.ts            # encodePublicKeyMultibase
└── index.ts                # barrel
```

### License

Apache-2.0.

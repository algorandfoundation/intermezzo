## `@algorandfoundation/credo-vault-wallet`

A Credo wallet adapter that lets `@credo-ts/askar` delegate Ed25519
signing to an external KMS (HashiCorp Vault by default; the shape
generalises to AWS / GCP KMS or an HSM) without coupling that concern
to any DID-method plugin.

This is the wallet-side counterpart to
[`@algorandfoundation/credo-did-algo`](../credo-did-algo/): the DID
package answers *what does this DID resolve to?*; this package answers
*given a public key Credo holds, who signs with the matching private
key?*.

### Install

```sh
yarn add @algorandfoundation/credo-vault-wallet
```

Peer dependencies: `@credo-ts/core`, `@credo-ts/askar`.

### Usage

```ts
import {
  KeyRefStore,
  VaultAskarWallet,
  publicKeyToBase58,
  parseVaultSignature,
  vaultSigningRegistry,
} from '@algorandfoundation/credo-vault-wallet';

// 1. Wire persistence + signer at host boot.
vaultSigningRegistry.setStore(keyRefStore);
vaultSigningRegistry.setSigner(async (binding, data) => {
  const sig = await kms.sign(binding.transitPath, binding.vaultKeyName, data);
  return parseVaultSignature(sig);
});

// 2. Register VaultAskarWallet at InjectionSymbols.Wallet
//    (typically inside a Credo module that replaces AskarModule).

// 3. On key creation, bind the public key to its KMS reference.
await vaultSigningRegistry.bind(publicKeyToBase58(publicKey), {
  vaultKeyName: 'manager',
  transitPath: 'pawn/manager',
});
```

### Ports

| Port          | Required for                          | Notes                                                          |
|---------------|---------------------------------------|----------------------------------------------------------------|
| `VaultSigner` | All hosts using `VaultAskarWallet`    | Host closure over its KMS SDK (e.g. `VaultService.sign`).      |
| `KeyRefStore` | All hosts that persist KMS bindings   | Host persistence layer (TypeORM, Prisma, in-memory map, …).    |

`VaultKeyBinding = { vaultKeyName, transitPath }` is the opaque-to-Credo
key reference the registry stores and hands back to the signer. Its
shape matches HashiCorp Vault's transit engine but is never interpreted
by the package — hosts on a different KMS may repurpose either field.

### API

- `vaultSigningRegistry` — process-wide singleton; `setStore`,
  `setSigner`, `bind`, `lookup`, `sign`.
- `VaultAskarWallet` — `AskarWallet` subclass overriding ed25519
  `sign`; falls through to Askar's native path for other key types.
- `publicKeyToBase58(publicKey)` / `parseVaultSignature(str)` — helpers.
- `VaultKeyBinding`, `VaultSigner`, `KeyRefStore` — port types.

### Scope

Included:

- Ed25519 sign override for `@credo-ts/askar`.
- KMS key-reference persistence contract (`KeyRefStore`).

Excluded:

- DID methods (see `credo-did-algo`).
- Non-Ed25519 signing.
- Multi-message signing (AnonCreds-only; rejected explicitly).

### Layout

```
libs/credo-vault-wallet/
├── ports.ts                 # VaultKeyBinding, VaultSigner, KeyRefStore
├── signing-registry.ts      # vaultSigningRegistry singleton
├── vault-askar-wallet.ts    # AskarWallet subclass overriding ed25519 sign
├── vault-signature.ts       # parseVaultSignature
└── index.ts                 # barrel
```

### License

Apache-2.0.

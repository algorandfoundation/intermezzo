/**
 * Public surface of the `@algorandfoundation/credo-did-algo` package.
 *
 * This package is a DID-method plugin only. It deliberately knows
 * nothing about KMS / Vault — signing custody lives in the sibling
 * `@algorandfoundation/credo-vault-wallet` package.
 *
 * Today this exports:
 *   - the host ports — split into a resolver-only
 *     ({@link DidAlgoChainReaderPort}) and an issuer
 *     ({@link DidAlgoChainWriterPort}) tier so verify-only hosts never
 *     have to model a KMS just to look up a `did:algo`. The writer
 *     port takes an opaque `keyRef` that the host resolves through its
 *     own KMS adapter (e.g. the vault-wallet package);
 *   - the pure identifier helpers (`DID_ALGO_PATTERN`, `parseDidAlgo`,
 *     `isDidAlgo`) consumed by Credo resolvers and by invariant checks;
 *   - the multibase helpers (`encodeEd25519PublicKeyMultibase`,
 *     `base58btcEncode`) the resolver uses to synthesise self-described
 *     DID Documents without a host dependency; and
 *   - the host-agnostic Credo `AlgoDidResolver` (plus the pure
 *     `buildCredoDidDocumentFromKey` helper); and
 *   - the host-agnostic Credo `AlgoDidRegistrar`, composed over a
 *     {@link DidAlgoChainWriterPort} + {@link KeyProvisioningPort} +
 *     an optional `KeyRefRegistry` (KMS-binding registry; see
 *     `@algorandfoundation/credo-vault-wallet`).
 *
 * See `src/oid4vc/TRUST_MODEL.md` for the full plan and `./README.md`
 * for the package-level overview and target layout.
 */

export type {
  DidAlgoChainReaderPort,
  DidAlgoChainWriterPort,
  DidAlgoPublishResult,
  DidAlgoRecord,
  KeyProvisioningPort,
} from './ports';

export { DID_ALGO_PATTERN, parseDidAlgo, isDidAlgo } from './identifier';
export type { ParsedDidAlgo } from './identifier';

export { encodeEd25519PublicKeyMultibase, base58btcEncode } from './multibase';

export { AlgoDidResolver, buildCredoDidDocumentFromKey } from './algo-did.resolver';

export { AlgoDidRegistrar } from './algo-did.registrar';
export type { AlgoDidCreateOptions, AlgoDidDeactivateOptions, KeyRefRegistry } from './algo-did.registrar';

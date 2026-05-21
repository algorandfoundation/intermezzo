/**
 * Pure identifier helpers for the `did:algo` method.
 *
 * Kept dependency‑free (no Credo, no Nest, no Vault, no chain access) so
 * that any host — Intermezzo today, CREDEBL tomorrow — can parse a
 * `did:algo` without pulling the rest of the plugin into scope.
 *
 * Canonical shape:
 *
 * ```
 * did:algo:<network>:app:<app-id>:<hex-pubkey>
 * ```
 *
 * Where:
 *   - `<network>`  is an algokit network name (`mainnet`, `testnet`, …);
 *   - `<app-id>`   is the decimal id of the on‑chain DID smart contract
 *                  application that hosts the document box;
 *   - `<hex-pubkey>` is the lowercase, unprefixed 64‑hex‑char encoding of
 *                  the Ed25519 public key that is the DID subject.
 *
 * The identifier is **self‑describing** — the public key is embedded —
 * which lets resolvers rebuild a verification‑method without going on
 * chain. The on‑chain box is the source of truth for *document
 * extensions* (linked wallet, services, …), not the key itself.
 */

/**
 * Canonical regex for a `did:algo` identifier. Anchored, case‑insensitive
 * on the hex tail to match common normalisation.
 */
export const DID_ALGO_PATTERN = /^did:algo:([^:]+):app:(\d+):([0-9a-f]{64})$/i;

/**
 * Parsed components of a `did:algo` identifier.
 */
export interface ParsedDidAlgo {
  /** The full DID string (normalised). */
  did: string;
  /** Algokit network name segment (e.g. `mainnet`, `testnet`). */
  network: string;
  /** Numeric on‑chain application id, as a string (to avoid `bigint` churn). */
  appId: string;
  /** Lowercase hex‑encoded Ed25519 public key. */
  publicKeyHex: string;
  /** Raw 32‑byte Ed25519 public key. */
  publicKey: Uint8Array;
}

/**
 * Parse a `did:algo` identifier into its components. Returns `null` for
 * inputs that do not match {@link DID_ALGO_PATTERN}; throwing is left to
 * the caller so resolvers/registrars can decide between
 * `invalidDid` and `notFound` failure modes.
 */
export function parseDidAlgo(did: string): ParsedDidAlgo | null {
  const match = DID_ALGO_PATTERN.exec(did);
  if (!match) return null;
  const [, network, appId, hex] = match;
  const lowerHex = hex.toLowerCase();
  return {
    did: `did:algo:${network}:app:${appId}:${lowerHex}`,
    network,
    appId,
    publicKeyHex: lowerHex,
    publicKey: Uint8Array.from(Buffer.from(lowerHex, 'hex')),
  };
}

/**
 * Returns `true` iff `did` parses as a valid `did:algo` identifier.
 * Convenience wrapper around {@link parseDidAlgo} for invariant checks
 * (e.g. "the issuer DID MUST be `did:algo`").
 */
export function isDidAlgo(did: string): boolean {
  return DID_ALGO_PATTERN.test(did);
}

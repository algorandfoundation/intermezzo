/**
 * Utility helpers for the DID module that intentionally avoid pulling
 * in algosdk; only what algokit-utils v10 exports natively is used.
 */

/**
 * Big-endian uint64 encoding, matching `algosdk.encodeUint64`.
 * Used to derive box names that index into the `DIDAlgoStorage` boxes.
 */
export function encodeUint64(num: number | bigint): Uint8Array {
  const value = typeof num === 'bigint' ? num : BigInt(num);
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error('Input is not a 64-bit unsigned integer');
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value);
  return out;
}

/**
 * Map an Algorand `genesis-id` to the slug used in a `did:algo` identifier.
 * The mapping mirrors the one used by the reference `did-algo` CLI and
 * universal resolver driver.
 */
export function genesisIdToNetwork(genesisId: string | undefined | null): string {
  if (!genesisId) return 'localnet';
  if (genesisId === 'mainnet-v1.0') return 'mainnet';
  if (genesisId === 'testnet-v1.0') return 'testnet';
  if (genesisId === 'betanet-v1.0') return 'betanet';
  if (genesisId === 'fnet-v1' || genesisId.startsWith('fnet')) return 'fnet';
  if (genesisId.startsWith('dockernet') || genesisId.startsWith('sandnet') || genesisId.startsWith('private')) {
    return 'localnet';
  }
  return genesisId;
}

/**
 * Build the canonical `did:algo:<network>:app:<app-id>:<hex-pubkey>` identifier
 * for a user, given their raw ed25519 public key bytes.
 */
export function buildDidIdentifier(network: string, appId: bigint, publicKey: Uint8Array): string {
  const hex = Buffer.from(publicKey).toString('hex');
  return `did:algo:${network}:app:${appId.toString()}:${hex}`;
}

import { base58 } from '@scure/base';

/** Multicodec prefix (`0xed 0x01`) that identifies an ed25519 public key in a `did:key`. */
export const ED25519_MULTICODEC_PREFIX = Uint8Array.from([0xed, 0x01]);

/**
 * Decode the raw 32-byte ed25519 public key embedded in a
 * `did:key:z...` identifier. Throws if the identifier is not a
 * `did:key`, is not multibase-z, or does not carry the ed25519
 * multicodec prefix.
 */
export function decodeDidKeyEd25519(didKey: string): Uint8Array {
  if (!didKey.startsWith('did:key:')) {
    throw new Error(`Expected did:key, got "${didKey}"`);
  }
  const multibase = didKey.slice('did:key:'.length);
  if (!multibase.startsWith('z')) {
    throw new Error(`did:key ${didKey} is not multibase-z encoded`);
  }
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(multibase.slice(1));
  } catch {
    throw new Error(`did:key ${didKey} multibase payload is not valid base58`);
  }
  if (
    decoded.length !== 2 + 32 ||
    decoded[0] !== ED25519_MULTICODEC_PREFIX[0] ||
    decoded[1] !== ED25519_MULTICODEC_PREFIX[1]
  ) {
    throw new Error(`did:key ${didKey} is not an ed25519 key`);
  }
  return decoded.slice(2);
}

/**
 * Self-contained multibase / multicodec helpers used by the
 * `@algorandfoundation/credo-did-algo` plugin.
 *
 * The plugin can't depend on the host's `src/did/did-document.ts`
 * because that file is Intermezzo-specific and will not exist in
 * CREDEBL. Reproducing the small subset we actually need (ed25519
 * multicodec + minimal base58btc encode) keeps the package free of
 * `src/` imports.
 *
 * Behaviourally identical to `encodePublicKeyMultibase` in
 * `src/did/did-document.ts`; any change here must keep the wire output
 * byte-for-byte compatible with that function so the on-chain DID
 * documents and the in-package resolver agree on key encoding.
 */

const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

/**
 * Encode a 32-byte ed25519 public key as a multibase ed25519 multicodec
 * (base58btc, prefixed with `z`), as required by the
 * `Ed25519VerificationKey2020` data integrity suite.
 */
export function encodeEd25519PublicKeyMultibase(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return 'z' + base58btcEncode(prefixed);
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Minimal base58btc encoder — no third-party dependency required. */
export function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // count leading zeros
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // big-endian to base58
  const input = Array.from(bytes);
  const encoded: number[] = [];
  let start = zeros;
  while (start < input.length) {
    let carry = 0;
    for (let i = start; i < input.length; i++) {
      const v = (input[i] & 0xff) + carry * 256;
      input[i] = Math.floor(v / 58);
      carry = v % 58;
    }
    encoded.push(carry);
    while (start < input.length && input[start] === 0) start++;
  }

  let out = '';
  for (let i = 0; i < zeros; i++) out += BASE58_ALPHABET[0];
  for (let i = encoded.length - 1; i >= 0; i--) out += BASE58_ALPHABET[encoded[i]];
  return out;
}

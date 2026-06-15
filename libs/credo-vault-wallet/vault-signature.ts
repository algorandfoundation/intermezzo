/**
 * HashiCorp Vault returns ed25519 signatures as `vault:v<version>:<b64>`
 * strings, where the base64 payload is the raw 64-byte signature. This
 * helper normalises that envelope into raw bytes.
 *
 * The function is exported from the wallet package because the host's
 * Vault signer closure invariably needs to call it; it's pure (no
 * Vault SDK dependency) and worth $5 of duplication to keep here.
 */
export function parseVaultSignature(signature: string): Uint8Array {
  // Vault prefixes signatures with the key version: `vault:v<version>:<b64>`.
  // We strip everything up to the last colon to be tolerant of future
  // versions while still failing loudly on a totally unexpected shape.
  const lastColon = signature.lastIndexOf(':');
  if (lastColon < 0 || !signature.startsWith('vault:')) {
    throw new Error(`parseVaultSignature: unexpected Vault signature format: ${signature.slice(0, 32)}…`);
  }
  const b64 = signature.slice(lastColon + 1);
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length !== 64) {
    throw new Error(
      `parseVaultSignature: expected 64-byte ed25519 signature, got ${bytes.length} bytes (b64=${b64.slice(0, 16)}…)`,
    );
  }
  return new Uint8Array(bytes);
}

/**
 * Builders for W3C-compatible DID documents that follow the
 * conventions used by the `did:algo` method specification.
 *
 * The document published for every user in the vault references
 * the user's ed25519 public key as an `Ed25519VerificationKey2020`
 * verification method and lists it under `authentication`.
 */

export interface DidVerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
}

export interface DidServiceEntry {
  id: string;
  type: string;
  serviceEndpoint: string | Record<string, unknown>;
}

export interface DidDocument {
  '@context': (string | Record<string, unknown>)[];
  id: string;
  verificationMethod: DidVerificationMethod[];
  authentication: string[];
  assertionMethod?: string[];
  /**
   * Other identifiers this DID subject is known by. We use this to
   * surface a user's externally-linked Algorand wallet (added via the
   * link verification service) as a CAIP-10 account URI:
   * `algorand:<genesis-hash-prefix>:<address>` — but for simplicity we
   * publish it as `algorand:<address>` since the network segment is
   * already encoded in the DID itself.
   */
  alsoKnownAs?: string[];
  service?: DidServiceEntry[];
}

/**
 * A subkey extracted from the wallet's local manifest that the user has
 * elected to promote to a first-class verification method on the
 * on-chain `did:algo` document. Pure public-key data — no derivation
 * paths, origins, counters or other metadata cross this boundary.
 */
export interface PromotedVerificationMethod {
  /**
   * Stable fragment id (without the leading `#`) the wallet uses for
   * this subkey. Re-using the wallet's id keeps holder bindings stable
   * across re-publications.
   */
  fragment: string;
  /** Curve / suite of the underlying public key. */
  algorithm: 'Ed25519' | 'P-256';
  /** Raw public-key bytes (32 for Ed25519, 33 for compressed P-256). */
  publicKey: Uint8Array;
}

/**
 * On-chain commitment to the wallet-side device manifest at a specific
 * revision. The full manifest stays off chain; this entry lets any
 * resolver verify the manifest copy they're given matches what the
 * user has anchored.
 */
export interface ManifestAnchor {
  hash: string;
  version: number;
}

const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);
/**
 * P-256 multicodec varint (`0x1200` → `[0x80, 0x24]`). Matches the
 * encoding used by the chess-passport wallet so promoted P-256 keys
 * round-trip identically through both sides.
 */
const P256_MULTICODEC_PREFIX = new Uint8Array([0x80, 0x24]);

/**
 * Encode a 32-byte ed25519 public key as a multibase ed25519 multicodec
 * (base58btc, prefixed with `z`), as required by the
 * `Ed25519VerificationKey2020` data integrity suite.
 */
export function encodePublicKeyMultibase(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return 'z' + base58btcEncode(prefixed);
}

/**
 * Encode a P-256 public key (compressed form, 33 bytes) as a multibase
 * P-256 multicodec value, suitable for `JsonWebKey2020` /
 * `Multikey`-style verification methods.
 */
export function encodeP256PublicKeyMultibase(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(P256_MULTICODEC_PREFIX.length + publicKey.length);
  prefixed.set(P256_MULTICODEC_PREFIX, 0);
  prefixed.set(publicKey, P256_MULTICODEC_PREFIX.length);
  return 'z' + base58btcEncode(prefixed);
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Minimal base58btc encoder — no third-party dependency required. */
function base58btcEncode(bytes: Uint8Array): string {
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

export interface BuildDocumentParams {
  did: string;
  publicKey: Uint8Array;
  /**
   * Optional Algorand address the user has externally linked via the
   * link verification service. When supplied, it is published in the
   * DID document under `alsoKnownAs` as `algorand:<address>` so
   * resolvers can correlate the DID with the user's on-chain wallet.
   *
   * **Note:** the linked wallet address is *not* used as a
   * verification method any more — see `identityPublicKey` for the
   * `#keys-2` slot. Algorand payment keys are surfaced as
   * `alsoKnownAs` (and optionally as a non-identity-purpose VM in the
   * future), but identity-purpose signatures (OID4VCI proofs, DID
   * authentication, credential `cnf`) bind to the wallet's primary
   * identity key, not the on-chain payment account.
   */
  linkedWalletAddress?: string | null;
  /**
   * The wallet's primary device-held identity ed25519 public key —
   * sourced from the device manifest's `did:key` primary verification
   * method. When supplied it is published as `#keys-2` and added to
   * `authentication` / `assertionMethod`. This is the key the wallet
   * actually signs OID4VCI proof JWTs / DID-Auth assertions with.
   */
  identityPublicKey?: Uint8Array | null;
  /**
   * Public keys promoted from the user's wallet device manifest so
   * credentials can be cryptographically bound to wallet-managed
   * subkeys (HD-derived account keys, passkey keys, etc.). Each entry
   * becomes a fully-fledged on-chain verification method.
   */
  promotedKeys?: PromotedVerificationMethod[];
  /**
   * Anchor for the off-chain device manifest. When present, a
   * `DeviceManifestAnchor` service entry is published so a resolver
   * can verify any backend-served manifest against the on-chain hash.
   */
  manifestAnchor?: ManifestAnchor;
  /**
   * Explicit owner / controller DID for this document. When provided
   * the verification methods are declared as controlled by this DID
   * (typically a `did:key` held by an end user), instead of by the
   * `did:algo` itself. The owner DID is also surfaced in
   * `alsoKnownAs` so resolvers can follow the ownership relation
   * without parsing the verification method graph.
   *
   * Used by the "uncontrolled" `did:algo` flow where the manager
   * pays for the on-chain box write but the cryptographic key
   * material lives exclusively in the holder's wallet.
   */
  controllerDid?: string | null;
}

/**
 * Build a minimal DID document that uses the supplied ed25519 public key
 * as both an authentication and assertion method. When the user has a
 * linked Algorand wallet (from the link verification service), it is
 * surfaced in `alsoKnownAs` as a CAIP-style `algorand:<address>` URI.
 */
export function buildDidDocument({
  did,
  publicKey,
  linkedWalletAddress,
  identityPublicKey,
  promotedKeys,
  manifestAnchor,
  controllerDid,
}: BuildDocumentParams): DidDocument {
  const keyId = `${did}#keys-1`;
  const vmController = controllerDid && controllerDid.length > 0 ? controllerDid : did;
  const doc: DidDocument = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
    id: did,
    verificationMethod: [
      {
        id: keyId,
        type: 'Ed25519VerificationKey2020',
        controller: vmController,
        publicKeyMultibase: encodePublicKeyMultibase(publicKey),
      },
    ],
    authentication: [keyId],
    assertionMethod: [keyId],
  };
  if (controllerDid && controllerDid.length > 0) {
    // Surface the owner DID via `alsoKnownAs` so resolvers can follow
    // the ownership relation without inspecting the verification
    // method graph. This is the canonical link from an "uncontrolled"
    // `did:algo` back to the holder's `did:key`.
    doc.alsoKnownAs = [...(doc.alsoKnownAs ?? []), controllerDid];
  }
  if (identityPublicKey && identityPublicKey.length > 0) {
    // The wallet's primary device-held identity key (the `did:key`
    // primary VM from the device manifest). This is the key the wallet
    // actually signs OID4VCI proof JWTs / DID-Auth assertions with — so
    // it's the canonical "user signer" verification method, and we
    // place it at `#keys-2` for stable kid resolution.
    const identityKeyId = `${did}#keys-2`;
    doc.verificationMethod.push({
      id: identityKeyId,
      type: 'Ed25519VerificationKey2020',
      controller: did,
      publicKeyMultibase: encodePublicKeyMultibase(identityPublicKey),
    });
    doc.authentication.push(identityKeyId);
    doc.assertionMethod = [...(doc.assertionMethod ?? []), identityKeyId];
  }
  if (linkedWalletAddress) {
    // Algorand payment account address, surfaced for correlation only —
    // it is **not** an identity verification method (the wallet doesn't
    // sign OID4VCI proofs with the payment key). The CAIP-style URI
    // lets resolvers tie the DID to the user's on-chain wallet without
    // implying the payment key is usable for DID-Auth or assertions.
    doc.alsoKnownAs = [...(doc.alsoKnownAs ?? []), `algorand:${linkedWalletAddress}`];
  }
  if (promotedKeys && promotedKeys.length > 0) {
    // De-duplicate by fragment so a wallet that re-pushes the same key
    // under a stable id never produces two entries.
    const seen = new Set(doc.verificationMethod.map((vm) => vm.id));
    for (const promoted of promotedKeys) {
      const id = `${did}#${promoted.fragment}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const isP256 = promoted.algorithm === 'P-256';
      doc.verificationMethod.push({
        id,
        type: isP256 ? 'JsonWebKey2020' : 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyMultibase: isP256
          ? encodeP256PublicKeyMultibase(promoted.publicKey)
          : encodePublicKeyMultibase(promoted.publicKey),
      });
      doc.authentication.push(id);
      doc.assertionMethod = [...(doc.assertionMethod ?? []), id];
    }
  }
  if (manifestAnchor) {
    const anchorEntry: DidServiceEntry = {
      id: `${did}#manifest`,
      type: 'DeviceManifestAnchor',
      serviceEndpoint: {
        hash: manifestAnchor.hash,
        version: manifestAnchor.version,
      },
    };
    doc.service = [...(doc.service ?? []), anchorEntry];
  }
  return doc;
}

/**
 * Application-level mapping for an OID4VCI issuance session.
 *
 * Credo persists the canonical session state inside its own (Askar) wallet.
 * This entity stores additional business context (which holder `did:key`
 * the offer was pinned to, which credential configuration was offered,
 * current status) so that other Nest modules can correlate Credo
 * records with our domain without depending on Credo internals.
 *
 * Post‑v2: the only "user" identifier we persist is the wallet-local
 * `did:key` the offer is bound to — there is no server-side user
 * record.
 */
export class Oid4vcIssuanceSession {
  [key: string]: unknown;
  id: string;

  /**
   * Identifier of the Credo OpenId4VcIssuanceSessionRecord. Filled in once the
   * Credo agent has produced the offer and given us its session id.
   */
  credoIssuanceSessionId?: string;

  /**
   * Issuer record id used inside Credo (matches `OpenId4VcIssuerRecord.issuerId`).
   */
  issuerId: string;

  /**
   * The wallet-local `did:key` the offer is pinned to. Captured by the
   * offer-creation endpoint (proven via `CredentialAuthGuard`, which
   * extracts the holder `did:key` from the wallet's device-attestation
   * credential) and enforced by the credential mapper at redemption
   * time. Nullable
   * only because Credo persists this entity row before the offer is
   * finalised; the mapper rejects any session that lacks it.
   */
  holderDidKey?: string;

  /**
   * Credential configuration ids that were offered.
   */
  offeredCredentialConfigurationIds: string[];

  /**
   * Pre-authorized code or transaction code if any. Stored only for traceability
   * - Credo holds the authoritative copy.
   */
  preAuthorizedCode?: string;

  /**
   * Full credential offer URI returned to the wallet (use this to render QR).
   */
  credentialOffer: string;

  state: string;

  /**
   * Free-form metadata persisted alongside the offer (e.g. the actual claim
   * payload that should be issued when the wallet redeems the offer).
   */
  issuanceMetadata?: Record<string, unknown>;

  createdAt: Date;

  updatedAt: Date;
}

/**
 * Application-level mapping for an OID4VP verification session.
 *
 * Credo holds the canonical OpenId4VcVerificationSessionRecord; this
 * entity is for business-level correlation (which presentation
 * definition was used, current state, last verified payload).
 *
 * Post‑v2: verification requests are not pinned to a server-side user
 * — any wallet can satisfy a request — so there is no `userId`
 * column. Callers that need a correlation handle (e.g. a checkout
 * flow tying a verification to a basket id) should pass it on the
 * presentation definition or look the session up by id.
 */
export class Oid4vcVerificationSession {
  [key: string]: unknown;
  id: string;

  /**
   * Identifier of the Credo OpenId4VcVerificationSessionRecord.
   */
  credoVerificationSessionId?: string;

  /**
   * Verifier record id used inside Credo (`OpenId4VcVerifierRecord.verifierId`).
   */
  verifierId: string;

  /**
   * Encoded `openid4vp://` (or `openid://`) authorization request URI to render
   * as a QR code for the wallet.
   */
  authorizationRequest: string;

  /**
   * The DIF presentation definition that was requested.
   */
  presentationDefinition?: Record<string, unknown>;

  state: string;

  /**
   * Once the wallet responds with a presentation and Credo verifies it, the
   * extracted claims are persisted here so downstream business logic can react.
   */
  verifiedClaims?: Record<string, unknown>;

  createdAt: Date;

  updatedAt: Date;
}

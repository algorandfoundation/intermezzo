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
export type Oid4vcVerificationOutcome = 'pending' | 'verified' | 'revoked' | 'failed';

/** Translate Credo's session state into the stable outcome exposed by this service. */
export function verificationOutcome(state: string, errorMessage?: string): Oid4vcVerificationOutcome {
  if (state === 'ResponseVerified') return 'verified';
  if (state !== 'Error') return 'pending';
  return errorMessage?.includes('Status is not valid') ? 'revoked' : 'failed';
}

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

  /** Stable application result; unlike Credo's error text, safe for callers to relay. */
  outcome: Oid4vcVerificationOutcome;

  /**
   * Once the wallet responds with a presentation and Credo verifies it, the
   * extracted claims are persisted here so downstream business logic can react.
   */
  verifiedClaims?: Record<string, unknown>;

  createdAt: Date;

  updatedAt: Date;
}

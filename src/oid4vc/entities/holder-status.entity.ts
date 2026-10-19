import { StatusChange } from './oid4vc-issuance-session.entity';

/**
 * Status of a holder `did:key` as a whole, set by revoking or reactivating by
 * `holderDidKey`.
 *
 * It coordinates one change across every issuance session pinned to the
 * holder, and fences issuance: while its change is pending, or the holder is
 * revoked, none of the holder's offers can be redeemed, including offers
 * created after the revocation.
 */
export class HolderStatus {
  [key: string]: unknown;

  /** The did:key's multibase value, the same segment the `by-holder` index uses. */
  id: string;

  holderDidKey: string;

  /**
   * Durable intent. Its id is shared with the session intents the change
   * fans out to, and a pending change is resumed by the same request.
   */
  statusChange?: StatusChange;

  /** When the holder was revoked, if it is. */
  revokedAt?: Date;

  /** Operator-supplied note recorded alongside {@link revokedAt}. */
  revokedReason?: string;

  createdAt: Date;

  updatedAt: Date;
}

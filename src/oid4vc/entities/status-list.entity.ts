/**
 * One IETF Token Status List (draft-ietf-oauth-status-list), backing
 * revocation of the SD-JWT VCs this service issues.
 *
 * A single record holds the whole list: a fixed-size bitstring plus the
 * high-water mark of allocated indices. Credentials point at an entry with a
 * `status.status_list` claim, and verifiers dereference the list over HTTP as
 * a signed `statuslist+jwt`.
 */
export class StatusListRecord {
  [key: string]: unknown;

  /** List identifier, and the last path segment of its public URI. */
  id: string;

  /**
   * Bits per status. Fixed at 1: `0` valid, `1` revoked.
   *
   * The draft also defines `0x02 SUSPENDED`, which needs 2 bits. It is not
   * worth the width here: `@sd-jwt`'s default status validator rejects every
   * non-zero status identically, so a suspended credential would behave
   * exactly like a revoked one until a verifier opts into a custom validator.
   */
  bits: 1;

  /**
   * Number of entries in the bitstring.
   *
   * Persisted per record rather than read from {@link STATUS_LIST_SIZE} at
   * use time, so a list already in Vault keeps the length it was created with
   * even if the constant changes.
   */
  size: number;

  /** Next index to hand out. Only ever increases. */
  nextIndex: number;

  /** Deflated, base64url-encoded bitstring (`StatusList.compressStatusList()`). */
  encodedList: string;

  createdAt: Date;

  updatedAt: Date;
}

/** A credential whose entry reads `0` is valid. */
export const STATUS_VALID = 0;

/** A credential whose entry reads `1` is revoked, and fails verification. */
export const STATUS_REVOKED = 1;

/**
 * Entries a status list is created with.
 *
 * The bitstring is allocated full-length up front with every entry valid, so
 * issuing a credential only has to hand out the next index. Unused entries
 * are almost free once deflated — 16384 of them compress to 36 bytes.
 *
 * Deliberately a constant and not configuration: nobody tunes a bitstring
 * length per deployment, and the answer at capacity is a second list, not a
 * longer one.
 */
export const STATUS_LIST_SIZE = 16384;

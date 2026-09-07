/**
 * Which key material backs a user's Algorand account.
 *
 * `ed25519` keys live in the transit mount, `falcon1024` keys in the
 * `algorand-pq` mount. The mount a `user_id` exists in is the only
 * source of truth for this — nothing records it separately, so the
 * two can never disagree.
 */
export type AccountType = 'ed25519' | 'falcon1024';

export interface UserInfoDto {
  user_id: string;
  public_address: string;
  account_type: AccountType;
}

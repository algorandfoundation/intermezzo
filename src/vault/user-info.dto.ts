/**
 * Which key material backs a user's Algorand account.
 *
 * `ed25519` keys live in transit; `falcon1024` keys live in the
 * `algorand-pq` mount.
 */
export type AccountType = 'ed25519' | 'falcon1024';

export interface UserInfoDto {
  user_id: string;
  public_address: string;
  account_type: AccountType;
}

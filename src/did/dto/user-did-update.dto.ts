import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsObject, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Request body for `POST /did/create/transactions`.
 *
 * Empty by default — the contract create txn group depends only on
 * the credential-bound `did:key` (extracted from the SD-JWT VC's
 * `cnf.kid`) and the manager Vault key, both of which are resolved
 * server-side. Reserved as a class so we can extend it with options
 * later (e.g. dispenser overrides for non-localnet networks) without
 * breaking the wire schema.
 */
export class BuildUserContractCreateDto {}

/**
 * Request body for `POST /did/create/submit`. Carries the wallet's
 * `signTransactions(txnGroup, indexesToSign)` return array for the
 * single create-app atomic group. Position 2 (the `appl` create) is
 * the only required signature; positions 0 and 1 (manager-funded
 * `pay`s) are filled by the host at submit time, after validating
 * the wallet-signed bytes match the canonical bytes the server just
 * rebuilt.
 */
export class SubmitUserContractCreateDto {
  @ApiProperty({
    description:
      'Wallet-signed transactions in canonical group order, base64-encoded. Mirrors the ' +
      '`(Uint8Array | null)[]` returned by `signTransactions(txnGroup, indexesToSign)`: one ' +
      'entry per position in the original `txnGroup`, with `null` at every position the ' +
      'wallet did not sign. The host signs manager positions at submit time after byte-for-byte ' +
      'validation against the server-rebuilt canonical bytes.',
    type: [String],
    nullable: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  signedTxns: (string | null)[];
}

/**
 * Request body for `POST /did/update/transactions`.
 *
 * The `document` field is **optional**: when omitted the host
 * regenerates the canonical wallet-owned DID Document for the user's
 * `did:key`, so a wallet that just wants to "republish without
 * changes" can call this endpoint with an empty body.
 */
export class BuildUserDidDocumentUpdateDto {
  @ApiPropertyOptional({
    description:
      'Replacement DID document. When omitted, the canonical wallet-owned ' +
      'document (with the user `did:key` as `alsoKnownAs` controller) is used.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  document?: Record<string, unknown>;
}

/** Single signed group in {@link SubmitUserDidDocumentUpdateDto}. */
export class SignedUserDidUpdateGroupDto {
  @ApiProperty({
    description:
      'Wallet-signed transactions in canonical group order, base64-encoded. Mirrors the ' +
      '`(Uint8Array | null)[]` returned by `signTransactions(txnGroup, indexesToSign)`: one ' +
      'entry per position in the original `txnGroup`, with `null` at every position the ' +
      'wallet did not sign. The host signs manager positions at submit time after byte-for-byte ' +
      'validation against the server-rebuilt canonical bytes.',
    type: [String],
    nullable: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  signedTxns: (string | null)[];
}

/**
 * Request body for `POST /did/update/submit`.
 *
 * Carries the wallet's signed groups **and** the exact `document`
 * payload that was sent on `POST /did/update/transactions`. The host
 * rebuilds the unsigned canonical groups from this document and
 * validates the wallet-signed bytes match position-by-position
 * before signing the manager positions.
 */
export class SubmitUserDidDocumentUpdateDto {
  @ApiProperty({
    description:
      'The exact DID document that was supplied on the matching `POST /did/update/transactions` ' +
      'call. Used by the host to rebuild the canonical unsigned groups and validate every ' +
      'wallet-signed position byte-for-byte before committing its own signatures.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  document: Record<string, unknown>;

  @ApiProperty({
    description:
      'Atomic groups produced by the build endpoint, each now wallet-signed. Submitted ' +
      'serially in order. The host signs manager positions at submit time after validating ' +
      'wallet-signed positions match the rebuilt canonical bytes.',
    type: [SignedUserDidUpdateGroupDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SignedUserDidUpdateGroupDto)
  groups: SignedUserDidUpdateGroupDto[];
}

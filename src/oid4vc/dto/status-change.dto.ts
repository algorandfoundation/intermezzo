import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body of the revoke / reactivate endpoints.
 *
 * A credential is addressed by the issuance session it was issued under,
 * because that record is what carries the `statusEntries` written when the
 * offer was redeemed. A session that redeemed more than once holds an entry
 * per credential, and the endpoints act on all of them together.
 *
 * `holderDidKey` instead names every issuance session pinned to that holder.
 *
 * Exactly one of `sessionId`, `credoIssuanceSessionId` or `holderDidKey`,
 * enforced by `Oid4vcStatusService`.
 */
export class ChangeCredentialStatusDto {
  @ApiPropertyOptional({
    description:
      'Local (Vault) issuance session id: the `id` returned when the offer is created. ' +
      'Listed by `GET credential/issuer/sessions`, which also exposes the assigned status list entry. ' +
      'Mutually exclusive with `credoIssuanceSessionId` and `holderDidKey`.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sessionId?: string;

  @ApiPropertyOptional({
    description:
      'Credo issuance session id, also returned when the offer is created. ' +
      'Mutually exclusive with `sessionId` and `holderDidKey`.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  credoIssuanceSessionId?: string;

  @ApiPropertyOptional({
    description:
      'Holder `did:key`: acts on every issuance session pinned to it, including offers not yet redeemed, ' +
      'which can then no longer issue. Mutually exclusive with `sessionId` and `credoIssuanceSessionId`.',
    example: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  holderDidKey?: string;

  @ApiPropertyOptional({
    description: 'Note recorded alongside the revocation for audit. Ignored when reactivating.',
    example: 'device reported stolen',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

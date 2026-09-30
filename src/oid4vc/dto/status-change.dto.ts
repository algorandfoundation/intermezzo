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
 * Exactly one of `sessionId` or `credoIssuanceSessionId`, enforced by
 * `Oid4vcStatusService`.
 */
export class ChangeCredentialStatusDto {
  @ApiPropertyOptional({
    description:
      'Local (Vault) issuance session id: the `id` returned when the offer is created. ' +
      'Listed by `GET credential/issuer/sessions`, which also exposes the assigned status list entry. ' +
      'Mutually exclusive with `credoIssuanceSessionId`.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sessionId?: string;

  @ApiPropertyOptional({
    description:
      'Credo issuance session id, also returned when the offer is created. Mutually exclusive with `sessionId`.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  credoIssuanceSessionId?: string;

  @ApiPropertyOptional({
    description: 'Note recorded alongside the revocation for audit. Ignored when reactivating.',
    example: 'device reported stolen',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

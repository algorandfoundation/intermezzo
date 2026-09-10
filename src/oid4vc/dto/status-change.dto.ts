import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body of the revoke / reactivate endpoints.
 *
 * A credential is addressed by the issuance session it was issued under,
 * because that record is what carries the `statusEntries` written when the
 * offer was redeemed. A session that redeemed more than once holds an entry
 * per credential, and the endpoints act on all of them together.
 */
export class ChangeCredentialStatusDto {
  @ApiProperty({
    description:
      'Local issuance session id of the credential to act on. ' +
      'Listed by `GET credential/issuer/sessions`, which also exposes the assigned status list entry.',
  })
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @ApiPropertyOptional({
    description: 'Note recorded alongside the revocation for audit. Ignored when reactivating.',
    example: 'device reported stolen',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

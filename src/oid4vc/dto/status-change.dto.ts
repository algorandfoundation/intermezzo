import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min, ValidateIf } from 'class-validator';

/**
 * Body of the revoke / reactivate endpoints.
 *
 * Exactly one addressing form must be supplied:
 *  - `holderDidKey` (optionally narrowed by `credentialConfigurationId`) acts on every credential issued to that
 *    holder — the natural handle when a session id was never recorded or has been lost.
 *  - `uri` + `idx`, the pair embedded in a credential's `status.status_list` claim, acts on the single credential
 *    that entry was allocated to, leaving its siblings from the same offer untouched. Supplying one half without
 *    the other is rejected rather than treated as the holder form.
 *
 * Either form acts on the matched credentials' own status list entries only. A session cannot be addressed
 * directly: `sessionId` is not accepted, because losing it would otherwise make a credential permanently
 * unrevokable.
 */
export class ChangeCredentialStatusDto {
  @ApiPropertyOptional({
    description: 'Holder `did:key` to act on every credential issued to. Mutually exclusive with `uri`/`idx`.',
    example: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
  })
  @ValidateIf((dto: ChangeCredentialStatusDto) => dto.uri === undefined)
  @IsString()
  @IsNotEmpty()
  @Matches(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/u, {
    message: 'holderDidKey must be a valid did:key identifier (multibase-encoded ed25519/p-256 key).',
  })
  holderDidKey?: string;

  @ApiPropertyOptional({
    description: 'Restricts `holderDidKey` to credentials issued under this configuration id. Ignored with `uri`.',
    example: 'device-attestation-credential',
  })
  @IsOptional()
  @IsString()
  // Rejected rather than ignored: `''` would otherwise read as "no filter" and
  // silently widen a narrowed revocation to every credential the holder has.
  @IsNotEmpty({ message: 'credentialConfigurationId must not be empty; omit it to act on every configuration.' })
  credentialConfigurationId?: string;

  @ApiPropertyOptional({
    description:
      "Status list URI from a credential's `status.status_list.uri`. Mutually exclusive with `holderDidKey`.",
    example: 'https://issuer.example/v1/credential/status/list/f538cd53-79e5-4877-b6c2-51c09c51f8ab',
  })
  @ValidateIf((dto: ChangeCredentialStatusDto) => dto.holderDidKey === undefined)
  @IsString()
  @IsNotEmpty()
  uri?: string;

  @ApiPropertyOptional({
    description: "Status list index from a credential's `status.status_list.idx`. Required with `uri`.",
    example: 42,
  })
  @ValidateIf((dto: ChangeCredentialStatusDto) => dto.uri !== undefined)
  @IsInt()
  @Min(0)
  idx?: number;

  @ApiPropertyOptional({
    description: 'Note recorded alongside the revocation for audit. Ignored when reactivating.',
    example: 'device reported stolen',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

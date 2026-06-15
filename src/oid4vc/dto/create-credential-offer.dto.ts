import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsNotEmpty, IsObject, IsOptional, IsString, Matches } from 'class-validator';

/**
 * Body of `POST /v1/oid4vc/issuer/offers`.
 *
 * Post‑v2 the offer is pinned to a wallet-local `did:key` rather than
 * an internal user id. The API edge proves the caller controls that
 * DID (via `CredentialAuthGuard`, which extracts the holder `did:key`
 * from the wallet's device-attestation credential); the issuer
 * service merely persists the binding and enforces it inside
 * `buildCredentialMapper` at redemption time.
 */
export class CreateCredentialOfferDto {
  @ApiProperty({
    description:
      'Credential configuration ids that the wallet should be offered. Must match ids declared by the issuer ' +
      '(e.g. `device-attestation-credential`).',
    example: ['device-attestation-credential'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  credentialConfigurationIds!: string[];

  @ApiProperty({
    description:
      'The wallet-local `did:key` the credential will be bound to. Required: every credential is pinned to a ' +
      'holder DID at offer-creation time, and the credential mapper rejects the redemption proof if the wallet ' +
      'asserts a different DID.',
    example: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/u, {
    message: 'holderDidKey must be a valid did:key identifier (multibase-encoded ed25519/p-256 key).',
  })
  holderDidKey!: string;

  @ApiPropertyOptional({
    description:
      'Arbitrary metadata persisted with the issuance session. Typically the actual claim values that should be ' +
      'embedded in the credential when the wallet redeems the offer.',
    example: { rewardTier: 'gold', earnedAt: '2025-05-06T16:00:00.000Z' },
  })
  @IsOptional()
  @IsObject()
  issuanceMetadata?: Record<string, unknown>;
}

export class CredentialOfferResponseDto {
  @ApiProperty({ description: 'Local (Vault) issuance session id used by this service.' })
  id!: string;

  @ApiProperty({ description: 'Id of the underlying Credo OpenId4VcIssuanceSessionRecord.' })
  credoIssuanceSessionId!: string;

  @ApiProperty({
    description: 'Credential offer URI (`openid-credential-offer://...`). Render this as a QR code for the wallet.',
  })
  credentialOffer!: string;

  @ApiProperty({ description: 'Current state of the Credo issuance session.' })
  state!: string;

  @ApiProperty({
    description: 'The wallet-local `did:key` the offer is pinned to.',
    example: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
  })
  holderDidKey!: string;
}

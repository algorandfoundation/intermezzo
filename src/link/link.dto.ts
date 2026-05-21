import { ApiProperty } from '@nestjs/swagger';
import { IsBase64, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class IssueChallengeDto {
  @ApiProperty({
    description: 'Wallet-local `did:key` (ed25519, multibase-z) the challenge will be bound to.',
    example: 'did:key:z6Mkpz...',
  })
  @IsString()
  @Matches(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/u, { message: 'didKey must be a multibase-z `did:key`' })
  didKey!: string;
}

export class IssueChallengeResponseDto {
  @ApiProperty({ description: 'Opaque single-use nonce the wallet must sign with its did:key.' })
  nonce!: string;

  @ApiProperty({ description: 'ISO timestamp after which the challenge is no longer redeemable.' })
  expiresAt!: string;
}

export class RedeemAttestationDto {
  @ApiProperty({
    description: 'The same `did:key` the challenge was issued to. The server verifies the signature against it.',
  })
  @IsString()
  @Matches(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/u, { message: 'didKey must be a multibase-z `did:key`' })
  didKey!: string;

  @ApiProperty({
    description: 'The nonce returned by `POST /v1/link/challenge`. Must belong to the calling did:key.',
  })
  @IsString()
  @MinLength(1)
  nonce!: string;

  @ApiProperty({
    description:
      'base64-encoded EdDSA signature over the raw UTF-8 bytes of `nonce`, produced by the private key of the ' +
      "caller's did:key. The server verifies it against the public key encoded in the did:key.",
  })
  @IsBase64()
  signature!: string;

  @ApiProperty({
    description:
      'OS device-attestation blob (Apple App Attest assertion / Play Integrity verdict). Validated inline by ' +
      '`LinkService` — this is the single point where device attestation is enforced; once the ' +
      'credential is minted it transitively vouches for this check on every subsequent call.',
  })
  @IsOptional()
  @IsString()
  deviceAttestation?: string;
}

export class RedeemAttestationResponseDto {
  @ApiProperty({ description: 'The calling did:key (echoed for client-side correlation).' })
  didKey!: string;

  @ApiProperty({ description: 'Local OID4VCI issuance session id for the device-attestation credential offer.' })
  issuanceSessionId!: string;

  @ApiProperty({ description: 'Credential-offer URI (deep link) the wallet redeems to pick up the credential.' })
  credentialOfferUri!: string;
}

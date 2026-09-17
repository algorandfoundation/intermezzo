import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import type { Oid4vcVerificationOutcome } from '../entities/oid4vc-verification-session.entity';

export class CreatePresentationRequestDto {
  @ApiProperty({
    description: 'DIF Presentation Definition v2. The wallet will be asked to satisfy this definition.',
    example: {
      id: 'rewards-eligibility',
      input_descriptors: [
        {
          id: 'device-attestation-credential',
          format: { 'vc+sd-jwt': { 'sd-jwt_alg_values': ['EdDSA'] } },
          constraints: {
            fields: [{ path: ['$.vct'], filter: { type: 'string', const: 'device-attestation-credential' } }],
          },
        },
      ],
    },
  })
  @IsObject()
  presentationDefinition!: Record<string, unknown>;
}

export class PresentationRequestResponseDto {
  @ApiProperty({ description: 'Local verification session id.' })
  id!: string;

  @ApiProperty({ description: 'Id of the underlying Credo OpenId4VcVerificationSessionRecord.' })
  credoVerificationSessionId!: string;

  @ApiProperty({
    description: 'Authorization request URI (`openid4vp://...` or `openid://...`). Render this as a QR code.',
  })
  authorizationRequest!: string;

  @ApiProperty({ description: 'Current state of the Credo verification session.' })
  state!: string;

  @ApiProperty({ enum: ['pending', 'verified', 'revoked', 'failed'] })
  outcome!: Oid4vcVerificationOutcome;
}

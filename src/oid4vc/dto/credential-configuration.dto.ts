import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, IsOptional, IsArray, IsObject } from 'class-validator';
import { OpenId4VciCredentialFormatProfile } from '@credo-ts/openid4vc';

/**
 * DTO for creating or updating a dynamic credential configuration.
 *
 * This matches the shape of a single entry in `OpenId4VciCredentialConfigurationsSupported`,
 * providing explicit validation for key fields while allowing for the flexibility
 * required by the OID4VCI spec.
 */
export class SetCredentialConfigurationDto {
  @ApiProperty({
    enum: OpenId4VciCredentialFormatProfile,
    description: 'Format of the credential (e.g. `vc+sd-jwt`, `jwt_vc_json`).',
    example: OpenId4VciCredentialFormatProfile.SdJwtVc,
  })
  @IsEnum(OpenId4VciCredentialFormatProfile)
  format!: OpenId4VciCredentialFormatProfile;

  @ApiProperty({
    description: 'Verifiable Credential Type (required if format is `vc+sd-jwt`).',
    example: 'my-custom-credential',
    required: false,
  })
  @IsString()
  @IsOptional()
  vct?: string;

  @ApiProperty({
    description: 'Supported cryptographic binding methods.',
    example: ['did:key', 'did:algo'],
    required: false,
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  cryptographic_binding_methods_supported?: string[];

  @ApiProperty({
    description: 'Supported credential signing algorithms.',
    example: ['EdDSA'],
    required: false,
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  credential_signing_alg_values_supported?: string[];

  @ApiProperty({
    description: 'Credential definition (used by W3C formats like `jwt_vc_json`).',
    required: false,
  })
  @IsObject()
  @IsOptional()
  credential_definition?: Record<string, unknown>;

  @ApiProperty({
    description: 'OAuth2 scope associated with this configuration.',
    required: false,
  })
  @IsString()
  @IsOptional()
  scope?: string;

  @ApiProperty({
    description: 'Additional display metadata for the wallet.',
    required: false,
  })
  @IsArray()
  @IsOptional()
  display?: Record<string, unknown>[];

  /**
   * Catch-all for any other OID4VCI-compliant properties.
   */
  [key: string]: unknown;
}

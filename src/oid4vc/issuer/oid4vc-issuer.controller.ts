import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Oid4vcIssuerService } from './oid4vc-issuer.service';
import { CreateCredentialOfferDto, CredentialOfferResponseDto } from '../dto/create-credential-offer.dto';
import { SetCredentialConfigurationDto } from '../dto/credential-configuration.dto';
import { Oid4vcIssuanceSession } from '../entities/oid4vc-issuance-session.entity';

/**
 * HTTP surface for OID4VCI session orchestration.
 *
 * The controller is responsible for the *application-side* of issuance:
 * creating offers (so the front-end can render a QR code) and
 * inspecting sessions. The OID4VCI protocol endpoints themselves
 * (token, credential, credential offer fetch) are exposed by Credo on
 * its own Express router, mounted under `OID4VC_ISSUER_PATH` in
 * `main.ts`.
 *
 * Auth model (post‑v2): gated by the global manager `AuthGuard`
 * (`Authorization: Bearer <manager-JWT>`).
 */
@ApiTags('OID4VC')
@ApiBearerAuth()
@Controller('credential/issuer')
export class Oid4vcIssuerController {
  constructor(private readonly issuer: Oid4vcIssuerService) {}

  @Get('configurations')
  @ApiOperation({
    summary: 'Returns the credential configurations advertised by this issuer (defaults + dynamic from Vault).',
  })
  async listCredentialConfigurations() {
    return this.issuer.getCredentialConfigurations();
  }

  @Post('configurations/:id')
  @ApiOperation({
    summary: 'Add or update a dynamic credential configuration in Vault.',
  })
  async setCredentialConfiguration(@Param('id') id: string, @Body() config: SetCredentialConfigurationDto) {
    await this.issuer.setCredentialConfiguration(id, config);
    return { success: true };
  }

  @Delete('configurations/:id')
  @ApiOperation({
    summary: 'Remove a dynamic credential configuration from Vault.',
  })
  async removeCredentialConfiguration(@Param('id') id: string) {
    await this.issuer.removeCredentialConfiguration(id);
    return { success: true };
  }

  @Post('offers')
  @ApiOperation({
    summary: 'Create a pre-authorized OID4VCI credential offer pinned to the supplied wallet-local `did:key`.',
  })
  async createOffer(@Body() dto: CreateCredentialOfferDto): Promise<CredentialOfferResponseDto> {
    const session = await this.issuer.createOffer({
      credentialConfigurationIds: dto.credentialConfigurationIds,
      holderDidKey: dto.holderDidKey,
      issuanceMetadata: dto.issuanceMetadata,
    });
    return toResponse(session);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List all locally-tracked issuance sessions.' })
  async listSessions(): Promise<Oid4vcIssuanceSession[]> {
    return this.issuer.listSessions();
  }

  @Get('sessions/:id')
  @ApiOperation({ summary: 'Get a single issuance session by local id.' })
  async getSession(@Param('id') id: string): Promise<Oid4vcIssuanceSession> {
    return this.issuer.findSession(id);
  }
}

function toResponse(session: Oid4vcIssuanceSession): CredentialOfferResponseDto {
  return {
    id: session.id,
    credoIssuanceSessionId: session.credoIssuanceSessionId ?? '',
    credentialOffer: session.credentialOffer,
    state: session.state,
    holderDidKey: session.holderDidKey ?? '',
  };
}

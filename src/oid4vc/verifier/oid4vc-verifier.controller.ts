import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Oid4vcVerifierService } from './oid4vc-verifier.service';
import { CreatePresentationRequestDto, PresentationRequestResponseDto } from '../dto/create-presentation-request.dto';
import { Oid4vcVerificationSession } from '../entities/oid4vc-verification-session.entity';

/**
 * HTTP surface for OID4VP / SIOP verification orchestration.
 *
 * Same split as the issuer controller: the protocol endpoints (authorization,
 * authorization request) are mounted by Credo on its own router under
 * `OID4VC_VERIFIER_PATH`. These routes here are app-level helpers used by the
 * front-end to start a verification flow and poll for the result.
 */
@ApiTags('OID4VC')
@ApiBearerAuth()
@Controller('credential/verifier')
export class Oid4vcVerifierController {
  constructor(private readonly verifier: Oid4vcVerifierService) {}

  @Post('requests')
  @ApiOperation({ summary: 'Create an OID4VP authorization request and return its URI for QR rendering.' })
  async createRequest(@Body() dto: CreatePresentationRequestDto): Promise<PresentationRequestResponseDto> {
    const session = await this.verifier.createPresentationRequest({
      presentationDefinition: dto.presentationDefinition,
    });
    return toResponse(session);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List all locally-tracked verification sessions.' })
  async listSessions(): Promise<Oid4vcVerificationSession[]> {
    return this.verifier.listSessions();
  }

  @Get('sessions/:id')
  @ApiOperation({ summary: 'Get a single verification session, refreshing state from Credo.' })
  async getSession(@Param('id') id: string): Promise<Oid4vcVerificationSession> {
    return this.verifier.findSession(id);
  }
}

function toResponse(session: Oid4vcVerificationSession): PresentationRequestResponseDto {
  return {
    id: session.id,
    credoVerificationSessionId: session.credoVerificationSessionId ?? '',
    authorizationRequest: session.authorizationRequest,
    state: session.state,
  };
}

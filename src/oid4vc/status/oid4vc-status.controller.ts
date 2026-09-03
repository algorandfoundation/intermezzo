import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { Public } from '../../auth/constants';
import { ChangeCredentialStatusDto } from '../dto/status-change.dto';
import { AllocatedStatusEntry, Oid4vcStatusService } from './oid4vc-status.service';

/**
 * HTTP surface for credential revocation.
 *
 * Two audiences, and they are why the auth model is split:
 *
 *  - **Verifiers** (anyone, including this service) `GET` the status list.
 *    The URI is embedded in every SD-JWT VC we issue, and `@sd-jwt` fails
 *    verification outright if it cannot be dereferenced, so this route must be
 *    reachable without credentials — hence `@Public()`.
 *  - **The manager** revokes and reactivates, gated by the global `AuthGuard`
 *    that every route inherits unless it opts out.
 */
@ApiTags('OID4VC')
@Controller('credential/status')
export class Oid4vcStatusController {
  constructor(private readonly status: Oid4vcStatusService) {}

  /**
   * Kept under its own `list/` segment rather than at `:listId`, so the bare
   * `credential/status` namespace stays free for authenticated sibling routes
   * without a public route shadowing them through declaration order.
   */
  @Public()
  @Get('list/:listId')
  @ApiProduces('application/statuslist+jwt')
  @ApiOperation({
    summary: 'Signed IETF Token Status List for issued credentials. Public — verifiers dereference this.',
  })
  async getStatusList(@Param('listId') listId: string, @Res() response: Response): Promise<void> {
    const token = await this.status.getStatusListJwt(listId);

    // Written with `@Res()` and `end()` rather than returned, purely to keep
    // the media type exact. `@sd-jwt`'s default status list fetcher compares
    // the Content-Type for *strict* equality with `application/statuslist+jwt`
    // and throws "Invalid content type" otherwise — but Express appends
    // `; charset=utf-8` to the Content-Type of every string body it sends, and
    // Nest hands a returned string straight to `response.send()`. Returning a
    // Buffer is not a way out either: Nest treats any object as JSON.
    //
    // Nothing is written before the await, so a thrown NotFoundException still
    // reaches the exception filter and renders normally.
    response.setHeader('Content-Type', 'application/statuslist+jwt');
    // Revocation freshness beats cache economy: a cached list is a window in
    // which a revoked credential still verifies.
    response.setHeader('Cache-Control', 'no-store');
    response.end(token);
  }

  @ApiBearerAuth()
  @Post('revoke')
  @ApiOperation({
    summary:
      "Revoke the credential issued under an issuance session. Takes effect on the verifier's next status fetch.",
  })
  async revoke(@Body() dto: ChangeCredentialStatusDto): Promise<AllocatedStatusEntry> {
    return this.status.revokeBySessionId(dto.sessionId, dto.reason);
  }

  @ApiBearerAuth()
  @Post('reactivate')
  @ApiOperation({ summary: 'Reverse a revocation made in error.' })
  async reactivate(@Body() dto: ChangeCredentialStatusDto): Promise<AllocatedStatusEntry> {
    return this.status.reactivateBySessionId(dto.sessionId);
  }
}

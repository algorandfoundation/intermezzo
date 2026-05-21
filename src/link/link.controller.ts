import { Body, Controller, Logger, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/constants';
import { LinkService } from './link.service';
import {
  IssueChallengeDto,
  IssueChallengeResponseDto,
  RedeemAttestationDto,
  RedeemAttestationResponseDto,
} from './link.dto';

/**
 * Device-attestation handshake endpoints.
 *
 * Mounted under the global `/v1` prefix. Both routes are `@Public()`
 * because the wallet has no credential yet — this controller is
 * exactly where the credential gets minted. Identity proofing happens
 * inside `LinkService`:
 *
 *   - `did:key` possession is proven by signing the server-issued
 *     nonce; the service verifies the signature against the public
 *     key encoded in the `did:key`.
 *   - Device attestation (Apple App Attest / Play Integrity) is
 *     validated inline by the service during `redeem`. Once the
 *     credential is minted it transitively vouches for this check on
 *     every subsequent wallet-authenticated call (`CredentialAuthGuard`).
 *
 *   - `POST /v1/link/challenge` — server returns a fresh
 *     single-use nonce bound to the supplied `did:key`.
 *
 *   - `POST /v1/link/response` — wallet posts back the signed
 *     nonce + device-attestation blob. On success the server mints a
 *     per-user `did:algo` (controlled by the `did:key`) and returns a
 *     credential-offer URI for the `device-attestation-credential`
 *     configuration.
 */
@ApiTags('Attestation')
@Public()
@Controller('link')
export class LinkController {
  private readonly logger = new Logger(LinkController.name);

  constructor(private readonly attestations: LinkService) {}

  @Post('challenge')
  @ApiOperation({ summary: 'Issue a single-use challenge for the supplied did:key to sign.' })
  async issueChallenge(@Body() dto: IssueChallengeDto): Promise<IssueChallengeResponseDto> {
    const { nonce, expiresAt } = await this.attestations.issueChallenge(dto.didKey);
    return { nonce, expiresAt: expiresAt.toISOString() };
  }

  @Post('response')
  @ApiOperation({
    summary:
      'Redeem a signed challenge and return a credential offer for the device-attestation credential. ' +
      'No on-chain operations are performed here — the wallet creates its own per-user did:algo contract ' +
      'separately via POST /v1/did/create/{transactions,submit}.',
  })
  async redeem(@Body() dto: RedeemAttestationDto): Promise<RedeemAttestationResponseDto> {
    const { issuanceSession } = await this.attestations.redeem({
      didKey: dto.didKey,
      nonce: dto.nonce,
      signatureB64: dto.signature,
      deviceAttestation: dto.deviceAttestation,
    });
    this.logger.debug(`attestation: redeemed ${dto.didKey} (session ${issuanceSession.id})`);
    return {
      didKey: dto.didKey,
      issuanceSessionId: issuanceSession.id,
      credentialOfferUri: issuanceSession.credentialOffer,
    };
  }
}

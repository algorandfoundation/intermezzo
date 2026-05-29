import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Oid4vcVerificationSessionRepository } from '../sessions/vault-repository';

import type { DifPresentationExchangeDefinitionV2 } from '@credo-ts/core';

import { Oid4vcAgentProvider } from '../agent/oid4vc-agent.provider';
import { Oid4vcConfig } from '../oid4vc.config';
import { Oid4vcVerificationSession } from '../entities/oid4vc-verification-session.entity';

/**
 * Encapsulates the OID4VP / SIOPv2 verifier side of the agent.
 *
 * Responsibilities:
 * - Idempotently create the singleton verifier record on bootstrap.
 * - Build authorization requests (with a DIF presentation definition) the
 *   wallet can satisfy after scanning a QR code.
 * - Surface the verification result once the wallet has posted its response
 *   to Credo's authorization endpoint.
 */
@Injectable()
export class Oid4vcVerifierService implements OnModuleInit {
  private readonly logger = new Logger(Oid4vcVerifierService.name);

  static readonly VERIFIER_ID = 'pawn-rewards-verifier';

  constructor(
    private readonly agentProvider: Oid4vcAgentProvider,
    private readonly config: Oid4vcConfig,
    private readonly sessionRepo: Oid4vcVerificationSessionRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.autoInit) return;
    try {
      await this.ensureVerifier();
    } catch (e) {
      this.logger.error(`Failed to ensure verifier record: ${(e as Error).message}`);
    }
  }

  async ensureVerifier() {
    const agent = await this.agentProvider.getAgent();
    try {
      return await agent.modules.openId4VcVerifier.getVerifierByVerifierId(Oid4vcVerifierService.VERIFIER_ID);
    } catch {
      this.logger.log(`Creating Credo verifier record ${Oid4vcVerifierService.VERIFIER_ID}`);
      return agent.modules.openId4VcVerifier.createVerifier({
        verifierId: Oid4vcVerifierService.VERIFIER_ID,
      });
    }
  }

  /**
   * Build an OID4VP authorization request signed with the issuer's
   * `did:algo` (acting as the verifier's request signer). Returns the URI
   * to render in the QR code together with an app-level tracking record.
   *
   * Note: any platform user can verify credentials they hold, but the
   * *request* itself is always signed by the manager-controlled issuer
   * `did:algo` — so wallets see a single, well-known verifier identity.
   */
  async createPresentationRequest(input: {
    presentationDefinition: Record<string, unknown>;
  }): Promise<Oid4vcVerificationSession> {
    const agent = await this.agentProvider.getAgent();
    await this.ensureVerifier();
    const issuerDid = await this.agentProvider.ensureIssuerDid();

    const { authorizationRequest, verificationSession } =
      await agent.modules.openId4VcVerifier.createAuthorizationRequest({
        verifierId: Oid4vcVerifierService.VERIFIER_ID,
        requestSigner: { method: 'did', didUrl: issuerDid.verificationMethodId },
        presentationExchange: {
          definition: input.presentationDefinition as unknown as DifPresentationExchangeDefinitionV2,
        },
      });

    const record = this.sessionRepo.create({
      credoVerificationSessionId: verificationSession.id,
      verifierId: Oid4vcVerifierService.VERIFIER_ID,
      authorizationRequest,
      presentationDefinition: input.presentationDefinition,
      state: verificationSession.state,
    });
    return this.sessionRepo.save(record);
  }

  /**
   * Returns the local verification session, refreshing the cached state and
   * verified claims (if any) from Credo's record.
   */
  async findSession(id: string): Promise<Oid4vcVerificationSession> {
    const session = await this.sessionRepo.findOneBy({ id });
    if (!session) throw new NotFoundException(`Verification session ${id} not found`);

    if (!session.credoVerificationSessionId) return session;

    try {
      const agent = await this.agentProvider.getAgent();
      const credoSession = await agent.modules.openId4VcVerifier.getVerificationSessionById(
        session.credoVerificationSessionId,
      );
      session.state = credoSession.state;

      // Once the response has been verified we can pull the extracted
      // payloads. `getVerifiedAuthorizationResponse` throws if the session
      // is not yet in the right state, so we guard with a try/catch.
      try {
        const verified = await agent.modules.openId4VcVerifier.getVerifiedAuthorizationResponse(
          session.credoVerificationSessionId,
        );
        session.verifiedClaims = {
          idToken: verified.idToken?.payload,
          presentations: verified.presentationExchange?.presentations,
          submission: verified.presentationExchange?.submission,
        } as Record<string, unknown>;
      } catch {
        // not yet verified - that's fine, just return current state
      }
      await this.sessionRepo.save(session);
    } catch (e) {
      this.logger.warn(`Could not refresh Credo verification session: ${(e as Error).message}`);
    }
    return session;
  }

  async listSessions(): Promise<Oid4vcVerificationSession[]> {
    return this.sessionRepo.find({ order: { createdAt: 'DESC' } });
  }
}

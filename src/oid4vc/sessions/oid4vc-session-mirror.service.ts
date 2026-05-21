import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Oid4vcIssuanceSessionRepository, Oid4vcVerificationSessionRepository } from './vault-repository';
import {
  OpenId4VcIssuerEvents,
  OpenId4VcIssuanceSessionStateChangedEvent,
  OpenId4VcVerifierEvents,
  OpenId4VcVerificationSessionStateChangedEvent,
} from '@credo-ts/openid4vc';
import { Oid4vcAgentProvider } from '../agent/oid4vc-agent.provider';
import { Oid4vcConfig } from '../oid4vc.config';

@Injectable()
export class Oid4vcSessionMirrorService implements OnModuleInit {
  private readonly logger = new Logger(Oid4vcSessionMirrorService.name);

  constructor(
    private readonly agentProvider: Oid4vcAgentProvider,
    private readonly config: Oid4vcConfig,
    private readonly issuanceRepo: Oid4vcIssuanceSessionRepository,
    private readonly verificationRepo: Oid4vcVerificationSessionRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.autoInit) {
      this.logger.log('OID4VC_AUTO_INIT=false, skipping session mirror subscription');
      return;
    }
    try {
      const agent = await this.agentProvider.getAgent();
      agent.events.on<OpenId4VcIssuanceSessionStateChangedEvent>(
        OpenId4VcIssuerEvents.IssuanceSessionStateChanged,
        (event) => this.onIssuanceStateChanged(event),
      );
      agent.events.on<OpenId4VcVerificationSessionStateChangedEvent>(
        OpenId4VcVerifierEvents.VerificationSessionStateChanged,
        (event) => this.onVerificationStateChanged(event),
      );
      this.logger.log('Subscribed to Credo OID4VC session state-change events');
    } catch (e) {
      this.logger.warn(`Failed to subscribe to Credo events: ${(e as Error).message}`);
    }
  }

  private async onIssuanceStateChanged(event: OpenId4VcIssuanceSessionStateChangedEvent): Promise<void> {
    const { issuanceSession, previousState } = event.payload;
    try {
      const result = await this.issuanceRepo.update(
        { credoIssuanceSessionId: issuanceSession.id },
        { state: issuanceSession.state },
      );
      if (result.affected) {
        this.logger.debug(`Issuance session ${issuanceSession.id}: ${previousState ?? '∅'} → ${issuanceSession.state}`);
      }
    } catch (e) {
      this.logger.warn(`Failed to mirror issuance state for ${issuanceSession.id}: ${(e as Error).message}`);
    }
  }

  private async onVerificationStateChanged(event: OpenId4VcVerificationSessionStateChangedEvent): Promise<void> {
    const { verificationSession, previousState } = event.payload;
    try {
      const result = await this.verificationRepo.update(
        { credoVerificationSessionId: verificationSession.id },
        { state: verificationSession.state },
      );
      if (result.affected) {
        this.logger.debug(
          `Verification session ${verificationSession.id}: ${previousState ?? '∅'} → ${verificationSession.state}`,
        );
      }
    } catch (e) {
      this.logger.warn(`Failed to mirror verification state for ${verificationSession.id}: ${(e as Error).message}`);
    }
  }
}

import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Oid4vcAgentProvider } from '../oid4vc/agent/oid4vc-agent.provider';

/**
 * Credential configuration / `vct` of the credential this guard
 * accepts. Must stay in sync with
 * `DEFAULT_CREDENTIAL_CONFIGURATIONS['device-attestation-credential']`
 * in `oid4vc/issuer/credential-configurations.ts`.
 */
export const DEVICE_ATTESTATION_VCT = 'device-attestation-credential';

/** Header the wallet uses to present its credential. */
export const CREDENTIAL_HEADER = 'x-credential-presentation';

/**
 * Augmented Express request: post-guard the caller's `did:key`
 * (extracted from the credential's `cnf.kid`) and the verified
 * credential payload are attached so downstream controllers can
 * identify the caller without re-running verification.
 */
export interface CredentialAuthRequest {
  didKey?: string;
  credentialPayload?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Authoritative wallet-login guard.
 *
 * The only proof of identity for routine wallet-authenticated routes
 * is the `device-attestation-credential` SD-JWT VC the manager issued
 * to the wallet. The device-platform attestation
 * (Apple App Attest / Play Integrity) and the `did:key` possession
 * proof are both performed *once*, inside the attestation flow, and
 * then vouched for by the credential the wallet now presents on every
 * subsequent call.
 *
 * Wire format:
 *
 *   `X-Credential-Presentation: <compact-sd-jwt-vc>`
 *
 * Verification steps:
 *
 *   1. Credo's `sdJwtVc.verify` checks the issuer signature against
 *      the manager's resolved DID document.
 *   2. The `iss` claim must equal the manager `did:algo` returned by
 *      `Oid4vcAgentProvider.ensureIssuerDid`.
 *   3. The `vct` must equal {@link DEVICE_ATTESTATION_VCT}.
 *   4. The credential's `cnf.kid` must encode a `did:key`; that
 *      `did:key` is exposed as `request.didKey` for downstream
 *      handlers that need to derive the caller's Algorand address.
 *
 * The manager JWT / Vault AppRole login (`AuthGuard`) is a separate
 * path that gates manager-only routes and is unaffected by this
 * guard.
 */
@Injectable()
export class CredentialAuthGuard implements CanActivate {
  private readonly logger = new Logger(CredentialAuthGuard.name);

  constructor(private readonly agentProvider: Oid4vcAgentProvider) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CredentialAuthRequest>();
    const raw = request.headers[CREDENTIAL_HEADER];
    const compact = Array.isArray(raw) ? raw[0] : raw;
    if (!compact || typeof compact !== 'string') {
      throw new UnauthorizedException(`Missing ${CREDENTIAL_HEADER} header carrying the device-attestation credential`);
    }
    const agent = await this.agentProvider.getAgent();
    const result = await agent.sdJwtVc.verify({ compactSdJwtVc: compact });
    if (result.isValid !== true) {
      const reason = (result as { error?: Error }).error?.message ?? 'unknown error';
      throw new UnauthorizedException(`Credential failed verification: ${reason}`);
    }
    const payload = result.sdJwtVc.payload as Record<string, unknown>;
    const issuerDid = await this.agentProvider.ensureIssuerDid();
    if (payload.iss !== issuerDid.did) {
      throw new UnauthorizedException(
        `Credential iss ${String(payload.iss)} does not match the manager issuer ${issuerDid.did}`,
      );
    }
    if (payload.vct !== DEVICE_ATTESTATION_VCT) {
      throw new UnauthorizedException(`Credential vct ${String(payload.vct)} is not ${DEVICE_ATTESTATION_VCT}`);
    }
    const cnf = payload.cnf as { kid?: string; id?: string } | undefined;
    const boundDidUrl = cnf?.kid ?? cnf?.id;
    if (!boundDidUrl || typeof boundDidUrl !== 'string') {
      throw new UnauthorizedException('Credential cnf does not carry a holder kid/id');
    }
    const didKey = boundDidUrl.split('#')[0];
    if (!didKey.startsWith('did:key:')) {
      throw new UnauthorizedException(`Credential is bound to ${didKey}, which is not a did:key`);
    }
    request.didKey = didKey;
    request.credentialPayload = payload;
    this.logger.debug(`CredentialAuthGuard: authenticated ${didKey} via device-attestation-credential`);
    return true;
  }
}

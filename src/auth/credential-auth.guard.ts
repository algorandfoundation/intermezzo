import { CanActivate, ExecutionContext, Injectable, Logger, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Oid4vcAgentProvider } from '../oid4vc/agent/oid4vc-agent.provider';

/**
 * Credential configuration / `vct` the guard accepts by default. Must
 * stay in sync with
 * `DEFAULT_CREDENTIAL_CONFIGURATIONS['device-attestation-credential']`
 * in `oid4vc/issuer/credential-configurations.ts`.
 */
export const DEVICE_ATTESTATION_VCT = 'device-attestation-credential';

/**
 * `vct` of the custom fee-sponsorship credential gating sponsored-fee
 * routes. The manager registers this configuration via
 * `POST /v1/credential/issuer/configurations/fee-sponsorship-credential`
 * and issues offers per holder (see `docs/CUSTOM_CREDENTIALS.md`).
 * Possession of the credential is the entitlement — the manager only
 * issues it to users allowed to use sponsored-fee routes.
 */
export const FEE_SPONSORSHIP_VCT = 'fee-sponsorship-credential';

/** Header the wallet uses to present its credential. */
export const CREDENTIAL_HEADER = 'x-credential-presentation';

export const REQUIRED_CREDENTIAL_VCT_KEY = 'requiredCredentialVct';

/**
 * Route decorator selecting which credential `vct`
 * {@link CredentialAuthGuard} requires, e.g.
 * `@RequiredCredential(FEE_SPONSORSHIP_VCT)`. Routes without it require
 * the default {@link DEVICE_ATTESTATION_VCT}.
 */
export const RequiredCredential = (vct: string) => SetMetadata(REQUIRED_CREDENTIAL_VCT_KEY, vct);

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
 *   3. The `vct` must equal the route's required credential type —
 *      {@link DEVICE_ATTESTATION_VCT} by default, overridable per
 *      route with {@link RequiredCredential} (e.g. the sponsored-fee
 *      route requires {@link FEE_SPONSORSHIP_VCT}).
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

  constructor(
    private readonly agentProvider: Oid4vcAgentProvider,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CredentialAuthRequest>();
    const expectedVct =
      this.reflector.getAllAndOverride<string>(REQUIRED_CREDENTIAL_VCT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEVICE_ATTESTATION_VCT;
    await this.verifyCredential(request, expectedVct);
    return true;
  }

  /**
   * Verify the SD-JWT VC presented in {@link CREDENTIAL_HEADER}: issuer
   * signature, manager `iss`, expected `vct`, and holder `did:key`
   * binding. On success attaches `didKey` / `credentialPayload` to the
   * request.
   */
  private async verifyCredential(request: CredentialAuthRequest, expectedVct: string): Promise<void> {
    const raw = request.headers[CREDENTIAL_HEADER];
    const compact = Array.isArray(raw) ? raw[0] : raw;
    if (!compact || typeof compact !== 'string') {
      throw new UnauthorizedException(`Missing ${CREDENTIAL_HEADER} header carrying the ${expectedVct} credential`);
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
    if (payload.vct !== expectedVct) {
      throw new UnauthorizedException(`Credential vct ${String(payload.vct)} is not ${expectedVct}`);
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
    this.logger.debug(`CredentialAuthGuard: authenticated ${didKey} via ${expectedVct}`);
  }
}

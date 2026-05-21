import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Oid4vcIssuanceSessionRepository } from '../sessions/vault-repository';

import { ClaimFormat, W3cCredential, W3cIssuer, w3cDate } from '@credo-ts/core';
import {
  OpenId4VciCredentialFormatProfile,
  OpenId4VciCredentialRequestToCredentialMapper,
  OpenId4VciSignCredential,
  OpenId4VciCredentialConfigurationsSupported,
} from '@credo-ts/openid4vc';

import { Oid4vcAgentProvider } from '../agent/oid4vc-agent.provider';
import { Oid4vcConfig } from '../oid4vc.config';
import { Oid4vcIssuanceSession } from '../entities/oid4vc-issuance-session.entity';
import { SetCredentialConfigurationDto } from '../dto/credential-configuration.dto';
import { DEFAULT_CREDENTIAL_CONFIGURATIONS, CREDENTIAL_CONFIGURATIONS_KV_FOLDER } from './credential-configurations';
import { VaultService } from '../../vault/vault.service';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';

export { DEFAULT_CREDENTIAL_CONFIGURATIONS };

/**
 * Encapsulates the OID4VCI side of the agent: registers the singleton issuer
 * record on bootstrap, exposes a `createOffer` API for the rest of the app,
 * and installs the credential mapper that decides what to actually sign when
 * the wallet redeems an offer.
 */
@Injectable()
export class Oid4vcIssuerService implements OnModuleInit {
  private readonly logger = new Logger(Oid4vcIssuerService.name);

  /**
   * Stable issuer id used both as the Credo `issuerId` and as the segment
   * appended to the issuer base URL in the credential offer. We use a single
   * issuer for all credentials in this service.
   */
  static readonly ISSUER_ID = 'pawn-rewards-issuer';

  constructor(
    private readonly agentProvider: Oid4vcAgentProvider,
    private readonly config: Oid4vcConfig,
    private readonly sessionRepo: Oid4vcIssuanceSessionRepository,
    private readonly vaultService: VaultService,
    private readonly tokenProvider: AlgoVaultTokenProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    // Always install the mapper - it's a stable closure that can be called
    // even before `ensureIssuer()` has run, because Credo only invokes it
    // once a wallet redeems an offer.
    this.agentProvider.setCredentialMapper(this.buildCredentialMapper());

    if (!this.config.autoInit) return;
    try {
      await this.ensureIssuer();
    } catch (e) {
      this.logger.error(`Failed to ensure issuer record: ${(e as Error).message}`);
    }
  }

  /**
   * Idempotently creates the issuer record inside Credo. Safe to call multiple
   * times - returns the existing record if one already matches our `issuerId`.
   */
  async ensureIssuer() {
    const agent = await this.agentProvider.getAgent();
    const configurations = await this.getCredentialConfigurations();
    let record;
    try {
      record = await agent.modules.openId4VcIssuer.getIssuerByIssuerId(Oid4vcIssuerService.ISSUER_ID);
    } catch {
      this.logger.log(`Creating Credo issuer record ${Oid4vcIssuerService.ISSUER_ID}`);
      return agent.modules.openId4VcIssuer.createIssuer({
        issuerId: Oid4vcIssuerService.ISSUER_ID,
        display: [{ name: this.config.issuerDisplayName }],
        credentialConfigurationsSupported: configurations,
      });
    }

    // The issuer record persists `credentialConfigurationsSupported` in Askar,
    // so a record created with stale configurations (e.g. before a rename or
    // a format change) keeps serving the old metadata until we explicitly
    // refresh it. Detect drift between the record and the current set and
    // push an update so `createCredentialOffer` accepts the current ids.
    const persisted = (record as { credentialConfigurationsSupported?: Record<string, unknown> })
      .credentialConfigurationsSupported;
    if (this.hasConfigurationDrift(persisted, configurations)) {
      this.logger.log(
        `Updating Credo issuer record ${Oid4vcIssuerService.ISSUER_ID}: credential configurations drifted`,
      );
      await agent.modules.openId4VcIssuer.updateIssuerMetadata({
        issuerId: Oid4vcIssuerService.ISSUER_ID,
        display: [{ name: this.config.issuerDisplayName }],
        credentialConfigurationsSupported: configurations,
      });
      record = await agent.modules.openId4VcIssuer.getIssuerByIssuerId(Oid4vcIssuerService.ISSUER_ID);
    }
    return record;
  }

  private hasConfigurationDrift(
    persisted: Record<string, unknown> | undefined,
    current: OpenId4VciCredentialConfigurationsSupported,
  ): boolean {
    if (!persisted) return true;
    const expectedKeys = Object.keys(current).sort();
    const actualKeys = Object.keys(persisted).sort();
    if (expectedKeys.length !== actualKeys.length) return true;
    for (let i = 0; i < expectedKeys.length; i++) {
      if (expectedKeys[i] !== actualKeys[i]) return true;
    }
    try {
      return JSON.stringify(persisted) !== JSON.stringify(current);
    } catch {
      return true;
    }
  }

  /**
   * Returns the merged set of credential configurations (hardcoded defaults
   * + dynamic ones from Vault KV).
   */
  async getCredentialConfigurations(): Promise<OpenId4VciCredentialConfigurationsSupported> {
    const out = { ...DEFAULT_CREDENTIAL_CONFIGURATIONS };
    if (!this.tokenProvider.isConfigured()) return out;

    try {
      const token = await this.tokenProvider.getToken();
      const ids = await this.vaultService.kvList(CREDENTIAL_CONFIGURATIONS_KV_FOLDER, token);
      for (const id of ids) {
        try {
          const cfg = await this.vaultService.kvRead<Record<string, unknown>>(
            `${CREDENTIAL_CONFIGURATIONS_KV_FOLDER}/${id}`,
            token,
          );
          if (cfg && typeof cfg.format === 'string') {
            // Validation: SD-JWT must have a VCT
            const isSdJwt = cfg.format === OpenId4VciCredentialFormatProfile.SdJwtVc;
            if (isSdJwt && !cfg.vct) {
              this.logger.warn(
                `Skipping credential configuration ${id} from Vault: missing "vct" property for SdJwtVc format`,
              );
              continue;
            }
            out[id] = cfg as any;
          } else if (cfg) {
            this.logger.warn(
              `Skipping credential configuration ${id} from Vault: missing or invalid "format" property`,
            );
          }
        } catch (e) {
          this.logger.warn(`Failed to read credential configuration ${id} from Vault: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      // Fall back to defaults if Vault is unreachable or uninitialized
      this.logger.debug(`Could not fetch dynamic credential configurations: ${(e as Error).message}`);
    }
    return out;
  }

  /** Dynamic config: persists a new configuration to Vault and syncs Credo. */
  async setCredentialConfiguration(id: string, config: SetCredentialConfigurationDto): Promise<void> {
    if (config.format === OpenId4VciCredentialFormatProfile.SdJwtVc && !config.vct) {
      throw new BadRequestException('SD-JWT VC configuration must have a "vct" property');
    }

    const token = await this.tokenProvider.getToken();
    await this.vaultService.kvWrite(`${CREDENTIAL_CONFIGURATIONS_KV_FOLDER}/${id}`, config, token);
    try {
      await this.ensureIssuer();
    } catch (e) {
      this.logger.error(`Failed to sync Credo after updating configuration ${id}: ${(e as Error).message}`);
      // We don't delete from Vault here to allow manual correction, but we
      // bubble up the error so the user knows sync failed.
      throw e;
    }
  }

  /** Dynamic config: removes a configuration from Vault and syncs Credo. */
  async removeCredentialConfiguration(id: string): Promise<void> {
    const token = await this.tokenProvider.getToken();
    await this.vaultService.kvDelete(`${CREDENTIAL_CONFIGURATIONS_KV_FOLDER}/${id}`, token);
    await this.ensureIssuer();
  }

  /**
   * Creates a pre-authorized OID4VCI offer for the supplied credential
   * configuration ids. The `holderDidKey` is the wallet-local `did:key`
   * the credential will be bound to — it is captured upfront by the v2
   * caller (and proven via `CredentialAuthGuard`) so the mapper can
   * enforce a single fixed binding when the wallet redeems the offer.
   */
  async createOffer(input: {
    credentialConfigurationIds: string[];
    holderDidKey: string;
    issuanceMetadata?: Record<string, unknown>;
  }): Promise<Oid4vcIssuanceSession> {
    if (!input.holderDidKey || !input.holderDidKey.startsWith('did:key:')) {
      throw new Error(
        'createOffer requires a `holderDidKey` (did:key:…) — the wallet-local DID the ' +
          'credential will be bound to. Anonymous offers are not supported.',
      );
    }
    const agent = await this.agentProvider.getAgent();
    await this.ensureIssuer();

    const { issuanceSession, credentialOffer } = await agent.modules.openId4VcIssuer.createCredentialOffer({
      issuerId: Oid4vcIssuerService.ISSUER_ID,
      offeredCredentials: input.credentialConfigurationIds,
      preAuthorizedCodeFlowConfig: { txCode: undefined },
      issuanceMetadata: {
        ...(input.issuanceMetadata ?? {}),
        _offeredCredentialConfigurationIds: input.credentialConfigurationIds,
        _holderDidKey: input.holderDidKey,
      },
    });

    const record = this.sessionRepo.create({
      credoIssuanceSessionId: issuanceSession.id,
      issuerId: Oid4vcIssuerService.ISSUER_ID,
      holderDidKey: input.holderDidKey,
      offeredCredentialConfigurationIds: input.credentialConfigurationIds,
      preAuthorizedCode: issuanceSession.preAuthorizedCode,
      credentialOffer,
      state: issuanceSession.state,
      issuanceMetadata: input.issuanceMetadata,
    });
    return this.sessionRepo.save(record);
  }

  /** Returns the local app-level session record. */
  async findSession(id: string): Promise<Oid4vcIssuanceSession> {
    const session = await this.sessionRepo.findOneBy({ id });
    if (!session) throw new NotFoundException(`Issuance session ${id} not found`);
    // Note: the canonical state lives on the Credo OpenId4VcIssuanceSessionRecord.
    // To keep this service simple we only return the local snapshot here and
    // rely on Credo events (see Oid4vcEventsListener follow-up) to update
    // `state` when the wallet redeems the offer.
    return session;
  }

  async listSessions(): Promise<Oid4vcIssuanceSession[]> {
    return this.sessionRepo.find({ order: { createdAt: 'DESC' } });
  }

  /**
   * Builds the credential mapper. The mapper is the heart of OID4VCI on the
   * issuer side: when a wallet calls the credential endpoint with a proof of
   * possession, Credo invokes this function to materialise a signed credential.
   *
   * The mapper picks the requested format and pulls the actual claim payload
   * from `issuanceMetadata` that was attached when the offer was created.
   */
  private buildCredentialMapper(): OpenId4VciCredentialRequestToCredentialMapper {
    return async ({ credentialConfigurationIds, issuanceSession, holderBinding }) => {
      const configurationId = credentialConfigurationIds[0];
      const configurations = await this.getCredentialConfigurations();
      const configuration = configurations[configurationId];
      if (!configuration) {
        throw new Error(`Unknown credential configuration ${configurationId}`);
      }

      const claims = (issuanceSession.issuanceMetadata ?? {}) as Record<string, unknown>;
      const holderDidKey = claims._holderDidKey as string | undefined;
      const issuerDid = await this.agentProvider.ensureIssuerDid();

      // Holder binding model (post‑v2):
      //
      // The wallet authenticates at the v2 API edge with a `did:key`
      // it minted locally (proof of possession via a signed JWT,
      // augmented by a device-attestation header). The offer-creation
      // call pins that exact `did:key` into the issuance session's
      // metadata. When the wallet later redeems the offer over
      // OID4VCI, Credo invokes this mapper with the proof JWT's
      // `holderBinding` — we accept the credential request only if
      // the holder DID in the proof matches the DID we pinned.
      //
      // There is no server-side user record involved: the `did:key`
      // *is* the user. The only persisted artefact is the issuance
      // session, retained so callers can correlate offers and audit
      // issuance.
      if (!holderDidKey) {
        throw new Error(
          `Cannot issue ${configurationId}: the credential offer has no pinned holder did:key. ` +
            'Offers must be created with `holderDidKey` via the v2 OID4VC controller.',
        );
      }
      if (holderBinding.method !== 'did') {
        throw new Error(
          `Cannot issue ${configurationId}: holder binding method '${holderBinding.method}' is not supported. ` +
            `The wallet must prove possession of ${holderDidKey}.`,
        );
      }
      // Accept either the bare did:key or a fragment URL underneath
      // it (e.g. `did:key:z…#z…`) — Credo sometimes passes the
      // verification-method id rather than the DID itself.
      const proposedHolder = holderBinding.didUrl;
      const matchesHolderDid = proposedHolder === holderDidKey || proposedHolder.startsWith(`${holderDidKey}#`);
      if (!matchesHolderDid) {
        throw new Error(
          `Holder binding mismatch for ${configurationId}: wallet proved possession of ` +
            `${proposedHolder} but credentials must be bound to ${holderDidKey} ` +
            '(the did:key pinned when the offer was created).',
        );
      }

      // Credo's `SdJwtVcService.extractKeyFromHolderBinding` runs
      // `parseDid(holder.didUrl)` and refuses a holder whose `didUrl`
      // does not carry a `#fragment` (it needs to dereference a
      // specific verification method, not the DID document as a
      // whole). For `did:key` the verification-method id is the DID
      // followed by `#<method-specific-id>` (i.e. the same multibase
      // value that follows `did:key:`). Build that here so the SD-JWT
      // VC's `cnf.kid` resolves to a concrete key.
      const holderVerificationMethodId = holderDidKey.startsWith('did:key:')
        ? `${holderDidKey}#${holderDidKey.slice('did:key:'.length)}`
        : holderDidKey;

      switch (configuration.format) {
        case OpenId4VciCredentialFormatProfile.SdJwtVc: {
          const signed: OpenId4VciSignCredential = {
            credentialSupportedId: configurationId,
            format: ClaimFormat.SdJwtVc,
            payload: {
              vct: (configuration as { vct?: string }).vct!,
              ...stripInternalKeys(claims),
            },
            issuer: { method: 'did', didUrl: issuerDid.verificationMethodId },
            holder: { method: 'did', didUrl: holderVerificationMethodId },
            disclosureFrame: { _sd: Object.keys(stripInternalKeys(claims)) },
          };
          return signed;
        }

        case OpenId4VciCredentialFormatProfile.JwtVcJson:
        case OpenId4VciCredentialFormatProfile.JwtVcJsonLd:
        case OpenId4VciCredentialFormatProfile.LdpVc: {
          const type = (configuration as any).credential_definition?.type ?? [
            'VerifiableCredential',
            'CredentialJwtVc',
          ];
          const credential = new W3cCredential({
            type,
            issuer: new W3cIssuer({ id: issuerDid.did }),
            issuanceDate: w3cDate(),
            credentialSubject: {
              id: holderDidKey,
              ...stripInternalKeys(claims),
            },
          });
          const signed: OpenId4VciSignCredential = {
            credentialSupportedId: configurationId,
            format: ClaimFormat.JwtVc,
            verificationMethod: issuerDid.verificationMethodId,
            credential,
          };
          return signed;
        }

        default:
          throw new Error(`Unsupported credential format ${configuration.format}`);
      }
    };
  }
}

/** Strip the bookkeeping fields we inject into `issuanceMetadata`. */
function stripInternalKeys(claims: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(claims)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

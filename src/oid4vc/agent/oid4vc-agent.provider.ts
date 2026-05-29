import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Router } from 'express';

import { Agent, ConnectionsModule, DidsModule, KeyDidRegistrar, KeyDidResolver } from '@credo-ts/core';
import { agentDependencies } from '@credo-ts/node';
import { ariesAskar } from '@hyperledger/aries-askar-nodejs';
import {
  OpenId4VcIssuerModule,
  OpenId4VcVerifierModule,
  OpenId4VciCredentialRequestToCredentialMapper,
} from '@credo-ts/openid4vc';

import { Oid4vcConfig } from '../oid4vc.config';
import { VaultService } from '../../vault/vault.service';
import { AlgoDidRegistrar, type AlgoDidCreateOptions } from '../../../libs/credo-did-algo';
import { AlgoDidResolver } from '../algo/algo-did.resolver';
import { isDidAlgo } from '../../../libs/credo-did-algo';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';
import { VaultKeyProvisioningAdapter } from '../algo/vault-key-provisioning.adapter';
import { Oid4vcAskarModule } from '../algo/oid4vc-askar.module';
import {
  KeyRefStore,
  parseVaultSignature,
  publicKeyToBase58,
  vaultSigningRegistry,
  VaultKeyBinding,
} from '../../../libs/credo-vault-wallet';
import { CredoNestLogger, resolveCredoLogLevel } from './credo-nest-logger';
import { DidService } from '../../did/did.service';

/**
 * Type of the Credo agent we expose to the rest of the Nest app.
 */
export type Oid4vcAgent = Agent<{
  askar: Oid4vcAskarModule;
  dids: DidsModule;
  connections: ConnectionsModule;
  openId4VcIssuer: OpenId4VcIssuerModule;
  openId4VcVerifier: OpenId4VcVerifierModule;
}>;

/** Result of {@link Oid4vcAgentProvider.ensureIssuerDid}. */
export interface IssuerDid {
  did: string;
  verificationMethodId: string;
}

/**
 * Owns the lifecycle of the Credo agent that powers OID4VCI/OID4VP.
 *
 * Post‑v2 architecture:
 *   - The only Vault-held key the agent ever signs with is the
 *     **manager** ed25519 transit key. Holder keys live entirely on
 *     the wallet device (`did:key`); the platform does not custody
 *     them.
 *   - The agent registers two DID methods, with strictly different
 *     roles:
 *       * `did:algo` — **issuer-only**, the manager's on-chain DID.
 *         Enforced by {@link Oid4vcAgentProvider.assertIssuerIsDidAlgo}.
 *       * `did:key` — **holder-only**, used by OID4VP verifiers to
 *         resolve holder binding from the wallet's proof.
 *   - The `KeyRefStore` backing `credo-vault-wallet`'s signing
 *     registry is in-memory: there is exactly one binding (the
 *     manager's), it is populated by the `AlgoDidRegistrar` during
 *     `ensureIssuerDid`, and we don't need to survive a restart
 *     because the registrar is idempotent.
 */
@Injectable()
export class Oid4vcAgentProvider implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Oid4vcAgentProvider.name);

  readonly issuerRouter: Router = Router();
  readonly verifierRouter: Router = Router();

  private agentInstance: Oid4vcAgent | undefined;
  private initialisation: Promise<Oid4vcAgent> | undefined;

  /**
   * The credential mapper that the issuer service registers at
   * startup. Stored in a mutable holder so we can pass a stable
   * reference into the Credo configuration before the issuer service
   * exists.
   */
  private credentialMapper: OpenId4VciCredentialRequestToCredentialMapper = async () => {
    throw new Error(
      'Oid4vcAgentProvider: credentialRequestToCredentialMapper has not been registered yet. ' +
        'The Oid4vcIssuerService is responsible for installing it during onModuleInit.',
    );
  };

  constructor(
    private readonly config: Oid4vcConfig,
    private readonly tokenProvider: AlgoVaultTokenProvider,
    private readonly vaultService: VaultService,
    private readonly algoDidResolver: AlgoDidResolver,
    private readonly algoDidRegistrar: AlgoDidRegistrar,
    private readonly didService: DidService,
    private readonly keyProvisioning: VaultKeyProvisioningAdapter,
  ) {}

  setCredentialMapper(mapper: OpenId4VciCredentialRequestToCredentialMapper): void {
    this.credentialMapper = mapper;
  }

  async getAgent(): Promise<Oid4vcAgent> {
    if (this.agentInstance) return this.agentInstance;
    if (!this.initialisation) this.initialisation = this.initialiseAgent();
    return this.initialisation;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.autoInit) {
      this.logger.log('OID4VC_AUTO_INIT=false, skipping agent initialisation on bootstrap');
      return;
    }
    await this.getAgent();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.agentInstance) {
      try {
        await this.agentInstance.shutdown();
      } catch (e) {
        this.logger.warn(`Error shutting down Credo agent: ${(e as Error).message}`);
      }
      this.agentInstance = undefined;
      this.initialisation = undefined;
    }
  }

  private async initialiseAgent(): Promise<Oid4vcAgent> {
    this.logger.log(`Initialising Credo OID4VC agent at ${this.config.baseUrl}`);

    // Wire an in-memory `KeyRefStore` for the signing registry. There
    // is exactly one binding in flight at any time (the manager's),
    // populated by `AlgoDidRegistrar` during `ensureIssuerDid`. We
    // don't persist this — the registrar is idempotent on restart
    // because it re-reads the manager Vault key.
    const memoryStore = new Map<string, VaultKeyBinding>();
    const store: KeyRefStore = {
      async save(publicKeyBase58: string, binding: VaultKeyBinding): Promise<void> {
        memoryStore.set(publicKeyBase58, binding);
      },
      async find(publicKeyBase58: string): Promise<VaultKeyBinding | null> {
        return memoryStore.get(publicKeyBase58) ?? null;
      },
      async delete(publicKeyBase58: string): Promise<void> {
        memoryStore.delete(publicKeyBase58);
      },
    };
    vaultSigningRegistry.setStore(store);

    // The signer routes any Ed25519 sign request whose public key is
    // registered with the signing registry through Vault transit.
    vaultSigningRegistry.setSigner(async (binding, data) => {
      const token = await this.tokenProvider.getToken();
      const raw = await this.vaultService.sign(binding.vaultKeyName, binding.transitPath, data, token);
      return parseVaultSignature(raw as unknown as string);
    });

    const credoLogLevel = resolveCredoLogLevel(process.env.CREDO_LOG_LEVEL);
    this.logger.log(`Credo logger level: ${process.env.CREDO_LOG_LEVEL ?? 'debug'} (${credoLogLevel})`);
    const credoLogger = new CredoNestLogger(credoLogLevel);
    const agent: Oid4vcAgent = new Agent({
      config: {
        label: this.config.label,
        walletConfig: {
          id: this.config.walletId,
          key: this.config.walletKey,
        },
        endpoints: [this.config.baseUrl],
        logger: credoLogger,
      },
      dependencies: agentDependencies,
      modules: {
        askar: new Oid4vcAskarModule({ ariesAskar }),
        dids: new DidsModule({
          registrars: [this.algoDidRegistrar, new KeyDidRegistrar()],
          resolvers: [this.algoDidResolver, new KeyDidResolver()],
        }),
        connections: new ConnectionsModule({ autoAcceptConnections: true }),
        openId4VcIssuer: new OpenId4VcIssuerModule({
          baseUrl: this.config.issuerBaseUrl,
          router: this.issuerRouter,
          endpoints: {
            credential: {
              credentialRequestToCredentialMapper: (options) => this.credentialMapper(options),
            },
          },
        }),
        openId4VcVerifier: new OpenId4VcVerifierModule({
          baseUrl: this.config.verifierBaseUrl,
          router: this.verifierRouter,
        }),
      },
    });

    await agent.initialize();
    this.agentInstance = agent;
    this.logger.log('Credo OID4VC agent initialised');

    return agent;
  }

  /**
   * No-op retained for backwards compatibility with callers that
   * historically invoked it after a manager-identity redeploy. The
   * issuer DID is no longer cached in memory: every
   * {@link ensureIssuerDid} call re-derives the canonical identifier
   * from Vault state (manager pubkey + current `DIDAlgoStorage`
   * appId), so stale state cannot survive a redeploy or rotation.
   */
  resetCachedIssuerDid(): void {
    // intentionally empty
  }

  /**
   * Returns (creating it if necessary) the on-chain `did:algo` this
   * issuer signs credentials with. The issuer DID is the manager's
   * `did:algo`: it is the platform's root of trust, anchored on chain
   * so verifiers can pin it.
   *
   * Selection rules (no in-memory cache — always derived from
   * current Vault state):
   *   1. Re-read the `DIDAlgoStorage` appId from Vault KV.
   *   2. Re-read the manager ed25519 pubkey from Vault transit.
   *   3. Derive the expected `did:algo` identifier from (1)+(2).
   *   4. If a Credo `DidRecord` for that exact DID already exists in
   *      the agent's Askar wallet, reuse it. (Stale records from
   *      prior deployments — different appId encoded in the
   *      identifier — are ignored, never returned.)
   *   5. Else, ask {@link AlgoDidRegistrar} to publish the manager's
   *      `did:algo` on chain (it uses the manager's existing Vault
   *      transit key). Requires the manager Vault AppRole.
   */
  async ensureIssuerDid(): Promise<IssuerDid> {
    // Hydrate the `DIDAlgoStorage` app id from Vault KV before any
    // publish/resolve path runs — `deriveDid` reads off the cached
    // override populated here.
    await this.didService.ensureAppIdLoaded();
    const agent = await this.getAgent();
    const managerUserId = this.config.managerUserId;

    // Compute the expected DID from current Vault state: the manager's
    // ed25519 pubkey plus the currently configured appId. This is what
    // makes the lookup robust against redeploy: a different appId in
    // Vault KV yields a different DID identifier, which can't collide
    // with any stale `DidRecord` cached in the Askar wallet from a
    // previous deployment.
    if (!this.tokenProvider.isConfigured()) {
      throw new Error(
        'Oid4vcAgentProvider: cannot derive the issuer did:algo because the manager Vault ' +
          'AppRole is not configured. Set VAULT_ROLE_ID and VAULT_SECRET_ID so ' +
          'AlgoDidRegistrar can read the manager Vault key.',
      );
    }
    const provisioned = await this.keyProvisioning.provision({
      controller: managerUserId,
      options: { transitPath: this.config.managerTransitPath },
    });
    // Ensure the manager pubkey is bound in the `vaultSigningRegistry`
    // even when ensureIssuerDid takes the "DidRecord already exists"
    // reuse path below (the `AlgoDidRegistrar` only calls `bind()`
    // during `agent.dids.create`, so a process that boots with the
    // DID already in its Askar wallet would otherwise hit the
    // VaultAskarWallet → AskarWallet fallthrough at credential-sign
    // time and fail with "Error retrieving Secure Environment
    // record"). Idempotent on `publicKeyBase58`.
    const managerPublicKeyBase58 = publicKeyToBase58(provisioned.publicKey);
    await vaultSigningRegistry.bind(managerPublicKeyBase58, {
      vaultKeyName: provisioned.keyRef.vaultKeyName,
      transitPath: provisioned.keyRef.transitPath,
    });
    const expectedDid = this.didService.deriveDid(provisioned.publicKey);
    this.assertIssuerIsDidAlgo(expectedDid);
    const expectedResult: IssuerDid = { did: expectedDid, verificationMethodId: `${expectedDid}#keys-1` };

    const algoDids = await agent.dids.getCreatedDids({ method: 'algo' });
    const matching = algoDids.find((d) => d.did === expectedDid);
    if (matching) {
      // The Askar wallet remembers the DID + signing key, but it does
      // NOT remember whether the on-chain document is still published
      // (the `DIDAlgoStorage` box could have been deleted by a force
      // redeploy, or the document never finished uploading on a
      // previous boot). Consult the chain directly: if the document is
      // missing, we must re-publish.
      const onChain = await this.didService.resolveOnChainDocument(expectedDid);
      if (onChain) {
        return expectedResult;
      }
      this.logger.warn(
        `ensureIssuerDid: Askar DidRecord exists for ${expectedDid} but the on-chain ` +
          `document is missing; dropping the stale record and republishing`,
      );
      try {
        const { DidRepository } = await import('@credo-ts/core');
        const didRepository = agent.context.dependencyManager.resolve(DidRepository);
        await didRepository.delete(agent.context, matching);
      } catch (err) {
        this.logger.warn(
          `ensureIssuerDid: failed to delete stale DidRecord for ${expectedDid}: ${(err as Error).message}`,
        );
      }
    }
    const otherDids = algoDids.filter((d) => d.did !== expectedDid);
    if (otherDids.length > 0) {
      this.logger.warn(
        `ensureIssuerDid: ignoring ${otherDids.length} stale did:algo record(s) in the Askar wallet ` +
          `(none match the current Vault-derived DID ${expectedDid}); minting a fresh issuer document`,
      );
    }

    const created = await agent.dids.create<AlgoDidCreateOptions>({
      method: 'algo',
      options: {
        // The package's `controller` field is host-opaque — for the
        // single-tenant manager case we use the manager's user id as
        // the controller. The provisioning bag carries the Vault
        // transit-path the {@link VaultKeyProvisioningAdapter} reads.
        controller: managerUserId,
        provisioningOptions: { transitPath: this.config.managerTransitPath },
      },
    });
    if (created.didState.state !== 'finished' || !created.didState.did) {
      throw new Error(
        `Failed to provision did:algo issuer (state=${created.didState.state}): ` + JSON.stringify(created.didState),
      );
    }

    const did = created.didState.did;
    this.assertIssuerIsDidAlgo(did);
    if (did !== expectedDid) {
      this.logger.warn(
        `ensureIssuerDid: registrar returned did=${did} but expected ${expectedDid}; using registrar value`,
      );
    }
    const result: IssuerDid = { did, verificationMethodId: `${did}#keys-1` };
    this.logger.log(`Provisioned did:algo issuer ${did}`);
    return result;
  }

  /**
   * Hard invariant: the OID4VC issuer DID **must** be a `did:algo`. The
   * issuer DID is the cryptographic root of trust we publish on chain
   * and the only method bound to the manager's Vault-held signing key.
   * Holder DIDs (e.g. `did:key`) are perfectly fine elsewhere in the
   * agent, but never as the issuer.
   */
  private assertIssuerIsDidAlgo(did: string): void {
    if (!isDidAlgo(did)) {
      throw new Error(
        `Oid4vcAgentProvider: refusing to use "${did}" as the issuer DID — ` +
          `the issuer DID must be a did:algo (see src/oid4vc/TRUST_MODEL.md). ` +
          `This is almost certainly a bug: did:key, did:web, etc. are only ` +
          `valid for holder binding, never for credential signing.`,
      );
    }
  }
}

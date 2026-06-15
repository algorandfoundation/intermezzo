import type { AgentContext } from '@credo-ts/core';
import { DidDocumentRole, DidRecord, DidRepository, TypedArrayEncoder } from '@credo-ts/core';
import type {
  DidCreateOptions,
  DidCreateResult,
  DidDeactivateOptions,
  DidDeactivateResult,
  DidRegistrar,
  DidUpdateResult,
} from '@credo-ts/core';

import { buildCredoDidDocumentFromKey } from './algo-did.resolver';
import { parseDidAlgo } from './identifier';
import type { DidAlgoChainWriterPort, KeyProvisioningPort } from './ports';

/**
 * Extra options accepted by {@link AlgoDidRegistrar}.
 *
 *   - `controller` — host-opaque identifier of the entity the DID
 *     belongs to (an org id, a tenant id, a synthetic issuer id).
 *     Forwarded verbatim to the chain writer and the key-provisioning
 *     port; the package never inspects it.
 *   - `provisioningOptions` — host-specific pass-through bag forwarded
 *     to {@link KeyProvisioningPort.provision} (e.g. a transit-path
 *     override). Optional.
 *   - `force` — re-publish even if a document for `controller` already
 *     exists. Semantics defined by the host's chain adapter; the
 *     package forwards through `chain.uploadDocument`'s metadata
 *     contract on best-effort basis (writer adapters that don't honour
 *     `force` should reject the publish themselves).
 */
export interface AlgoDidCreateOptions extends DidCreateOptions {
  method: 'algo';
  did?: never;
  options: {
    controller: string;
    provisioningOptions?: Record<string, unknown>;
    force?: boolean;
  };
}

export interface AlgoDidDeactivateOptions extends DidDeactivateOptions {
  did: string;
}

/**
 * Optional registry surface the registrar uses to bind a freshly
 * provisioned public key to its KMS handle (the opaque `keyRef`) so
 * future Credo signing requests route back to the host's KMS.
 *
 * Shape matches `vaultSigningRegistry` from
 * `@algorandfoundation/credo-vault-wallet`, but is declared here as a
 * narrow port so the package never imports the wallet package and a
 * host that wires a different KMS plumbing (HSM, AWS KMS) can pass
 * any compatible registry.
 */
export interface KeyRefRegistry {
  bind(publicKeyBase58: string, keyRef: unknown): Promise<void>;
  unbind?(publicKeyBase58: string): Promise<void>;
}

/**
 * Host-agnostic Credo `DidRegistrar` for `did:algo`.
 *
 * Composes three host ports:
 *
 *   - {@link DidAlgoChainWriterPort} — publish / delete documents on
 *     chain and read back the local mirror.
 *   - {@link KeyProvisioningPort} — resolve (or lazy-create) the
 *     ed25519 key material backing a controller.
 *   - {@link KeyRefRegistry} (optional) — bind the resulting public
 *     key to its KMS handle so subsequent Credo signing requests for
 *     the issuer DID route to the host's KMS. Hosts that don't need
 *     wallet-mediated signing (e.g. verify-only deployments wiring
 *     the registrar only for tests) may omit it.
 *
 * Updates are intentionally unsupported in this iteration: the
 * platform's contract semantics treat the document as immutable per
 * publication. To rotate or amend a `did:algo`, deactivate and
 * re-create.
 */
export class AlgoDidRegistrar implements DidRegistrar {
  readonly supportedMethods = ['algo'];

  private readonly logger: {
    log: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };

  constructor(
    private readonly chain: DidAlgoChainWriterPort,
    private readonly keyProvisioning: KeyProvisioningPort,
    private readonly options: {
      keyRefRegistry?: KeyRefRegistry;
      logger?: {
        log?: (msg: string) => void;
        warn?: (msg: string) => void;
        error?: (msg: string) => void;
      };
    } = {},
  ) {
    const l = options.logger;
    this.logger = {
      log: l?.log?.bind(l) ?? (() => undefined),
      warn: l?.warn?.bind(l) ?? (() => undefined),
      error: l?.error?.bind(l) ?? (() => undefined),
    };
  }

  async create(agentContext: AgentContext, options: AlgoDidCreateOptions): Promise<DidCreateResult> {
    try {
      const { controller, provisioningOptions, force } = options.options ?? ({} as AlgoDidCreateOptions['options']);
      if (!controller) {
        return this.failed('AlgoDidRegistrar.create requires options.controller');
      }

      // Resolve (or lazy-create, at the host's discretion) the
      // ed25519 key material backing this controller. The package
      // never decides whether lazy-create is allowed — that's the
      // host's policy, expressed through `provisioningOptions`.
      const provisioned = await this.keyProvisioning.provision({
        controller,
        options: provisioningOptions,
      });
      const publicKey = provisioned.publicKey;
      if (publicKey.length !== 32) {
        return this.failed(
          `AlgoDidRegistrar.create: KeyProvisioningPort returned ${publicKey.length}-byte key for controller=${controller}; expected 32 bytes (ed25519).`,
        );
      }
      const publicKeyBase58 = TypedArrayEncoder.toBase58(publicKey);

      // Bind the public key to its opaque KMS handle *before*
      // publishing on chain so a crash mid-publish doesn't leave the
      // wallet unable to sign for the (already-on-chain) DID on the
      // next reuse. Hosts that omit the registry (e.g. verify-only
      // wiring) get a no-op.
      if (this.options.keyRefRegistry) {
        await this.options.keyRefRegistry.bind(publicKeyBase58, provisioned.keyRef);
      }

      const published = await this.chain.uploadDocument({
        controller,
        keyRef: provisioned.keyRef,
        publicKeyBase58,
        force: Boolean(force),
      });

      // Persist a Credo `DidRecord` so subsequent signing calls (this
      // issuer signing a JWT, this manager signing a credential) can
      // resolve the DID through the local-record path without an
      // on-chain round-trip.
      const didRepository = agentContext.dependencyManager.resolve(DidRepository);
      const didDocument = buildCredoDidDocumentFromKey(published.did, publicKey);
      const didRecord = new DidRecord({
        did: published.did,
        role: DidDocumentRole.Created,
        didDocument,
      });
      await didRepository.save(agentContext, didRecord);

      this.logger.log(`Published did:algo for controller=${controller} → ${published.did}`);

      return {
        didState: {
          state: 'finished',
          did: published.did,
          didDocument,
        },
        didRegistrationMetadata: {},
        didDocumentMetadata: {},
      };
    } catch (err) {
      return this.failed((err as Error).message);
    }
  }

  async update(): Promise<DidUpdateResult> {
    return {
      didState: {
        state: 'failed',
        reason:
          'did:algo update is not supported by AlgoDidRegistrar; deactivate the DID and create a new one with an updated document.',
      },
      didRegistrationMetadata: {},
      didDocumentMetadata: {},
    };
  }

  async deactivate(_agentContext: AgentContext, options: AlgoDidDeactivateOptions): Promise<DidDeactivateResult> {
    try {
      const { did } = options;
      if (!did) {
        return this.failedDeactivate('AlgoDidRegistrar.deactivate requires options.did');
      }

      // The DID identifier is self-describing — the public key bytes
      // are encoded in the identifier itself, so we don't need any
      // host-side cache lookup to recover them.
      const parsed = parseDidAlgo(did);
      if (!parsed) {
        return this.failedDeactivate(`Unable to parse did:algo identifier for deactivate: ${did}`);
      }
      const publicKeyBase58 = TypedArrayEncoder.toBase58(parsed.publicKey);

      await this.chain.deleteDocument({ did, publicKeyBase58 });
      if (this.options.keyRefRegistry?.unbind) {
        await this.options.keyRefRegistry.unbind(publicKeyBase58);
      }
      this.logger.log(`Deactivated did:algo did=${did}`);
      return {
        didState: { state: 'finished', did, didDocument: undefined as never },
        didRegistrationMetadata: {},
        didDocumentMetadata: {},
      };
    } catch (err) {
      return this.failedDeactivate((err as Error).message);
    }
  }

  private failed(reason: string): DidCreateResult {
    this.logger.error(`AlgoDidRegistrar.create failed: ${reason}`);
    return {
      didState: { state: 'failed', reason },
      didRegistrationMetadata: {},
      didDocumentMetadata: {},
    };
  }

  private failedDeactivate(reason: string): DidDeactivateResult {
    this.logger.error(`AlgoDidRegistrar.deactivate failed: ${reason}`);
    return {
      didState: { state: 'failed', reason },
      didRegistrationMetadata: {},
      didDocumentMetadata: {},
    };
  }
}

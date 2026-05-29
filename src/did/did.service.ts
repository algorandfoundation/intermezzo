import { ConflictException, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Address, AlgorandClient, waitForConfirmation } from '@algorandfoundation/algokit-utils';

import {
  DidAlgoStorageClient,
  DidAlgoStorageFactory,
  DidUnsignedGroup,
  buildCreateUserContractGroup,
  buildDidIdentifier,
  buildReplaceDIDDocumentGroups,
  deleteDIDDocument,
  genesisIdToNetwork,
  replaceDIDDocument,
  resolveDIDDocument,
  tryReadMetadata,
} from '../../libs/did-algo';
import { decodeSignedTransaction, encodeTransaction } from '@algorandfoundation/algokit-utils/transact';
import { parseDidAlgo } from '../../libs/credo-did-algo';
import { buildDidDocument } from './did-document';
import { decodeDidKeyEd25519 } from './did-key';
import { buildManagerSigner } from './vault-signer';
import { ChainService } from '../chain/chain.service';
import { VaultService } from '../vault/vault.service';
import { APP_ACCOUNT_BASE_MBR_MICROALGOS, topUpFromSender } from '../../libs/did-algo/algorand';
import { ManagerVaultTokenProvider } from '../auth/manager-vault-token.provider';

/**
 * Vault KV-v2 path that stores the manager's `DIDAlgoStorage`
 * app id. Persisted under the platform mount (default `secret`)
 * so the value lives alongside the existing Vault-managed state
 * instead of in `.env` or a sidecar database.
 */
export const MANAGER_APP_ID_KV_PATH = 'intermezzo/manager/app-id';

/** Folder under which per-user `DIDAlgoStorage` app ids are stored,
 * keyed by the wallet's `did:key`. Each user gets their **own**
 * contract so the box-MBR follows the user (not the manager) and
 * tear-down is local to that user.
 */
export const USERS_APP_ID_KV_FOLDER = 'intermezzo/users/';

/** Build the per-user KV path for a wallet `did:key`. */
export function userAppIdKvPath(didKey: string): string {
  return `${USERS_APP_ID_KV_FOLDER}${encodeURIComponent(didKey)}/app-id`;
}

export interface PublishedDidInfo {
  did: string;
  document: object;
  txIds: string[];
}

/**
 * Publishes `did:algo` documents to the `DIDAlgoStorage` smart
 * contract. The service is **stateless** — there is no local cache
 * of published documents; the on-chain `DIDAlgoStorage` boxes are the
 * single source of truth, and resolution is handled by the chain
 * reader / Credo resolver via the package `AlgoDidResolver`.
 *
 * Post‑M3.6 the only DIDs the host ever mints are:
 *   - the **controller** DID (the manager today, additional
 *     onboarded organisations in the future), via
 *     {@link publishControlledDid};
 *   - **uncontrolled** DIDs owned by a wallet-held `did:key`, via
 *     {@link publishUncontrolledDid}.
 *
 * Both paths sign the on-chain box write with the manager's
 * Vault-backed key.
 */
@Injectable()
export class DidService {
  private readonly logger = new Logger(DidService.name);

  /**
   * Most recently observed `DIDAlgoStorage` app id. This is **not** a
   * cache — {@link ensureAppIdLoaded} re-reads Vault KV on every call
   * and overwrites this field (including resetting it to `undefined`
   * when the KV entry has been removed). The field exists only so
   * the sync accessors (`getAppId`, `deriveDid`, `getAppAddress`)
   * have a value to return after an explicit `await ensureAppIdLoaded()`
   * by the caller. The canonical store is Vault KV at
   * {@link MANAGER_APP_ID_KV_PATH}.
   */
  private appIdOverride?: bigint;

  constructor(
    private readonly configService: ConfigService,
    private readonly chainService: ChainService,
    private readonly vaultService: VaultService,
    @Inject(forwardRef(() => ManagerVaultTokenProvider))
    private readonly managerToken: ManagerVaultTokenProvider,
  ) {}

  /**
   * App id of the deployed `DIDAlgoStorage` contract for the active
   * network, or `undefined` when none has been provisioned yet. The
   * service no longer requires `DID_ALGO_APP_ID` to be set at boot —
   * the manager can call {@link deployStorage} to mint a fresh contract
   * at any time (initial bring-up, key rotation, network switch).
   */
  getAppIdIfDeployed(): bigint | undefined {
    return this.appIdOverride;
  }

  /**
   * Re-read the `DIDAlgoStorage` app id from Vault KV on every call.
   * Callers that depend on the sync accessors (`hasAppId`, `deriveDid`,
   * `getAppId`, `getAppAddress`) must `await` this first so the in-memory
   * mirror reflects the canonical KV state — including the case where
   * an operator has deleted the KV entry (and any chain-side contract)
   * and expects the service to forget the previous app id immediately.
   *
   * Never latches: every invocation hits Vault. Vault failures propagate
   * via `managerToken.getToken()` / `vaultService.kvRead`.
   */
  async ensureAppIdLoaded(): Promise<void> {
    const token = await this.managerToken.getToken();
    // `kvRead` returns `undefined` on a 404 (KV path absent — the legitimate
    // "no contract deployed" steady-state) and throws on any other upstream
    // error (401/403/network → 503).
    const entry = await this.vaultService.kvRead<{ appId: string }>(MANAGER_APP_ID_KV_PATH, token);
    if (entry?.appId) {
      this.appIdOverride = BigInt(entry.appId);
    } else {
      // KV entry removed (or never written): forget any previously observed
      // app id so the next `deriveDid` / `getAppId` reflects the absence.
      this.appIdOverride = undefined;
    }
  }

  /** Whether a `DIDAlgoStorage` contract is currently configured. */
  hasAppId(): boolean {
    return this.getAppIdIfDeployed() !== undefined;
  }

  /**
   * Algorand address of the deployed `DIDAlgoStorage` application
   * account (the address that holds the box-storage MBR). Throws if
   * no contract is configured — callers should gate on
   * {@link hasAppId} first.
   */
  getAppAddress(): string {
    const appId = this.getAppId();
    const algorand = this.buildAlgorandClient();
    const appClient = new DidAlgoStorageClient({ appId, algorand });
    return appClient.appAddress.toString();
  }

  /**
   * Resolve the on-chain DID Document for an arbitrary `did:algo`
   * identifier. Returns `null` when no document is currently published
   * (missing metadata box, mid-upload, mid-delete, or unparseable JSON).
   *
   * This is the single entry point the Credo `AlgoDidResolver` uses to
   * answer "what is the document for this DID?" — the host has no
   * in-memory DID Document cache; every call reads chain.
   *
   * The DID identifier itself carries the appId of the
   * `DIDAlgoStorage` contract that holds the document, so the helper
   * is correct even when the same host hosts multiple contracts (one
   * per user, plus the manager's).
   */
  async resolveOnChainDocument(did: string): Promise<Record<string, unknown> | null> {
    const parsed = parseDidAlgo(did);
    if (!parsed) return null;
    // Reject DIDs anchored to a different network than the one this
    // service is currently configured against — they would resolve
    // against the wrong contract address.
    if (parsed.network !== this.getNetwork()) return null;
    let appId: bigint;
    try {
      appId = BigInt(parsed.appId);
    } catch {
      return null;
    }
    const algorand = this.buildAlgorandClient();
    const appClient = new DidAlgoStorageClient({ appId, algorand });
    return resolveDIDDocument(appClient, parsed.publicKey);
  }

  private getAppId(): bigint {
    const appId = this.getAppIdIfDeployed();
    if (appId === undefined) {
      throw new Error(
        'Manager DIDAlgoStorage app id is not configured. Deploy the manager contract via ' +
          'POST /v1/wallet/manager/identity (the resulting app id is persisted to ' +
          'Vault KV at ' +
          MANAGER_APP_ID_KV_PATH +
          ') before publishing or resolving did:algo documents.',
      );
    }
    return appId;
  }

  /** Slug used for the `did:algo:<network>:...` identifier (derived from `GENESIS_ID`). */
  private getNetwork(): string {
    return genesisIdToNetwork(this.configService.get<string>('GENESIS_ID'));
  }

  /**
   * Build a configured `AlgorandClient` pointing at the project's algod node.
   * Reuses the existing `NODE_HTTP_SCHEME` / `NODE_HOST` / `NODE_PORT` / `NODE_TOKEN`
   * variables already used by `ChainService`, so a single set of env vars governs
   * both transaction submission and DID publication.
   */
  private buildAlgorandClient(): AlgorandClient {
    const scheme = this.configService.get<string>('NODE_HTTP_SCHEME') ?? 'http';
    const host = this.configService.get<string>('NODE_HOST') ?? 'localhost';
    const port = this.configService.get<string>('NODE_PORT') ?? 4001;
    return AlgorandClient.fromConfig({
      algodConfig: {
        server: `${scheme}://${host}`,
        port,
        token: this.configService.get<string>('NODE_TOKEN') ?? '',
      },
    });
  }

  /**
   * Ensure the manager has a `DIDAlgoStorage` contract.
   *
   * - **No manager contract yet** → deploy one, persist its appId to
   *   Vault KV at {@link MANAGER_APP_ID_KV_PATH}, fund the app account's
   *   base MBR, return `{operation: 'create'}`.
   * - **Manager contract exists, `force=false`** → throw
   *   `ConflictException`. Operators must explicitly opt in to the
   *   update path.
   * - **Manager contract exists, `force=true`** → *update in place*.
   *   Do **not** mint a new contract. Delete the manager's existing
   *   DID-document box (if any) on the existing contract to reclaim
   *   its MBR; the appId stays unchanged so all previously-issued
   *   credentials anchored at this DID's network/appId tuple keep
   *   resolving once a fresh document is republished. Return
   *   `{operation: 'update'}`.
   *
   * The previous "force = redeploy a brand-new contract" behaviour
   * abandoned the old app account on chain on every rotation; the
   * update-in-place flow keeps the same contract for the lifetime of
   * the manager identity.
   */
  async deployStorage(
    vaultToken: string,
    options: { force?: boolean } = {},
  ): Promise<{
    appId: bigint;
    appAddress: string;
    operation: string;
    deleteTxIds: string[];
    uploadTxIds: string[];
    skipped: boolean;
    oldMbrMicroAlgos: string;
    newMbrMicroAlgos: string;
  }> {
    const force = options.force ?? false;
    await this.ensureAppIdLoaded();
    const previousAppId = this.getAppIdIfDeployed();
    if (previousAppId !== undefined && !force) {
      throw new ConflictException(
        `deployStorage: manager DIDAlgoStorage already deployed (appId=${previousAppId}). ` +
          `Pass { force: true } to update in place; the existing manager DID-document box MBR ` +
          `will be reclaimed and the appId will be retained.`,
      );
    }
    const algorand = this.buildAlgorandClient();
    const { address: managerAddress, signer } = await buildManagerSigner(
      this.vaultService,
      this.chainService,
      vaultToken,
    );
    algorand.setSigner(managerAddress.toString(), signer);
    algorand.setDefaultSigner(signer);

    // The manager is assumed to be externally funded on every
    // network (localnet bootstrap lives in `vault/development-init.ts`
    // and `scripts/deploy-did-algo.ts`). Auto-funding from the KMD
    // dispenser during deployment is intentionally disabled here:
    // all on-chain costs (app creation fee, app-account base MBR,
    // per-box MBR) are paid by the manager via explicit, exact-amount
    // transactions.

    // Resolve the manager's app id & app client — either reuse the
    // existing contract (force path) or deploy a fresh one. Both
    // paths end with a single call into `replaceDIDDocument`, so
    // the on-chain publish is centralised in `libs/did-algo` and
    // there is no way to "deploy but forget to upload".
    let appId: bigint;
    let appClient: DidAlgoStorageClient;
    let operation: string;

    if (previousAppId !== undefined && force) {
      appId = previousAppId;
      appClient = new DidAlgoStorageClient({
        appId,
        algorand,
        defaultSender: managerAddress,
        defaultSigner: signer,
      });
      operation = 'update';
      this.logger.log(`deployStorage: force=true; updating manager DID document in place on appId=${appId}`);
    } else {
      const factory = new DidAlgoStorageFactory({
        algorand,
        defaultSender: managerAddress.toString(),
        defaultSigner: signer,
      });
      this.logger.log(`deployStorage: deploying manager DIDAlgoStorage as ${managerAddress.toString()}`);
      const deployed = await factory.deploy({
        onUpdate: 'append',
        onSchemaBreak: 'append',
        existingDeployments: { creator: managerAddress, apps: {} },
      });
      appClient = deployed.appClient;
      appId = appClient.appId;
      operation = deployed.result.operationPerformed;
      this.logger.log(`deployStorage: operation=${operation} appId=${appId} appAddress=${appClient.appAddress}`);

      // Fund the freshly-minted contract account from the manager
      // with just its base MBR (0.1 ALGO). Per-box MBR is paid
      // inline by the manager as part of each upload group.
      try {
        await topUpFromSender(algorand, managerAddress, appClient.appAddress, APP_ACCOUNT_BASE_MBR_MICROALGOS);
      } catch (err) {
        this.logger.warn(`deployStorage: app-address MBR top-up skipped (${(err as Error).message ?? err})`);
      }

      await this.vaultService.kvWrite(MANAGER_APP_ID_KV_PATH, { appId: appId.toString() }, vaultToken);
      this.appIdOverride = appId;
    }

    // Build & publish the manager DID document atomically (delete
    // existing box if present, then upload the new one). Both
    // create- and update-paths funnel through here so the response
    // always carries the resulting transaction ids.
    const did = buildDidIdentifier(this.getNetwork(), appId, managerAddress.publicKey);
    const document = buildDidDocument({ did, publicKey: managerAddress.publicKey });
    const data = Buffer.from(JSON.stringify(document), 'utf-8');
    const { skipped, deleteTxIds, uploadTxIds, oldMbrMicroAlgos, newMbrMicroAlgos } = await replaceDIDDocument(
      appClient,
      algorand,
      data,
      appId,
      managerAddress.publicKey,
      managerAddress,
    );
    if (skipped) {
      this.logger.log(
        `deployStorage: on-chain doc already byte-identical did=${did} ` +
          `mbr=${newMbrMicroAlgos}µAlgo (no transactions issued)`,
      );
    } else {
      const delta = newMbrMicroAlgos - oldMbrMicroAlgos;
      this.logger.log(
        `deployStorage: published manager did=${did} ` +
          `deleteTxCount=${deleteTxIds.length} uploadTxCount=${uploadTxIds.length} ` +
          `oldMbr=${oldMbrMicroAlgos}µAlgo newMbr=${newMbrMicroAlgos}µAlgo ` +
          `netManagerCost=${delta}µAlgo`,
      );
    }

    return {
      appId,
      appAddress: appClient.appAddress.toString(),
      operation,
      deleteTxIds,
      uploadTxIds,
      skipped,
      oldMbrMicroAlgos: oldMbrMicroAlgos.toString(),
      newMbrMicroAlgos: newMbrMicroAlgos.toString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Per-user `DIDAlgoStorage` contracts.
  //
  // Each wallet `did:key` gets its **own** contract. The manager
  // Vault key signs the on-chain operations (deploy, upload, delete)
  // and pays the storage MBR; the resulting DID Document declares the
  // user's `did:key` as the cryptographic controller, so even though
  // the manager mints the contract it has no signing authority over
  // the resulting `did:algo`.
  // ─────────────────────────────────────────────────────────────────

  /**
   * Look up the per-user `DIDAlgoStorage` app id for the given
   * `did:key` in Vault KV. Returns `undefined` when none has been
   * provisioned yet. Never falls back to the manager appId.
   */
  async getUserAppId(didKey: string, token: string): Promise<bigint | undefined> {
    const entry = await this.vaultService.kvRead<{ appId: string }>(userAppIdKvPath(didKey), token);
    return entry?.appId ? BigInt(entry.appId) : undefined;
  }

  /**
   * Persist a freshly-deployed per-user `DIDAlgoStorage` app id
   * under `intermezzo/users/{did:key}/app-id` in Vault KV. Idempotent
   * — overwrites any previous value (callers prove they hold the
   * `did:key`'s private signer at create time, so this is safe).
   */
  private async writeUserAppId(didKey: string, appId: bigint, vaultToken: string): Promise<void> {
    await this.vaultService.kvWrite(userAppIdKvPath(didKey), { appId: appId.toString() }, vaultToken);
  }

  /**
   * List every user `did:key` that has a per-user `DIDAlgoStorage`
   * contract registered in Vault KV under `intermezzo/users/`,
   * together with their `did:algo` identifier and contract metadata.
   *
   * Pure KV read — does **not** resolve the on-chain DID Document.
   */
  async listUserDids(
    vaultToken: string,
  ): Promise<Array<{ didKey: string; did: string; appId: string; appAddress: string }>> {
    // KV list returns immediate children of `intermezzo/users/`. Each
    // child is the URL-encoded `did:key` followed by `/` (KV-v2 marks
    // subfolders with a trailing slash).
    const entries = await this.vaultService.kvList(USERS_APP_ID_KV_FOLDER, vaultToken);
    const out: Array<{ didKey: string; did: string; appId: string; appAddress: string }> = [];
    const network = this.getNetwork();
    const algorand = this.buildAlgorandClient();
    for (const entry of entries) {
      // Strip a trailing slash (folder marker).
      const encoded = entry.endsWith('/') ? entry.slice(0, -1) : entry;
      let didKey: string;
      try {
        didKey = decodeURIComponent(encoded);
      } catch {
        // Skip un-decodable entries instead of failing the whole list.
        this.logger.warn(`listUserDids: skipping un-decodable KV entry "${entry}"`);
        continue;
      }
      const appId = await this.getUserAppId(didKey, vaultToken);
      if (appId === undefined) continue;
      let publicKey: Uint8Array;
      try {
        publicKey = decodeDidKeyEd25519(didKey);
      } catch (err) {
        this.logger.warn(`listUserDids: skipping invalid did:key "${didKey}": ${(err as Error).message}`);
        continue;
      }
      const did = buildDidIdentifier(network, appId, publicKey);
      const appAddress = new DidAlgoStorageClient({ appId, algorand }).appAddress.toString();
      out.push({ didKey, did, appId: appId.toString(), appAddress });
    }
    return out;
  }

  /**
   * Lookup a single user record by `did:key`. Returns `null` when no
   * per-user contract has been provisioned for that key yet.
   */
  async getUserDid(
    didKey: string,
    vaultToken: string,
  ): Promise<{ didKey: string; did: string; appId: string; appAddress: string } | null> {
    const appId = await this.getUserAppId(didKey, vaultToken);
    if (appId === undefined) return null;
    const publicKey = decodeDidKeyEd25519(didKey);
    const did = buildDidIdentifier(this.getNetwork(), appId, publicKey);
    const algorand = this.buildAlgorandClient();
    const appAddress = new DidAlgoStorageClient({ appId, algorand }).appAddress.toString();
    return { didKey, did, appId: appId.toString(), appAddress };
  }

  /**
   * Derive the canonical `did:algo` identifier for an ed25519 public
   * key without any chain or cache I/O. Useful when callers need to
   * advertise a DID alongside a vault-resident user key even though
   * the host no longer maintains a local cache of published documents.
   */
  deriveDid(publicKey: Uint8Array): string {
    return buildDidIdentifier(this.getNetwork(), this.getAppId(), publicKey);
  }

  /**
   * Build a `did:algo` identifier and a minimal W3C DID document for
   * the supplied controller public key. The key is referenced as the
   * sole authentication and assertion method. Used by the manager DID
   * provisioning path; post‑M3.6 there are no per‑user enrichments
   * (no linked wallet, no promoted subkeys, no manifest anchor).
   */
  buildControllerDocument(publicKey: Uint8Array): {
    did: string;
    network: string;
    appId: bigint;
    document: object;
  } {
    const network = this.getNetwork();
    const appId = this.getAppId();
    const did = buildDidIdentifier(network, appId, publicKey);
    const document = buildDidDocument({ did, publicKey });
    return { did, network, appId, document };
  }

  /**
   * Publish a `did:algo` document for the supplied **controller** key
   * on the configured `DIDAlgoStorage` contract, signing all
   * transactions with the manager's Vault‑backed key. The
   * `controller` argument is opaque to the chain — it is logged only
   * for host-side correlation.
   *
   * When a document already exists on chain for the supplied public
   * key the publish is a no‑op unless `force` is set, in which case
   * the existing document is deleted (reclaiming the box MBR back to
   * the manager) and a fresh one is uploaded.
   */
  async publishControlledDid(params: {
    controller: string;
    publicKey: Uint8Array;
    vaultToken: string;
    force?: boolean;
  }): Promise<PublishedDidInfo> {
    const { controller, publicKey, vaultToken, force } = params;
    const built = this.buildControllerDocument(publicKey);
    const { did, appId } = built;
    const document = built.document;
    const documentJson = JSON.stringify(document);
    const data = Buffer.from(documentJson, 'utf-8');

    const algorand = this.buildAlgorandClient();
    const { address: managerAddress, signer } = await buildManagerSigner(
      this.vaultService,
      this.chainService,
      vaultToken,
    );
    algorand.setSigner(managerAddress, signer);
    algorand.setDefaultSigner(signer);
    const appClient = new DidAlgoStorageClient({
      appId,
      algorand,
      defaultSender: managerAddress,
      defaultSigner: signer,
    });

    // Short-circuit: if a document is already published and the
    // caller did not opt into a refresh, return without writing. The
    // central `replaceDIDDocument` helper always rewrites — callers
    // own the "is a rewrite needed?" policy.
    const existing = await tryReadMetadata(appClient, publicKey);
    if (existing && !force) {
      this.logger.log(
        `publishControlledDid: on-chain doc already present did=${did} controller=${controller}; skipping publish`,
      );
      return { did, document, txIds: [] };
    }

    const { skipped, deleteTxIds, uploadTxIds, oldMbrMicroAlgos, newMbrMicroAlgos } = await replaceDIDDocument(
      appClient,
      algorand,
      data,
      appId,
      publicKey,
      managerAddress,
    );
    const txIds = [...deleteTxIds, ...uploadTxIds];
    if (skipped) {
      this.logger.log(
        `publishControlledDid: on-chain doc already byte-identical did=${did} ` +
          `controller=${controller} mbr=${newMbrMicroAlgos}µAlgo (no transactions issued)`,
      );
    } else {
      this.logger.log(
        `publishControlledDid: published did=${did} controller=${controller} ` +
          `deleteTxCount=${deleteTxIds.length} uploadTxCount=${uploadTxIds.length} ` +
          `oldMbr=${oldMbrMicroAlgos}µAlgo newMbr=${newMbrMicroAlgos}µAlgo ` +
          `netManagerCost=${newMbrMicroAlgos - oldMbrMicroAlgos}µAlgo`,
      );
    }
    return { did, document, txIds };
  }

  /**
   * Tear down the on-chain `did:algo` document for the supplied public
   * key (reclaiming the box MBR back to the manager). The public key
   * is passed in directly — without a local cache the host has no
   * other way to recover it, and the chain itself does not index
   * boxes by a human-readable controller id.
   *
   * Returns the confirmed transaction ids on success, or `null` if no
   * on-chain document existed.
   */
  async deleteControlledDid(publicKey: Uint8Array, vaultToken: string): Promise<{ txIds: string[] | null }> {
    const algorand = this.buildAlgorandClient();
    const appId = this.getAppId();
    const { address: managerAddress, signer } = await buildManagerSigner(
      this.vaultService,
      this.chainService,
      vaultToken,
    );
    algorand.setSigner(managerAddress, signer);
    algorand.setDefaultSigner(signer);

    const appClient = new DidAlgoStorageClient({
      appId,
      algorand,
      defaultSender: managerAddress,
      defaultSigner: signer,
    });

    const metadata = await tryReadMetadata(appClient, publicKey);
    const pubKeyAddress = new Address(publicKey).toString();
    if (!metadata) {
      this.logger.log(`deleteControlledDid: no on-chain doc to remove address=${pubKeyAddress}`);
      return { txIds: null };
    }

    const txIds = await deleteDIDDocument(appClient, algorand, appId, publicKey, managerAddress);
    this.logger.log(`deleteControlledDid: removed on-chain doc address=${pubKeyAddress} txCount=${txIds.length}`);
    return { txIds };
  }

  /**
   * Build a `did:algo` identifier and a DID document for a public key
   * that is **not** controlled by the host, anchored at the supplied
   * per-user `appId`. The wallet's `did:key` is declared as the
   * verification-method controller and surfaced via `alsoKnownAs`, so
   * any resolver can see that ownership of the on-chain document
   * belongs to the wallet — not to whoever paid the box MBR.
   */
  buildUncontrolledDocument(
    publicKey: Uint8Array,
    ownerDidKey: string,
    appId: bigint,
  ): { did: string; network: string; appId: bigint; document: object } {
    const network = this.getNetwork();
    const did = buildDidIdentifier(network, appId, publicKey);
    const document = buildDidDocument({ did, publicKey, controllerDid: ownerDidKey });
    return { did, network, appId, document };
  }

  // ─────────────────────────────────────────────────────────────────
  // User-owned per-user `DIDAlgoStorage` contracts.
  //
  // The contract's on-chain rules assert `Txn.sender === creator` on
  // every write entry point — and we deliberately set the creator to
  // be the **wallet's `did:key`-derived address**, not the manager.
  // That single decision (made at app-create time) pins authority to
  // the wallet for the lifetime of the contract: the manager Vault
  // key never signs an app-call, only the `pay` txns that pool fees
  // and fund the user's account min-balance / per-box MBR. The host
  // signs those `pay` txns **only at submit time**, after validating
  // that every wallet-signed txn matches the canonical bytes the
  // server emitted from the `build…` endpoint — i.e. the host
  // refuses to commit its signature to a group it did not generate.
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build (but do not sign or send) the single atomic group that
   * deploys a fresh per-user `DIDAlgoStorage` contract owned by
   * {@link params.didKey}. The wallet signs index 2 (the
   * `applicationCreate`); the host signs the two preceding `pay`
   * txns only at submit time after validating the wallet's
   * signature is over the exact bytes we emitted.
   */
  async buildUserContractCreate(params: { didKey: string; vaultToken: string }): Promise<UserContractCreatePlan> {
    const { didKey, vaultToken } = params;
    const existing = await this.getUserAppId(didKey, vaultToken);
    if (existing !== undefined) {
      throw new ConflictException(
        `Per-user DIDAlgoStorage already deployed for ${didKey} (appId=${existing}). ` +
          `Use POST /did/update/transactions to refresh the on-chain DID document instead.`,
      );
    }

    const publicKey = decodeDidKeyEd25519(didKey);
    const algorand = this.buildAlgorandClient();
    const { address: managerAddress, signer } = await buildManagerSigner(
      this.vaultService,
      this.chainService,
      vaultToken,
    );
    algorand.setSigner(managerAddress.toString(), signer);
    algorand.setDefaultSigner(signer);

    const userAddress = new Address(publicKey);
    const group = await buildCreateUserContractGroup(algorand, { userAddress, managerAddress });

    return {
      didKey,
      managerAddress: managerAddress.toString(),
      userAddress: userAddress.toString(),
      group,
    };
  }

  /**
   * Broadcast a user-signed `applicationCreate` group, persist the
   * resulting per-user app id, and return the new `did:algo`.
   *
   * The host:
   *   1. **Rebuilds** the expected unsigned group from canonical
   *      inputs (`didKey` only — there are no other inputs).
   *   2. **Validates** every wallet-signed position: decode the
   *      `SignedTransaction`, re-encode its `.txn`, and compare
   *      byte-for-byte to the freshly-rebuilt expected canonical
   *      bytes for the same position. Also rejects logic sigs and
   *      multisigs (the wallet must be a plain single-key signer).
   *   3. **Signs** every manager-role position via Vault Transit
   *      (no presigning at build time — the host's signature is
   *      committed only after step 2 passes).
   *   4. **Broadcasts** the merged group via the algokit algod
   *      client, waits for confirmation, reads `created-app-index`
   *      from the post-confirmation `applicationCreate` txn, and
   *      persists `{appId}` to Vault KV under
   *      {@link userAppIdKvPath}.
   */
  async submitUserContractCreate(params: {
    didKey: string;
    signedTxns: (string | null)[];
    vaultToken: string;
  }): Promise<{ appId: string; appAddress: string; did: string; txId: string }> {
    const { didKey, signedTxns, vaultToken } = params;
    const existing = await this.getUserAppId(didKey, vaultToken);
    if (existing !== undefined) {
      throw new ConflictException(`Per-user DIDAlgoStorage already deployed for ${didKey} (appId=${existing}).`);
    }
    const plan = await this.buildUserContractCreate({ didKey, vaultToken });
    const merged = await this.mergeAndSignGroup(plan.group, signedTxns, vaultToken);

    const algorand = this.buildAlgorandClient();
    const response = await algorand.client.algod.sendRawTransaction(merged);
    const headTxId = response?.txId;
    if (!headTxId) {
      throw new Error('Algod did not return a txId for the user-contract create broadcast');
    }
    // The `applicationCreate` txn is at index 2 of the group (after
    // the manager funder pay and the manager→user MBR top-up pay).
    // `sendRawTransaction` only returns the head txn's id, but
    // `confirmation.appId` is populated on the *appCreate* txn —
    // so we derive that txn's id ourselves and wait on it.
    if (merged.length < 3) {
      throw new Error('Expected applicationCreate at index 2 of the user-contract create group');
    }
    // Decode the merged (now-signed) bytes so the embedded txn is
    // group-id-stamped identical to what we just broadcast.
    const appCreateTxn = decodeSignedTransaction(merged[2]).txn;
    const appCreateTxId = appCreateTxn.txId();
    const confirmation = await waitForConfirmation(appCreateTxId, 4, algorand.client.algod);
    if (confirmation.appId === undefined || confirmation.appId === null) {
      throw new Error(
        `Confirmation for create-app txn ${appCreateTxId} did not include a created app id — ` +
          `did the create txn fail on chain? (group head txId=${headTxId})`,
      );
    }
    const appId = confirmation.appId;
    await this.writeUserAppId(didKey, appId, vaultToken);

    const publicKey = decodeDidKeyEd25519(didKey);
    const did = buildDidIdentifier(this.getNetwork(), appId, publicKey);
    const appAddress = new DidAlgoStorageClient({ appId, algorand }).appAddress.toString();
    this.logger.log(
      `submitUserContractCreate: didKey=${didKey} appId=${appId} appAddress=${appAddress} txId=${appCreateTxId}`,
    );
    return { appId: appId.toString(), appAddress, did, txId: appCreateTxId };
  }

  /**
   * Build (but do not sign or send) the atomic transaction groups
   * required to replace the user's on-chain DID document with the
   * supplied payload. Every app-call is sender=`userAddress` (the
   * contract creator); the manager only sponsors a fee-funder `pay`
   * and the MBR `pay`. Pre-signing is **not** performed — the host
   * commits its signature only at submit time, after validating the
   * wallet's signed positions byte-for-byte against canonical bytes
   * rebuilt server-side.
   *
   * The per-user contract must already be provisioned via
   * `POST /did/create/{transactions,submit}`. Returns `null` when no
   * app id is registered for the supplied `did:key`.
   */
  async buildUserDidDocumentUpdate(params: {
    didKey: string;
    document?: object;
    vaultToken: string;
  }): Promise<UserDidUpdatePlan | null> {
    const { didKey, vaultToken } = params;
    const appId = await this.getUserAppId(didKey, vaultToken);
    if (appId === undefined) return null;

    const publicKey = decodeDidKeyEd25519(didKey);
    const did = buildDidIdentifier(this.getNetwork(), appId, publicKey);
    const document = params.document ?? buildDidDocument({ did, publicKey, controllerDid: didKey });
    const data = Buffer.from(JSON.stringify(document), 'utf-8');

    const algorand = this.buildAlgorandClient();
    const { address: managerAddress, signer } = await buildManagerSigner(
      this.vaultService,
      this.chainService,
      vaultToken,
    );
    // The composer wants a registered `TransactionSigner` for both
    // senders so it can attach placeholder signers while building
    // (no `.send()` is invoked — we only consume raw txns).
    algorand.setSigner(managerAddress.toString(), signer);
    algorand.setDefaultSigner(signer);

    const userAddress = new Address(publicKey);
    const appClient = new DidAlgoStorageClient({
      appId,
      algorand,
      defaultSender: userAddress,
      defaultSigner: signer,
    });

    const plan = await buildReplaceDIDDocumentGroups(appClient, algorand, data, appId, publicKey, {
      appCallSender: userAddress,
      mbrPaymentSender: managerAddress,
      // Reclaim every µAlgo of box-MBR the contract inner-refunds
      // to the user on `deleteData` straight back to the manager
      // that originally sponsored it.
      repaymentReceiver: managerAddress,
    });

    const groups: SerializedUserDidUpdateGroup[] = plan.groups.map(serializeUnsignedGroup);
    return {
      did,
      didKey,
      appId: appId.toString(),
      appAddress: appClient.appAddress.toString(),
      managerAddress: managerAddress.toString(),
      userAddress: userAddress.toString(),
      oldMbrMicroAlgos: plan.oldMbrMicroAlgos.toString(),
      newMbrMicroAlgos: plan.newMbrMicroAlgos.toString(),
      groups,
      document,
    };
  }

  /**
   * Broadcast a user-signed DID-document update. The host rebuilds
   * the expected unsigned groups from the supplied {@link params.document}
   * (which must be the same payload that drove the original build
   * call), validates every wallet-signed position against the
   * canonical bytes, signs the manager-role positions, and submits.
   *
   * Groups are submitted serially. The on-chain state machine
   * resumes mid-flow (continuing a partial delete or upload), so a
   * partial failure is safe to retry against a freshly rebuilt
   * plan.
   */
  async submitUserDidDocumentUpdate(params: {
    didKey: string;
    document: object;
    groups: SubmittedUserDidUpdateGroup[];
    vaultToken: string;
  }): Promise<{ txIds: string[] }> {
    const { didKey, document, groups, vaultToken } = params;
    const plan = await this.buildUserDidDocumentUpdate({ didKey, document, vaultToken });
    if (plan === null) {
      throw new Error(`No per-user did:algo registered for ${didKey}`);
    }
    if (plan.groups.length !== groups.length) {
      throw new Error(
        `Group count mismatch: server rebuilt ${plan.groups.length} group(s), wallet submitted ${groups.length}`,
      );
    }

    const algorand = this.buildAlgorandClient();
    const txIds: string[] = [];
    for (let g = 0; g < plan.groups.length; g += 1) {
      const expected: DidUnsignedGroup = {
        groupIdB64: plan.groups[g].groupIdB64,
        txnGroup: plan.groups[g].txnGroup,
        indexesToSign: plan.groups[g].indexesToSign,
        signers: plan.groups[g].signers,
        kinds: plan.groups[g].kinds,
      };
      const merged = await this.mergeAndSignGroup(expected, groups[g].signedTxns ?? [], vaultToken);
      // Run algod's `simulate` against the fully-signed group BEFORE
      // broadcasting. If the live network would reject this group,
      // simulate produces a structured `failureMessage` + `failedAt`
      // path (including inner-txn indexes) that pinpoints which txn
      // and why — vastly more actionable than the opaque
      // `TransactionPool.Remember: ... overspend` algod returns from
      // `sendRawTransaction`. We surface that as a thrown error
      // before the broadcast so we never submit a group we already
      // know will fail.
      await this.simulateGroupOrThrow(algorand, merged, g, expected);
      const response = await algorand.client.algod.sendRawTransaction(merged);
      if (response?.txId) txIds.push(response.txId);
    }
    this.logger.log(
      `submitUserDidDocumentUpdate: didKey=${didKey} appId=${plan.appId} groups=${groups.length} txIds=${txIds.length}`,
    );
    return { txIds };
  }

  /**
   * Run algod's `simulate` against the fully-merged signed group
   * BEFORE we broadcast it via `sendRawTransaction`. The simulator
   * executes the group atomically using the same evaluator the
   * network uses (including inner-txn balance flow), but returns a
   * structured {@link SimulateTransactionGroupResult} instead of the
   * single-line `TransactionPool.Remember: ... overspend` algod
   * normally surfaces.
   *
   * On any non-empty `failureMessage` we throw an error annotated
   * with:
   *  - the offending group index (`g`),
   *  - the path to the failing txn (`failedAt`, including inner
   *    transaction depth),
   *  - the kinds + signer roles of every position in the group, and
   *  - per-position pending tx info from the simulator (logs, inner
   *    txns, account-state deltas) — invaluable for diagnosing
   *    why a "should-work-atomically" inner-refund + outer-pay group
   *    is being rejected.
   *
   * Simulation runs with `allowEmptySignatures: false` (we have
   * full signatures by this point) and `extraOpcodeBudget: 0`
   * (we don't want simulate's permissiveness to mask a real
   * production failure).
   */
  private async simulateGroupOrThrow(
    algorand: AlgorandClient,
    merged: Uint8Array[],
    groupIndex: number,
    expected: DidUnsignedGroup,
  ): Promise<void> {
    const sim = await algorand.client.algod.simulateRawTransactions(merged);
    const result = sim.txnGroups?.[0];
    if (!result?.failureMessage) return;
    const positions = expected.kinds.map((kind, i) => `#${i}:${kind}/${expected.signers[i]}`).join(' ');
    const failedAt = result.failedAt ? result.failedAt.join('.') : '<unknown>';
    const innerHints: string[] = [];
    result.txnResults?.forEach((tr, i) => {
      const pending = tr.txnResult;
      if (pending?.poolError) innerHints.push(`#${i}.poolError=${pending.poolError}`);
      if (pending?.innerTxns && pending.innerTxns.length > 0) {
        innerHints.push(`#${i}.innerTxns=${pending.innerTxns.length}`);
      }
    });
    const hints = innerHints.length > 0 ? ` [${innerHints.join(' ')}]` : '';
    throw new Error(
      `simulateGroup: group ${groupIndex} (${positions}) failed at txn[${failedAt}]: ${result.failureMessage}${hints}`,
    );
  }

  /**
   * Validate a wallet-signed atomic group against the canonical
   * unsigned bytes `expected`, sign the manager-role positions via
   * Vault Transit, and return the merged wire-format ready for
   * `sendRawTransaction`.
   *
   * Validation rules per user-role position:
   *   - The corresponding entry in `signedTxns` must be present
   *     (non-null base64 wire-format).
   *   - The decoded `SignedTransaction.txn`'s canonical bytes must
   *     equal `expected.txnGroup[i]` (i.e. the wallet signed the
   *     exact bytes the server emitted).
   *   - No logic-sig (`lsig`) or multisig (`msig`) wrapping — the
   *     wallet must be a plain ed25519 single-key signer.
   *
   * The host commits its signature only after every user-role
   * position passes validation, eliminating the "host pre-signs a
   * txn the wallet hasn't seen yet" attack surface.
   */
  private async mergeAndSignGroup(
    expected: DidUnsignedGroup,
    signedTxns: (string | null)[],
    vaultToken: string,
  ): Promise<Uint8Array[]> {
    const merged: Uint8Array[] = new Array(expected.txnGroup.length);
    for (let i = 0; i < expected.txnGroup.length; i += 1) {
      const role = expected.signers[i];
      const expectedUnsignedB64 = expected.txnGroup[i];
      if (role === 'user') {
        const wire = signedTxns[i];
        if (!wire) {
          throw new Error(
            `Wallet did not sign user-role position ${i} (${expected.kinds[i]}); ` +
              `expected a signed transaction in signedTxns[${i}].`,
          );
        }
        const wireBytes = new Uint8Array(Buffer.from(wire, 'base64'));
        let decoded;
        try {
          decoded = decodeSignedTransaction(wireBytes);
        } catch (e) {
          throw new Error(`Failed to decode wallet-signed txn at position ${i}: ${(e as Error).message}`);
        }
        if (decoded.lSig) {
          throw new Error(`Position ${i}: wallet returned a logic-sig wrapped txn; refusing to broadcast.`);
        }
        if (decoded.mSig) {
          throw new Error(`Position ${i}: wallet returned a multisig wrapped txn; refusing to broadcast.`);
        }
        if (!decoded.sig) {
          throw new Error(`Position ${i}: wallet-signed txn has no ed25519 signature attached.`);
        }
        const reEncoded = Buffer.from(encodeTransaction(decoded.txn)).toString('base64');
        if (reEncoded !== expectedUnsignedB64) {
          throw new Error(
            `Position ${i} (${expected.kinds[i]}): wallet-signed txn does not match the canonical bytes ` +
              `emitted by the build endpoint — refusing to broadcast a transaction the host did not generate.`,
          );
        }
        merged[i] = wireBytes;
      } else if (role === 'manager') {
        const unsigned = new Uint8Array(Buffer.from(expectedUnsignedB64, 'base64'));
        const vaultSig = await this.vaultService.signAsManager(unsigned, vaultToken);
        const signature = new Uint8Array(Buffer.from(vaultSig.toString().split(':')[2], 'base64'));
        merged[i] = this.chainService.addSignatureToTxn(unsigned, signature);
      } else {
        throw new Error(`Position ${i}: unknown signer role "${role}"`);
      }
    }
    return merged;
  }
}

/**
 * Translate a builder-emitted {@link DidUnsignedGroup} into the
 * unsigned wire shape returned by the `build…` endpoints. No host
 * signatures are attached — the wallet receives the canonical
 * bytes verbatim and signs the positions listed under
 * {@link DidUnsignedGroup.indexesToSign}.
 */
function serializeUnsignedGroup(group: DidUnsignedGroup): SerializedUserDidUpdateGroup {
  return {
    groupIdB64: group.groupIdB64,
    txnGroup: group.txnGroup,
    indexesToSign: group.indexesToSign,
    signers: group.signers,
    kinds: group.kinds,
  };
}

/**
 * Serialized **unsigned** atomic group on the `build…` response,
 * shaped to mirror the wallet-connect signer contract:
 *
 * ```ts
 * async signTransactions(
 *   txnGroup: Uint8Array[],
 *   indexesToSign?: number[],
 * ): Promise<(Uint8Array | null)[]>
 * ```
 *
 * The wallet decodes `txnGroup` from base64, signs every position
 * listed in `indexesToSign` (returning the wire-format signed
 * transaction at those positions and `null` elsewhere), and posts
 * the resulting array back to the submit endpoint as `signedTxns`.
 * The host does not pre-sign at build time: manager positions are
 * signed only at submit time, after validating that the wallet's
 * signatures cover the canonical bytes emitted here.
 */
export interface SerializedUserDidUpdateGroup {
  /** Group id (base64) shared by every transaction in the group. */
  groupIdB64: string;
  /** Canonical unsigned transaction bytes (base64), one per position. */
  txnGroup: string[];
  /** Positions in {@link txnGroup} the wallet must sign. */
  indexesToSign: number[];
  /** Role labels parallel to {@link txnGroup}. */
  signers: ('manager' | 'user')[];
  /** Transaction-type labels parallel to {@link txnGroup} (`pay`, `appl`, …). */
  kinds: string[];
}

/** Output of {@link DidService.buildUserContractCreate}. */
export interface UserContractCreatePlan {
  didKey: string;
  managerAddress: string;
  userAddress: string;
  /** Single atomic group `[managerFunder, managerPay→user, userAppCreate]`. */
  group: SerializedUserDidUpdateGroup;
}

/** Output of {@link DidService.buildUserDidDocumentUpdate}. */
export interface UserDidUpdatePlan {
  did: string;
  didKey: string;
  appId: string;
  appAddress: string;
  managerAddress: string;
  userAddress: string;
  oldMbrMicroAlgos: string;
  newMbrMicroAlgos: string;
  /**
   * Flat list of atomic groups, in execution order. The builder
   * greedily packs every operation required to swap the on-chain
   * payload (`startDelete?`, `deleteData×N`, `mbrPay + startUpload`,
   * `upload×K`, `finishUpload`) into 16-txn groups; any overflow
   * spills naturally into the next group and the on-chain
   * state-machine resumes from where the previous group left off.
   */
  groups: SerializedUserDidUpdateGroup[];
  document: object;
}

/**
 * Input group on the submit endpoint, matching the standard
 * `signTransactions` return contract: `signedTxns` is the wallet's
 * `(Uint8Array | null)[]` (base64-encoded), one entry per position
 * in the original `txnGroup` (`null` at any position the wallet did
 * not sign). The host re-signs every `manager`-role position at
 * submit time after validating the user-role positions match the
 * canonical bytes from `build…`.
 */
export interface SubmittedUserDidUpdateGroup {
  /** Wallet-signed positions; `null` at positions the wallet did not sign. */
  signedTxns: (string | null)[];
}

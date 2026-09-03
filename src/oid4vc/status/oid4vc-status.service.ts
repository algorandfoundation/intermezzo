import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { StatusList, createHeaderAndPayload } from '@sd-jwt/jwt-status-list';
import { AgentContext, SdJwtVcService } from '@credo-ts/core';

import { parseVaultSignature } from '../../../libs/credo-vault-wallet';
import { VaultService } from '../../vault/vault.service';
import { Oid4vcAgentProvider } from '../agent/oid4vc-agent.provider';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';
import { Oid4vcConfig } from '../oid4vc.config';
import { Oid4vcIssuanceSessionRepository } from '../sessions/vault-repository';
import { STATUS_LIST_SIZE, STATUS_REVOKED, STATUS_VALID, StatusListRecord } from '../entities/status-list.entity';
import { StatusListRepository } from './status-list.repository';

/** Id of the list every credential is currently allocated on. */
export const DEFAULT_STATUS_LIST_ID = 'default';

/** Shape of the one `SdJwtVcService` member Phase 4 replaces. */
type StatusListFetcherHost = {
  getStatusListFetcher(agentContext: AgentContext): (uri: string) => Promise<string>;
};

/**
 * List ids we are willing to resolve without leaving the process. Anything
 * else under our own base URL (a nested path, a query string) falls through to
 * the network rather than being guessed at.
 */
const LIST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** A status list entry handed out at issuance time. */
export interface AllocatedStatusEntry {
  listId: string;
  idx: number;
  /** Absolute URI of the list, as embedded in the credential. */
  uri: string;
}

/**
 * Owns the credential status lists: allocating an entry when a credential is
 * issued, flipping its bit when the credential is revoked, and serving the
 * list as a signed `statuslist+jwt`.
 *
 * The list token is signed with the manager's `did:algo` key through Vault
 * transit. That is a constraint, not a preference: Credo configures a single
 * `verifier` for both the credential and its status list, so a list signed by
 * anything other than the credential's issuer key fails verification.
 */
@Injectable()
export class Oid4vcStatusService implements OnModuleInit {
  private readonly logger = new Logger(Oid4vcStatusService.name);

  /**
   * Signed list tokens by list id, dropped whenever a bit changes.
   *
   * Worth caching because every credential verification dereferences the
   * list, while writes are rare.
   *
   * ponytail: per-process cache with no expiry. A revocation performed by
   * another instance would not evict this one's entry, so that instance would
   * keep serving a token saying the credential is live. Give the entry a
   * short TTL, or invalidate across instances, before running more than one.
   */
  private readonly cachedJwt = new Map<string, string>();

  /**
   * Serialises every read-modify-write against a list record.
   *
   * ponytail: in-process only. Two Nest instances would race and could hand
   * out the same index or lose a revocation, because `VaultService.kvWrite`
   * has no compare-and-set. Add `cas` to `kvWrite` and retry on conflict if
   * this is ever deployed more than once.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Oid4vcConfig,
    private readonly repo: StatusListRepository,
    private readonly sessions: Oid4vcIssuanceSessionRepository,
    private readonly agentProvider: Oid4vcAgentProvider,
    private readonly vault: VaultService,
    private readonly tokenProvider: AlgoVaultTokenProvider,
  ) {}

  /**
   * Teaches the agent to resolve *our* status lists without an HTTP round
   * trip. See {@link installLocalStatusListFetcher}.
   */
  async onModuleInit(): Promise<void> {
    if (!this.config.autoInit) return;
    try {
      await this.installLocalStatusListFetcher();
    } catch (err) {
      this.logger.warn(
        `Could not install the in-process status list fetcher (${(err as Error).message}); ` +
          'status checks will fall back to fetching our own URL over HTTP.',
      );
    }
  }

  /**
   * Returns the list id when `uri` is one of ours, and `undefined` when it
   * belongs to another issuer and must be fetched over the network.
   */
  localStatusListId(uri: string): string | undefined {
    const prefix = `${this.config.statusListBaseUrl}/`;
    if (!uri.startsWith(prefix)) return undefined;
    const listId = uri.slice(prefix.length);
    return LIST_ID_PATTERN.test(listId) ? listId : undefined;
  }

  /**
   * Replaces Credo's status list fetcher with one that answers our own URIs
   * from Vault directly, and delegates everything else to the original.
   *
   * This is the enforcement path that actually runs. `CredentialAuthGuard`
   * verifies a credential on *every* wallet request, and each verification
   * dereferences the status list. Without this, every wallet call would make a
   * loopback HTTP request, and — worse — wallet authentication as a whole
   * would depend on the process being able to reach itself at its own
   * advertised hostname. In a container whose `OID4VC_BASE_URL` is an external
   * name, that resolves somewhere else or nowhere, and every request 401s.
   *
   * `SdJwtVcService` is registered with `registerSingleton`, and
   * `getBaseSdJwtConfig` calls `getStatusListFetcher` afresh for every sign and
   * verify, so replacing the method on the resolved instance affects all
   * subsequent verifications.
   */
  private async installLocalStatusListFetcher(): Promise<void> {
    const agent = await this.agentProvider.getAgent();
    const service = agent.context.dependencyManager.resolve(SdJwtVcService);

    // `getStatusListFetcher` is `private` in the type declarations. It is a
    // deliberate reach into Credo: there is no supported hook for supplying a
    // status list fetcher, and the alternative is making wallet auth depend on
    // the server reaching itself over the network.
    const host = service as unknown as StatusListFetcherHost;
    const fetchOverNetwork = host.getStatusListFetcher.bind(service);

    host.getStatusListFetcher = (agentContext: AgentContext) => async (uri: string) => {
      const listId = this.localStatusListId(uri);
      if (listId === undefined) return fetchOverNetwork(agentContext)(uri);
      return this.getStatusListJwt(listId);
    };

    this.logger.log(`Status lists under ${this.config.statusListBaseUrl} will resolve in-process`);
  }

  /**
   * Reserves the next entry on the default list, creating the list on first
   * use. Returns everything the credential mapper needs to embed a
   * `status.status_list` claim.
   */
  async allocate(listId: string = DEFAULT_STATUS_LIST_ID): Promise<AllocatedStatusEntry> {
    return this.serialise(async () => {
      const record = await this.loadOrCreate(listId);
      if (record.nextIndex >= record.size) {
        // ponytail: single list. Rollover is cheap to add later because the
        // list id is stored per credential — mint `${listId}-2` and point new
        // allocations at it.
        throw new Error(
          `Status list ${listId} is full (${record.size} entries). ` +
            'Credentials cannot be issued until a second list is provisioned.',
        );
      }
      const idx = record.nextIndex;
      await this.repo.save({ ...record, nextIndex: idx + 1 });
      // No cache invalidation: allocating hands out an index that is already
      // `0` in the bitstring, so the published list is unchanged.
      return { listId: record.id, idx, uri: this.config.statusListUri(record.id) };
    });
  }

  /**
   * Revokes the credential issued for `sessionId`. Verification fails for
   * everyone from the next status fetch onwards.
   */
  async revokeBySessionId(sessionId: string, reason?: string): Promise<AllocatedStatusEntry> {
    return this.setSessionStatus(sessionId, STATUS_REVOKED, reason);
  }

  /** Reverses {@link revokeBySessionId}, for a revocation made in error. */
  async reactivateBySessionId(sessionId: string): Promise<AllocatedStatusEntry> {
    return this.setSessionStatus(sessionId, STATUS_VALID);
  }

  /**
   * Returns the signed status list token served at
   * {@link Oid4vcConfig.statusListUri}.
   */
  async getStatusListJwt(listId: string = DEFAULT_STATUS_LIST_ID): Promise<string> {
    const cached = this.cachedJwt.get(listId);
    if (cached) return cached;

    // Build inside the queue so a concurrent `setStatus` cannot flip a bit
    // between reading the record and populating the cache — that interleaving
    // would publish, and then keep serving, a token that still says a revoked
    // credential is valid. Re-check the cache first so concurrent misses sign
    // once rather than once each.
    return this.serialise(async () => {
      const fresh = this.cachedJwt.get(listId);
      if (fresh) return fresh;

      const record = await this.requireList(listId);
      const list = StatusList.decompressStatusList(record.encodedList, record.bits);
      const issuer = await this.agentProvider.ensureIssuerDid();
      const { header, payload } = createHeaderAndPayload(
        list,
        {
          iss: issuer.did,
          sub: this.config.statusListUri(listId),
          iat: Math.floor(Date.now() / 1000),
        },
        { alg: 'EdDSA', typ: 'statuslist+jwt', kid: issuer.verificationMethodId },
      );

      // No `exp`. `@sd-jwt` only checks expiry when the claim is present, and
      // an expired list fails every credential that points at it — an
      // availability cliff bought for nothing, since the token is regenerated
      // on every write anyway.
      const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
      const jwt = `${signingInput}.${await this.sign(signingInput)}`;
      this.cachedJwt.set(listId, jwt);
      return jwt;
    });
  }

  /** Reads one entry. Exposed for callers that need the bit, not the token. */
  async getStatus(listId: string, idx: number): Promise<number> {
    const record = await this.requireList(listId);
    return StatusList.decompressStatusList(record.encodedList, record.bits).getStatus(idx);
  }

  private async setSessionStatus(sessionId: string, value: number, reason?: string): Promise<AllocatedStatusEntry> {
    const session = await this.sessions.findOneById(sessionId);
    if (!session) {
      throw new NotFoundException(`Issuance session ${sessionId} not found`);
    }
    const { statusListId, statusListIndex } = session;
    if (!statusListId || typeof statusListIndex !== 'number') {
      throw new NotFoundException(
        `Issuance session ${sessionId} has no status list entry. ` +
          'The offer was never redeemed, or the credential predates status list support.',
      );
    }

    await this.setStatus(statusListId, statusListIndex, value);

    // Audit after the bit, never before: the revocation is the part that
    // matters, and a failure to record who did it must not leave a credential
    // live. Deliberately not rolled back if this write fails.
    const revoked = value !== STATUS_VALID;
    try {
      await this.sessions.update(
        { id: sessionId },
        { revokedAt: revoked ? new Date() : undefined, revokedReason: revoked ? reason : undefined },
      );
    } catch (err) {
      this.logger.error(
        `Status of session ${sessionId} was set to ${value} but the audit fields could not be written: ` +
          `${(err as Error).message}`,
      );
    }

    return { listId: statusListId, idx: statusListIndex, uri: this.config.statusListUri(statusListId) };
  }

  private async setStatus(listId: string, idx: number, value: number): Promise<void> {
    await this.serialise(async () => {
      const record = await this.requireList(listId);
      if (!Number.isInteger(idx) || idx < 0 || idx >= record.size) {
        throw new NotFoundException(`Status list ${listId} has no entry ${idx}`);
      }
      const list = StatusList.decompressStatusList(record.encodedList, record.bits);
      list.setStatus(idx, value);
      await this.repo.save({ ...record, encodedList: list.compressStatusList() });
      this.cachedJwt.delete(listId);
    });
  }

  private async requireList(listId: string): Promise<StatusListRecord> {
    const record = await this.repo.findOneById(listId);
    if (!record) throw new NotFoundException(`Status list ${listId} does not exist`);
    return record;
  }

  private async loadOrCreate(listId: string): Promise<StatusListRecord> {
    const existing = await this.repo.findOneById(listId);
    if (existing) return existing;
    this.logger.log(`Creating status list ${listId} with ${STATUS_LIST_SIZE} entries`);
    const empty = new StatusList(new Array(STATUS_LIST_SIZE).fill(STATUS_VALID), 1);
    return this.repo.save({
      id: listId,
      bits: 1,
      size: STATUS_LIST_SIZE,
      nextIndex: 0,
      encodedList: empty.compressStatusList(),
    });
  }

  /**
   * Signs with the manager transit key — the same key, via the same Vault
   * call, that signs the credentials these lists describe.
   */
  private async sign(signingInput: string): Promise<string> {
    const token = await this.tokenProvider.getToken();
    const signature = await this.vault.sign(
      this.config.managerUserId,
      this.config.managerTransitPath,
      new TextEncoder().encode(signingInput),
      token,
    );
    // `VaultService.sign` is declared `Promise<Buffer>` but returns Vault's
    // `vault:v<n>:<base64>` string. Cast as the agent provider does rather
    // than correcting the signature here, which has a wider blast radius.
    return Buffer.from(parseVaultSignature(signature as unknown as string)).toString('base64url');
  }

  /** Runs `fn` after every previously queued operation, whether or not it threw. */
  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function encodeSegment(segment: object): string {
  return Buffer.from(JSON.stringify(segment)).toString('base64url');
}

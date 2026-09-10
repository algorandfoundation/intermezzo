import { randomUUID } from 'crypto';
import { isUUID } from 'class-validator';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StatusList, createHeaderAndPayload } from '@sd-jwt/jwt-status-list';
import { AgentContext, SdJwtVcService } from '@credo-ts/core';

import { parseVaultSignature } from '../../../libs/credo-vault-wallet';
import { VaultService } from '../../vault/vault.service';
import { Oid4vcAgentProvider } from '../agent/oid4vc-agent.provider';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';
import { Oid4vcConfig } from '../oid4vc.config';
import { Oid4vcIssuanceSessionRepository } from '../sessions/vault-repository';
import {
  STATUS_LIST_SIZE,
  STATUS_REVOKED,
  STATUS_VALID,
  StatusListEntry,
  StatusListRecord,
} from '../entities/status-list.entity';
import { StatusListRepository } from './status-list.repository';

/** Shape of the one `SdJwtVcService` member Phase 4 replaces. */
type StatusListFetcherHost = {
  getStatusListFetcher(agentContext: AgentContext): (uri: string) => Promise<string>;
};

/** Attempts a conditional write gets before contention is reported as an error. */
const CAS_ATTEMPTS = 5;

/** A status list entry handed out at issuance time. */
export interface AllocatedStatusEntry extends StatusListEntry {
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

  /** A Vault read validates the status data before any cached signature is reused. */
  private readonly cachedJwt = new Map<string, { encodedList: string; jwt: string }>();

  // ponytail: one queue per process; use per-list queues only if measured contention warrants it.
  // Vault CAS, not this queue, protects writes across processes.
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
    return isUUID(listId, '4') ? listId : undefined;
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

  /** Allocate on the active UUID list, electing its successor with CAS when full. */
  async allocate(): Promise<AllocatedStatusEntry> {
    return this.serialise(async () => {
      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        const active = await this.repo.loadActive();
        if (!active.listId) {
          await this.repo.saveActive(randomUUID(), active.version);
          continue;
        }
        const { record, version } = await this.repo.load(active.listId);
        // The pointer is committed first. A restart between pointer election and
        // list creation resumes here; competing creators use CAS version zero.
        const target = record ?? this.emptyList(active.listId);
        if (target.nextIndex >= target.size) {
          await this.repo.saveActive(randomUUID(), active.version);
          continue;
        }
        const idx = target.nextIndex++;
        if (await this.repo.saveIfUnchanged(target, version)) {
          return { listId: target.id, idx, uri: this.config.statusListUri(target.id) };
        }
      }
      throw new ServiceUnavailableException('Status list allocation is under contention. Retry.');
    });
  }

  /** Persist the allocation before issuance; session CAS fences concurrent revocation. */
  async allocateForSession(credoIssuanceSessionId: string): Promise<AllocatedStatusEntry> {
    const session = await this.sessions.findOneBy({ credoIssuanceSessionId });
    if (!session) throw new NotFoundException(`No local issuance session for ${credoIssuanceSessionId}`);
    const entry = await this.allocate();
    await this.sessions.mutate(session.id, (current) => {
      if (current.statusChange?.pending || current.statusChange?.value === STATUS_REVOKED) {
        throw new ConflictException(`Issuance session ${session.id} is revoked or changing status`);
      }
      current.statusEntries = [...(current.statusEntries ?? []), { listId: entry.listId, idx: entry.idx }];
    });
    // Failed issuance may consume a slot. Never recycle it: a failed response
    // does not prove that nobody received the credential.
    return entry;
  }

  /**
   * Revokes the credential issued for `sessionId`. Verification fails for
   * everyone from the next status fetch onwards.
   */
  async revokeBySessionId(sessionId: string, reason?: string): Promise<AllocatedStatusEntry[]> {
    return this.setSessionStatus(sessionId, STATUS_REVOKED, reason);
  }

  /** Reverses {@link revokeBySessionId}, for a revocation made in error. */
  async reactivateBySessionId(sessionId: string): Promise<AllocatedStatusEntry[]> {
    return this.setSessionStatus(sessionId, STATUS_VALID);
  }

  /**
   * Returns the signed status list token served at
   * {@link Oid4vcConfig.statusListUri}.
   */
  async getStatusListJwt(listId: string): Promise<string> {
    return this.serialise(async () => {
      const record = await this.requireList(listId);
      const cached = this.cachedJwt.get(listId);
      if (cached?.encodedList === record.encodedList) return cached.jwt;

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
      // an expired list fails every credential that points at it. Adding one
      // requires scheduled token refresh even when no status bits change.
      // HTTP remains no-store; external token caching policy is documented.
      const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
      const jwt = `${signingInput}.${await this.sign(signingInput)}`;
      this.cachedJwt.set(listId, { encodedList: record.encodedList, jwt });
      return jwt;
    });
  }

  /** Reads one entry. Exposed for callers that need the bit, not the token. */
  async getStatus(listId: string, idx: number): Promise<number> {
    const record = await this.requireList(listId);
    return StatusList.decompressStatusList(record.encodedList, record.bits).getStatus(idx);
  }

  private async setSessionStatus(sessionId: string, value: 0 | 1, reason?: string): Promise<AllocatedStatusEntry[]> {
    const session = await this.sessions.mutate(sessionId, (current) => {
      if (!current.statusEntries?.length) {
        throw new NotFoundException(`Issuance session ${sessionId} has no status list entry`);
      }
      if (current.statusChange?.pending) {
        if (current.statusChange.value !== value) {
          throw new ConflictException(
            `Issuance session ${sessionId} has an unfinished status change; retry that operation first`,
          );
        }
        return; // Resume the durable intent, preserving its original reason and operation id.
      }
      current.statusChange = { id: randomUUID(), value, pending: true, requestedAt: new Date().toISOString(), reason };
    });
    const operation = session.statusChange!;
    const entries = session.statusEntries!;
    const byList = new Map<string, number[]>();
    for (const entry of entries) {
      if (!byList.has(entry.listId)) byList.set(entry.listId, []);
      byList.get(entry.listId)!.push(entry.idx);
    }
    for (const [listId, indices] of byList) {
      await this.serialise(() =>
        this.mutate(listId, async (record) => {
          // Read the LIST first, then the session intent, then CAS the list.
          // A newer operation either changes the intent before this check or
          // writes the list after our snapshot, causing our CAS to lose. Even
          // no-op bit updates must commit, to fence delayed workers from retries.
          const current = await this.sessions.findOneById(sessionId);
          if (current?.statusChange?.id !== operation.id) {
            throw new ConflictException(`Status change for session ${sessionId} was superseded`);
          }
          const list = StatusList.decompressStatusList(record.encodedList, record.bits);
          for (const idx of indices) {
            if (!Number.isSafeInteger(idx) || idx < 0 || idx >= record.nextIndex) {
              throw new NotFoundException(`Status list ${listId} has no allocated entry ${idx}`);
            }
            list.setStatus(idx, value);
          }
          record.encodedList = list.compressStatusList();
        }),
      );
    }
    await this.sessions.mutate(sessionId, (current) => {
      if (current.statusChange?.id !== operation.id) {
        throw new ConflictException(`Status change for session ${sessionId} was superseded`);
      }
      current.statusChange.pending = false;
      current.revokedAt = value === STATUS_REVOKED ? new Date(operation.requestedAt) : undefined;
      current.revokedReason = value === STATUS_REVOKED ? operation.reason : undefined;
    });
    return entries.map((entry) => ({ ...entry, uri: this.config.statusListUri(entry.listId) }));
  }

  /**
   * Read-modify-write of one list record under Vault's compare-and-set, so a
   * writer in another process loses the race and retries rather than
   * silently overwriting — which is what would otherwise hand the same index
   * to two credentials (draft-ietf-oauth-status-list §13.3 requires this) or
   * drop a revocation.
   *
   * `apply` mutates the record it is handed and may be run more than once,
   * so it must derive everything it returns from that record and have no
   * effect outside it.
   */
  private async mutate<T>(listId: string, apply: (record: StatusListRecord) => T | Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
      const { record, version } = await this.repo.load(listId);
      if (!record) {
        throw new NotFoundException(`Status list ${listId} does not exist`);
      }
      const result = await apply(record);
      if (await this.repo.saveIfUnchanged(record, version)) return result;
      this.logger.warn(`Status list ${listId} changed mid-write; retrying (attempt ${attempt}/${CAS_ATTEMPTS})`);
    }
    throw new ServiceUnavailableException(
      `Status list ${listId} is under contention: ${CAS_ATTEMPTS} compare-and-set attempts all lost. Retry.`,
    );
  }

  private async requireList(listId: string): Promise<StatusListRecord> {
    if (!isUUID(listId, '4')) throw new NotFoundException('Unknown status list');
    const { record } = await this.repo.load(listId);
    if (!record) throw new NotFoundException(`Status list ${listId} does not exist`);
    return record;
  }

  /** An unsaved, all-valid list. The first allocation persists it using CAS. */
  private emptyList(listId: string): StatusListRecord {
    this.logger.log(`Creating status list ${listId} with ${STATUS_LIST_SIZE} entries`);
    const empty = new StatusList(new Array(STATUS_LIST_SIZE).fill(STATUS_VALID), 1);
    return {
      id: listId,
      bits: 1,
      size: STATUS_LIST_SIZE,
      nextIndex: 0,
      encodedList: empty.compressStatusList(),
    } as StatusListRecord;
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

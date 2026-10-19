import { randomUUID } from 'crypto';
import { isUUID } from 'class-validator';
import {
  BadRequestException,
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
import { ChangeCredentialStatusDto } from '../dto/status-change.dto';
import { Oid4vcIssuanceSessionRepository } from '../sessions/vault-repository';
import { Oid4vcIssuanceSession, StatusChange, StatusSnapshot } from '../entities/oid4vc-issuance-session.entity';
import {
  STATUS_LIST_SIZE,
  STATUS_REVOKED,
  STATUS_VALID,
  StatusListEntry,
  StatusListRecord,
} from '../entities/status-list.entity';
import { HolderStatusRepository } from './holder-status.repository';
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
    private readonly holders: HolderStatusRepository,
    private readonly agentProvider: Oid4vcAgentProvider,
    private readonly vault: VaultService,
    private readonly tokenProvider: AlgoVaultTokenProvider,
  ) {}

  /**
   * Teaches the agent to resolve *our* status lists without an HTTP round
   * trip. See {@link installLocalStatusListFetcher}.
   *
   * Also starts the one-time holder index backfill in the background, so the
   * first holder revocation does not pay for it. Holder lookups wait on it
   * regardless, so a failure here only defers it.
   */
  async onModuleInit(): Promise<void> {
    if (!this.config.autoInit) return;
    this.sessions
      .ensureHolderIndex()
      .catch((err: Error) =>
        this.logger.warn(`Holder index backfill failed (${err.message}); the next holder lookup retries it.`),
      );
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
    // Before allocating, so a blocked redemption does not consume a slot. A
    // change written after this check reaches the session's intent below; see
    // setHolderStatus.
    const session = await this.assertIssuable(credoIssuanceSessionId);
    const entry = await this.allocate();
    await this.sessions.mutate(session.id, (current) => {
      if (blocksIssuance(current)) {
        throw new ConflictException(`Issuance session ${session.id} is revoked or changing status`);
      }
      current.statusEntries = [...(current.statusEntries ?? []), { listId: entry.listId, idx: entry.idx }];
    });
    // Failed issuance may consume a slot. Never recycle it: a failed response
    // does not prove that nobody received the credential.
    return entry;
  }

  /**
   * The local session for a redemption, refusing one its session or holder
   * blocks, allocating nothing. Credentials without a status entry, which
   * cannot be revoked once issued, rely on this alone: a redemption already
   * past it when a change lands still issues.
   */
  async assertIssuable(credoIssuanceSessionId: string): Promise<Oid4vcIssuanceSession> {
    const session = await this.sessions.findOneBy({ credoIssuanceSessionId });
    if (!session) throw new NotFoundException(`No local issuance session for ${credoIssuanceSessionId}`);
    if (blocksIssuance(session)) {
      throw new ConflictException(`Issuance session ${session.id} is revoked or changing status`);
    }
    if (session.holderDidKey && blocksIssuance(await this.holders.findByHolder(session.holderDidKey))) {
      throw new ConflictException(`Holder ${session.holderDidKey} is revoked or changing status`);
    }
    return session;
  }

  /** Revokes the sessions `target` names. Verification fails from the next status fetch onwards. */
  async revoke(target: ChangeCredentialStatusDto): Promise<AllocatedStatusEntry[]> {
    return this.setTargetStatus(target, STATUS_REVOKED, target.reason);
  }

  /** Reverses {@link revoke}, for a revocation made in error. */
  async reactivate(target: ChangeCredentialStatusDto): Promise<AllocatedStatusEntry[]> {
    return this.setTargetStatus(target, STATUS_VALID);
  }

  /** Changes the session `target` names, or every session of the holder it names. */
  private async setTargetStatus(
    target: ChangeCredentialStatusDto,
    value: 0 | 1,
    reason?: string,
  ): Promise<AllocatedStatusEntry[]> {
    const { sessionId, credoIssuanceSessionId, holderDidKey } = target;
    if ([sessionId, credoIssuanceSessionId, holderDidKey].filter(Boolean).length !== 1) {
      throw new BadRequestException('Provide exactly one of `sessionId`, `credoIssuanceSessionId` or `holderDidKey`');
    }
    if (holderDidKey) return this.setHolderStatus(holderDidKey, value, reason);
    return this.setSessionStatus(await this.localSessionId(target), value, reason);
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

  /** The local session id `target` names; everything downstream keys on it. */
  private async localSessionId({ sessionId, credoIssuanceSessionId }: ChangeCredentialStatusDto): Promise<string> {
    if (sessionId) return sessionId;
    const session = await this.sessions.findOneBy({ credoIssuanceSessionId });
    if (!session) throw new NotFoundException(`No issuance session for Credo session ${credoIssuanceSessionId}`);
    return session.id;
  }

  private async setSessionStatus(sessionId: string, value: 0 | 1, reason?: string): Promise<AllocatedStatusEntry[]> {
    // A committed holder change may still write the bits of the sessions it
    // claimed. It writes no others, and one that has not committed writes none.
    const before = await this.sessions.findOneById(sessionId);
    const holderDidKey = before?.holderDidKey;
    const holderChange = holderDidKey ? (await this.holders.findByHolder(holderDidKey))?.statusChange : undefined;
    if (holderChange?.pending && holderChange.committed && before?.statusChange?.id === holderChange.id) {
      throw new ConflictException(`Holder ${holderDidKey} has an unfinished status change; send that request again`);
    }
    const session = await this.sessions.mutate(sessionId, (current) => {
      // A holder change leaves its intent on offers that have issued nothing,
      // and those stay changeable by their own id.
      if (!current.statusEntries?.length && !current.statusChange) {
        throw new NotFoundException(`Issuance session ${sessionId} has no status list entry`);
      }
      // Resuming a holder-wide change here could move bits that change then
      // aborts without; only its own request may drive it.
      if (current.statusChange?.pending && current.statusChange.prior) {
        throw new ConflictException(
          `Issuance session ${sessionId} is part of an unfinished holder status change; send that request again`,
        );
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
    const entries = session.statusEntries ?? [];
    for (const [listId, indices] of groupByList(entries)) {
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
          flipBits(record, indices, value);
        }),
      );
    }
    await this.completeSessionChange(sessionId, operation);
    return entries.map((entry) => ({ ...entry, uri: this.config.statusListUri(entry.listId) }));
  }

  /**
   * Changes every session pinned to `holderDidKey` as one transaction,
   * coordinated through the holder's record.
   *
   * The holder record is written first. It fences issuance for every offer
   * the holder has, and is the durable log a re-sent request resumes. The
   * sessions are listed only after it, so a redemption that passed the fence
   * check just before it belongs to a session listed here, and that session's
   * intent CAS either blocks the allocation or returns its entry.
   *
   * Every intent stores what it replaced. Until the change is committed on
   * the holder record, nothing a verifier reads has changed, and a failure
   * aborts it: the holder and each claimed session go back to their stored
   * state. Commit and abort are both compare-and-set writes to the holder
   * record, so requests driving the same change concurrently can never do
   * both. After the commit, a failure leaves the change pending, still
   * fencing issuance, and re-sending the request finishes it. Each list's
   * bits flip in one write.
   */
  private async setHolderStatus(holderDidKey: string, value: 0 | 1, reason?: string): Promise<AllocatedStatusEntry[]> {
    // Checked before anything is written, so an unknown holder or a conflict
    // changes nothing. Intents a holder-wide change wrote are settled against
    // the holder record instead, below.
    const known = await this.sessions.findByHolder(holderDidKey);
    if (!known.length) throw new NotFoundException(`No issuance sessions for ${holderDidKey}`);
    const conflicting = known.find(({ statusChange: change }) => change?.pending && !change.prior);
    if (conflicting) {
      throw new ConflictException(
        `Issuance session ${conflicting.id} has an unfinished status change; retry that operation first`,
      );
    }

    const holder = await this.holders.mutate(holderDidKey, (current) => {
      if (current.statusChange?.pending) {
        if (current.statusChange.value !== value) {
          throw new ConflictException(
            `Holder ${holderDidKey} has an unfinished status change; retry that operation first`,
          );
        }
        return; // Resume the durable intent, preserving its original reason and operation id.
      }
      current.statusChange = {
        id: randomUUID(),
        value,
        pending: true,
        requestedAt: new Date().toISOString(),
        reason,
        prior: statusFields(current),
      };
    });
    const operation = holder.statusChange!;

    let claimed: Oid4vcIssuanceSession[];
    try {
      claimed = await this.claimHolderSessions(holderDidKey, operation);
    } catch (error) {
      if (!(await this.abortHolderChange(holderDidKey, operation))) {
        throw new ServiceUnavailableException(
          `Status change for holder ${holderDidKey} failed (${(error as Error).message}) and was not undone; ` +
            're-send the request to finish it',
        );
      }
      throw error;
    }
    let state = await this.commitHolderChange(holderDidKey, operation);
    if (state === 'aborted') {
      // A concurrent request aborted the change while this one was claiming.
      await this.releaseHolderSessions(holderDidKey, operation).catch((error: Error) =>
        this.logger.warn(`Could not release sessions of aborted holder change ${operation.id}: ${error.message}`),
      );
      throw new ConflictException(`Status change for holder ${holderDidKey} was aborted by another request; retry`);
    }

    // Committed: from here a failure leaves the change pending, for a re-send to finish.
    const entries = claimed.flatMap((session) => session.statusEntries ?? []);
    // If another request already finished the change, it has written these bits.
    const toFlip = state === 'committed' ? groupByList(entries) : new Map<string, number[]>();
    for (const [listId, indices] of toFlip) {
      const finished = await this.serialise(() =>
        this.mutate(listId, async (record) => {
          // As in setSessionStatus, but fenced on the holder: every claimed
          // session carries the same operation id, and only a committed,
          // unfinished change may move bits.
          const live = (await this.holders.findByHolder(holderDidKey))?.statusChange;
          if (live?.id !== operation.id || !live.committed) {
            throw new ConflictException(`Status change for holder ${holderDidKey} was superseded`);
          }
          // Finished by another request, which wrote these bits; a later
          // change may have moved them since.
          if (!live.pending) return true;
          flipBits(record, indices, value);
          return false;
        }),
      );
      if (finished) {
        state = 'finished';
        break;
      }
    }
    if (state === 'finished') {
      // The request that finished the change completed every session it
      // claimed, so intents of it still pending are late claims: undo them.
      await this.releaseHolderSessions(holderDidKey, operation);
    } else {
      await settle(claimed.map((session) => this.completeSessionChange(session.id, operation)));
      await this.holders.mutate(holderDidKey, (current) => {
        if (current.statusChange?.id !== operation.id) {
          throw new ConflictException(`Status change for holder ${holderDidKey} was superseded`);
        }
        completeChange(current, operation);
      });
    }
    return entries.map((entry) => ({ ...entry, uri: this.config.statusListUri(entry.listId) }));
  }

  /**
   * Writes `operation` as the pending intent of every session indexed under
   * the holder, including offers that have issued nothing, and returns them
   * as written. Each intent stores what it replaced, for an abort to restore.
   * Sessions revoked by `sessionId` are left as they are and not returned.
   */
  private async claimHolderSessions(holderDidKey: string, operation: StatusChange): Promise<Oid4vcIssuanceSession[]> {
    const ids = await this.sessions.holderSessionIds(holderDidKey);
    const claimed = await settle(
      ids.map(async (id) => {
        let skipped = false;
        try {
          const session = await this.sessions.mutate(id, async (current) => {
            skipped = false;
            if (current.statusChange?.id === operation.id) return; // Claimed already, by this request or a concurrent one.
            // Another holder change's pending intent is dead only while this
            // change is the live one. Read after the session, so a newer change
            // that claims it in between fails this attempt's CAS. A dead intent
            // gives way to the state it stored.
            if (current.statusChange?.pending && current.statusChange.prior) {
              const live = (await this.holders.findByHolder(holderDidKey))?.statusChange;
              if (live?.id !== operation.id || !live.pending) {
                throw new ConflictException(`Status change for holder ${holderDidKey} was superseded`);
              }
              restoreStatus(current, current.statusChange.prior);
            }
            // Changes made by sessionId are left alone: an unfinished one must
            // be finished first, and a revocation stays as it is.
            const change = current.statusChange;
            if (change?.pending) {
              throw new ConflictException(
                `Issuance session ${id} has an unfinished status change; retry that operation first`,
              );
            }
            if (change?.value === STATUS_REVOKED && !change.byHolder) {
              skipped = true;
              return;
            }
            const { id: opId, value, requestedAt, reason } = operation;
            const prior = statusFields(current);
            current.statusChange = { id: opId, value, pending: true, requestedAt, reason, byHolder: true, prior };
          });
          return skipped ? undefined : session;
        } catch (error) {
          // The index entry is written before its session, so the session may not exist yet.
          if (error instanceof NotFoundException) return undefined;
          throw error;
        }
      }),
    );
    return claimed.filter((session): session is Oid4vcIssuanceSession => session !== undefined);
  }

  /**
   * The point of no return: marks `operation` committed, so bits may move and
   * no request can abort it any more. Reports instead when another request
   * has already aborted or finished it.
   */
  private async commitHolderChange(
    holderDidKey: string,
    operation: StatusChange,
  ): Promise<'committed' | 'aborted' | 'finished'> {
    let state: 'committed' | 'aborted' | 'finished' = 'aborted';
    await this.holders.mutate(holderDidKey, (current) => {
      const change = current.statusChange;
      state = change?.id !== operation.id ? 'aborted' : change.pending ? 'committed' : 'finished';
      if (state === 'committed') change!.committed = true;
    });
    return state;
  }

  /**
   * Aborts `operation` unless it has been committed: restores the holder
   * record, then every session still holding the change as a pending intent,
   * each from the state its intent stored. Returns whether it is undone. A committed
   * change is left for a re-send to finish, and if the abort fails part-way,
   * the next change for this holder takes over the intents left behind.
   */
  private async abortHolderChange(holderDidKey: string, operation: StatusChange): Promise<boolean> {
    try {
      let aborted = false;
      await this.holders.mutate(holderDidKey, (current) => {
        const change = current.statusChange;
        aborted = change?.id !== operation.id || !change.committed;
        if (change?.id === operation.id && !change.committed) restoreStatus(current, change.prior);
      });
      if (aborted) await this.releaseHolderSessions(holderDidKey, operation);
      return aborted;
    } catch (error) {
      this.logger.warn(
        `Could not abort holder change ${operation.id} for ${holderDidKey}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Restores every session whose pending intent is `operation` to the state
   * that intent stored. A completed intent is left alone: intents complete
   * only after a commit, so it belongs to a change that finished.
   */
  private async releaseHolderSessions(holderDidKey: string, operation: StatusChange): Promise<void> {
    const ids = await this.sessions.holderSessionIds(holderDidKey);
    await settle(
      ids.map((id) =>
        this.sessions
          .mutate(id, (current) => {
            const change = current.statusChange;
            if (change?.id === operation.id && change.pending) restoreStatus(current, change.prior);
          })
          .catch((error) => {
            if (!(error instanceof NotFoundException)) throw error;
          }),
      ),
    );
  }

  private async completeSessionChange(sessionId: string, operation: StatusChange): Promise<void> {
    await this.sessions.mutate(sessionId, (current) => {
      if (current.statusChange?.id !== operation.id) {
        throw new ConflictException(`Status change for session ${sessionId} was superseded`);
      }
      completeChange(current, operation);
    });
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

/** A session or holder that is revoked, or mid-change, issues nothing. */
function blocksIssuance(record: StatusSnapshot | null | undefined): boolean {
  return Boolean(record?.statusChange?.pending || record?.statusChange?.value === STATUS_REVOKED);
}

function statusFields({ statusChange, revokedAt, revokedReason }: StatusSnapshot): StatusSnapshot {
  return { statusChange, revokedAt, revokedReason };
}

/** Puts back the fields a status change replaced. */
function restoreStatus(record: StatusSnapshot, prior: StatusSnapshot | undefined): void {
  record.statusChange = prior?.statusChange;
  record.revokedAt = prior?.revokedAt;
  record.revokedReason = prior?.revokedReason;
}

/** Marks `record`'s change finished, with the audit fields it implies. */
function completeChange(record: StatusSnapshot, operation: StatusChange): void {
  record.statusChange!.pending = false;
  record.statusChange!.prior = undefined;
  record.revokedAt = operation.value === STATUS_REVOKED ? new Date(operation.requestedAt) : undefined;
  record.revokedReason = operation.value === STATUS_REVOKED ? operation.reason : undefined;
}

function groupByList(entries: StatusListEntry[]): Map<string, number[]> {
  const byList = new Map<string, number[]>();
  for (const entry of entries) {
    if (!byList.has(entry.listId)) byList.set(entry.listId, []);
    byList.get(entry.listId)!.push(entry.idx);
  }
  return byList;
}

/** Sets `indices` to `value`, refusing any index the list never handed out. */
function flipBits(record: StatusListRecord, indices: number[], value: 0 | 1): void {
  const list = StatusList.decompressStatusList(record.encodedList, record.bits);
  for (const idx of indices) {
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= record.nextIndex) {
      throw new NotFoundException(`Status list ${record.id} has no allocated entry ${idx}`);
    }
    list.setStatus(idx, value);
  }
  record.encodedList = list.compressStatusList();
}

/** Waits for every write to settle, so none lands after the caller reacts, then throws the first failure. */
async function settle<T>(writes: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(writes);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

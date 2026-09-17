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
import { Oid4vcIssuanceSession } from '../entities/oid4vc-issuance-session.entity';
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
 * How the manager addresses the credential(s) to revoke or reactivate. Exactly
 * one form is set: `holderDidKey` (optionally narrowed by
 * `credentialConfigurationId`), or `uri` *and* `idx` together.
 */
export interface StatusTarget {
  holderDidKey?: string;
  credentialConfigurationId?: string;
  uri?: string;
  idx?: number;
  reason?: string;
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
  async allocateForSession(
    credoIssuanceSessionId: string,
    credentialConfigurationId?: string,
  ): Promise<AllocatedStatusEntry> {
    const session = await this.sessions.findOneBy({ credoIssuanceSessionId });
    if (!session) throw new NotFoundException(`No local issuance session for ${credoIssuanceSessionId}`);
    const entry = await this.allocate();
    // Written before the session append so a `uri`+`idx` resolves back to this session even if the process
    // crashes between the two writes; the entry is simply not yet revocable in that narrow window.
    await this.repo.saveEntryOwner(entry.listId, entry.idx, session.id);
    await this.sessions.mutate(session.id, (current) => {
      if (current.statusChange?.pending || current.statusChange?.value === STATUS_REVOKED) {
        throw new ConflictException(`Issuance session ${session.id} is revoked or changing status`);
      }
      current.statusEntries = [
        ...(current.statusEntries ?? []),
        { listId: entry.listId, idx: entry.idx, credentialConfigurationId },
      ];
    });
    // Failed issuance may consume a slot. Never recycle it: a failed response
    // does not prove that nobody received the credential.
    return entry;
  }

  /**
   * Revokes exactly the credentials `target`'s addressing form matches: every
   * credential issued to a holder `did:key` (optionally narrowed to one
   * configuration), or the single credential a `uri`+`idx` was allocated to.
   * Verification fails for everyone from the next status fetch onwards.
   */
  async revoke(target: StatusTarget): Promise<AllocatedStatusEntry[]> {
    return this.setStatusForTarget(target, STATUS_REVOKED, target.reason);
  }

  /** Reverses {@link revoke}, for a revocation made in error. */
  async reactivate(target: StatusTarget): Promise<AllocatedStatusEntry[]> {
    return this.setStatusForTarget(target, STATUS_VALID);
  }

  private async setStatusForTarget(
    target: StatusTarget,
    value: 0 | 1,
    reason?: string,
  ): Promise<AllocatedStatusEntry[]> {
    const selections = await this.resolveTargets(target);
    const results: AllocatedStatusEntry[] = [];
    for (const { sessionId, entries } of selections) {
      results.push(...(await this.setSessionStatus(sessionId, value, reason, entries)));
    }
    return results;
  }

  /**
   * Resolves an addressing form to the exact entries it names, grouped by the
   * session that owns them.
   *
   * The entries are pinned here rather than re-read inside
   * {@link setSessionStatus}, so a credential issued between resolution and
   * the bit flip is not swept into an operation that never addressed it.
   */
  private async resolveTargets(target: StatusTarget): Promise<{ sessionId: string; entries: StatusListEntry[] }[]> {
    const addressesEntry = target.uri !== undefined || target.idx !== undefined;
    if (addressesEntry && target.holderDidKey !== undefined) {
      throw new BadRequestException('Provide either `holderDidKey` or `uri`+`idx`, not both');
    }

    if (addressesEntry) {
      // Both halves are required: an `idx` alone used to fall through to the
      // holder form, silently widening a single-credential request.
      if (target.uri === undefined) throw new BadRequestException('`uri` is required with `idx`');
      if (target.idx === undefined) throw new BadRequestException('`idx` is required with `uri`');
      const listId = this.localStatusListId(target.uri);
      if (!listId) throw new NotFoundException(`Status list URI ${target.uri} is not served by this issuer`);
      const owner = await this.repo.loadEntryOwner(listId, target.idx);
      if (!owner) throw new NotFoundException(`Status list ${listId} has no allocated entry ${target.idx}`);
      return [{ sessionId: owner.sessionId, entries: [{ listId, idx: target.idx }] }];
    }

    if (target.holderDidKey !== undefined) {
      const sessions = await this.sessions.findByHolder(target.holderDidKey);
      const selections = sessions
        .map((session) => ({ sessionId: session.id, entries: selectEntries(session, target) }))
        .filter((selection) => selection.entries.length > 0);
      if (!selections.length) throw new NotFoundException(`No credentials issued to ${target.holderDidKey}`);
      return selections;
    }

    throw new BadRequestException('Provide either `holderDidKey` or `uri`+`idx`');
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

  /**
   * Flips `selected` (default: every entry on the session) to `value`.
   *
   * The selection is part of the durable intent, so an operation resumed after
   * a crash replays the entries it originally addressed instead of widening to
   * whatever the session holds by then.
   */
  private async setSessionStatus(
    sessionId: string,
    value: 0 | 1,
    reason?: string,
    selected?: StatusListEntry[],
  ): Promise<AllocatedStatusEntry[]> {
    const session = await this.sessions.mutate(sessionId, (current) => {
      if (!current.statusEntries?.length) {
        throw new NotFoundException(`Issuance session ${sessionId} has no status list entry`);
      }
      // Resolution and this mutate are separate reads, and `uri`+`idx` resolves
      // through the entry-owner index — which is written before the session
      // append. Confirm the session really carries what we are about to flip.
      const entries = (selected ?? current.statusEntries).map((entry) => {
        const owned = current.statusEntries!.find((e) => e.listId === entry.listId && e.idx === entry.idx);
        if (!owned) {
          throw new NotFoundException(
            `Issuance session ${sessionId} has no entry ${entry.idx} on list ${entry.listId}`,
          );
        }
        return owned;
      });
      if (current.statusChange?.pending) {
        const pending = current.statusChange.entries ?? current.statusEntries;
        if (current.statusChange.value !== value || !coversSameEntries(pending, entries)) {
          throw new ConflictException(
            `Issuance session ${sessionId} has an unfinished status change; retry that operation first`,
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
        entries,
      };
    });
    const operation = session.statusChange!;
    const entries = operation.entries ?? session.statusEntries!;
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
      // Session-level only when the operation covered the whole session. A
      // narrowed revocation leaves the session's other credentials valid, and
      // stamping it revoked would misreport them.
      const whole = entries.length === (current.statusEntries?.length ?? 0);
      if (whole) {
        current.revokedAt = value === STATUS_REVOKED ? new Date(operation.requestedAt) : undefined;
        current.revokedReason = value === STATUS_REVOKED ? operation.reason : undefined;
      } else if (value === STATUS_VALID) {
        // A partial reactivation still clears a whole-session revocation stamp:
        // the session no longer has every credential revoked.
        current.revokedAt = undefined;
        current.revokedReason = undefined;
      }
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

/**
 * The entries of `session` a holder-form target addresses.
 *
 * Without `credentialConfigurationId` that is every entry. With one, the filter
 * has to hold per *entry*, not per session: one session can issue several
 * configurations, and matching at session level would flip the bits of the
 * configurations the caller did not name.
 */
function selectEntries(session: Oid4vcIssuanceSession, target: StatusTarget): StatusListEntry[] {
  const entries = session.statusEntries ?? [];
  const wanted = target.credentialConfigurationId;
  if (wanted === undefined) return entries;
  const offered = session.offeredCredentialConfigurationIds ?? [];
  return entries.filter((entry) => {
    if (entry.credentialConfigurationId !== undefined) return entry.credentialConfigurationId === wanted;
    // Allocated before the configuration id was recorded. A single-configuration
    // offer still pins it; anything else cannot be narrowed without guessing
    // which sibling would be revoked along with it.
    if (offered.length === 1) return offered[0] === wanted;
    if (!offered.includes(wanted)) return false;
    throw new ConflictException(
      `Issuance session ${session.id} predates per-credential configuration ids and offered ` +
        `${offered.length} configurations; revoke it by \`uri\`+\`idx\`, or without ` +
        '`credentialConfigurationId` to cover all of them.',
    );
  });
}

/** Whether a pending operation addresses exactly the entries a retry asks for. */
function coversSameEntries(a: StatusListEntry[], b: StatusListEntry[]): boolean {
  const key = (entries: StatusListEntry[]) =>
    entries
      .map((entry) => `${entry.listId}:${entry.idx}`)
      .sort()
      .join(',');
  return key(a) === key(b);
}

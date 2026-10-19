import * as crypto from 'crypto';
import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getListFromStatusListJWT } from '@sd-jwt/jwt-status-list';
import { AgentContext } from '@credo-ts/core';

import { Oid4vcAgentProvider } from '../agent/oid4vc-agent.provider';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';
import { Oid4vcConfig } from '../oid4vc.config';
import { VaultCasConflictError, VaultService } from '../../vault/vault.service';
import { Oid4vcIssuanceSessionRepository } from '../sessions/vault-repository';
import { Oid4vcSessionMirrorService } from '../sessions/oid4vc-session-mirror.service';
import { STATUS_LIST_SIZE, StatusListRecord } from '../entities/status-list.entity';
import { HolderStatusRepository } from './holder-status.repository';
import { StatusListRepository } from './status-list.repository';
import { AllocatedStatusEntry, Oid4vcStatusService } from './oid4vc-status.service';

const ISSUER_DID = 'did:algo:testnet:app:1:' + 'aa'.repeat(32);
const LIST_BASE = 'http://localhost:3000/v1/credential/status/list';
const LIST_FOLDER = 'intermezzo/oid4vc/status-lists';
const SESSION_FOLDER = 'intermezzo/oid4vc/sessions/issuance';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Oid4vcStatusService', () => {
  let service: Oid4vcStatusService;
  let lists: StatusListRepository;
  let sessions: Oid4vcIssuanceSessionRepository;
  let holders: HolderStatusRepository;
  let sign: jest.Mock;
  let publicKey: crypto.KeyObject;
  let vault: VaultService;
  let kv: Map<string, { data: any; version: number }>;
  const tokenProvider = { getToken: async () => 'vault-token' } as unknown as AlgoVaultTokenProvider;

  function makeService(opts: { agent?: unknown; agentError?: Error; autoInit?: boolean } = {}) {
    return new Oid4vcStatusService(
      new Oid4vcConfig({
        get: <T>(key: string, fallback?: T) =>
          key === 'OID4VC_AUTO_INIT' && opts.autoInit === false ? ('false' as unknown as T) : fallback,
      } as unknown as ConfigService),
      lists,
      sessions,
      holders,
      {
        ensureIssuerDid: async () => ({ did: ISSUER_DID, verificationMethodId: `${ISSUER_DID}#keys-1` }),
        getAgent: async () => {
          if (opts.agentError) throw opts.agentError;
          return opts.agent;
        },
      } as unknown as Oid4vcAgentProvider,
      vault,
      tokenProvider,
    );
  }

  beforeEach(() => {
    const keys = crypto.generateKeyPairSync('ed25519');
    publicKey = keys.publicKey;
    sign = jest.fn(
      async (_key: string, _path: string, data: Uint8Array) =>
        `vault:v1:${crypto.sign(null, Buffer.from(data), keys.privateKey).toString('base64')}`,
    );
    kv = new Map();
    const copy = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    vault = {
      kvRead: async (path: string) => copy(kv.get(path)?.data),
      kvReadVersioned: async (path: string) => ({
        data: copy(kv.get(path)?.data),
        version: kv.get(path)?.version ?? 0,
      }),
      kvWrite: async (path: string, data: unknown, _token: string, cas?: number) => {
        const version = kv.get(path)?.version ?? 0;
        if (cas !== undefined && cas !== version) throw new VaultCasConflictError(path);
        kv.set(path, { data: copy(data), version: version + 1 });
      },
      // Mirrors Vault's KV-v2 LIST: immediate child names under `path/`, no recursion.
      kvList: async (path: string) => {
        const prefix = `${path}/`;
        const children = new Set<string>();
        for (const key of kv.keys()) {
          if (key.startsWith(prefix)) children.add(key.slice(prefix.length).split('/')[0]);
        }
        return [...children];
      },
      sign,
    } as unknown as VaultService;
    lists = new StatusListRepository(vault, tokenProvider);
    sessions = new Oid4vcIssuanceSessionRepository(vault, tokenProvider);
    holders = new HolderStatusRepository(vault, tokenProvider);
    service = makeService();
  });

  async function issue(id = 'session-a', svc = service) {
    if (!(await sessions.findOneById(id))) await sessions.save({ id, credoIssuanceSessionId: id });
    return svc.allocateForSession(id);
  }

  function storedList(id: string): StatusListRecord {
    return kv.get(`${LIST_FOLDER}/records/${id}`)!.data;
  }

  it('creates UUID lists and hands out consecutive indices', async () => {
    const first = await service.allocate();
    expect(first).toEqual({
      listId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      idx: 0,
      uri: `${LIST_BASE}/${first.listId}`,
    });
    expect(await service.allocate()).toEqual({ ...first, idx: 1 });
    expect(storedList(first.listId)).toMatchObject({ bits: 1, size: STATUS_LIST_SIZE, nextIndex: 2 });
    expect(service.localStatusListId(first.uri)).toBe(first.listId);
  });

  it('allocates distinct indices for concurrent requests in one process', async () => {
    const entries = await Promise.all(Array.from({ length: 25 }, () => service.allocate()));
    expect(entries.map((e) => e.idx)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('elects one first list across instances', async () => {
    const entries = await Promise.all([service.allocate(), makeService().allocate()]);
    expect(new Set(entries.map((e) => e.listId)).size).toBe(1);
    expect(entries.map((e) => e.idx).sort()).toEqual([0, 1]);
  });

  it('rolls over across competing instances and retains old lists', async () => {
    const first = await issue();
    storedList(first.listId).nextIndex = STATUS_LIST_SIZE - 1;
    const entries = await Promise.all([service.allocate(), makeService().allocate()]);
    expect(entries.some((e) => e.listId === first.listId && e.idx === STATUS_LIST_SIZE - 1)).toBe(true);
    const successor = entries.find((e) => e.listId !== first.listId)!;
    expect(successor.idx).toBe(0);
    expect(await makeService().allocate()).toEqual({ ...successor, idx: 1 });
    await service.revokeBySessionId('session-a');
    expect(getListFromStatusListJWT(await service.getStatusListJwt(first.listId)).getStatus(first.idx)).toBe(1);
    expect(getListFromStatusListJWT(await service.getStatusListJwt(successor.listId)).getStatus(0)).toBe(0);
  });

  it('elects one successor when both instances encounter a full list', async () => {
    const first = await service.allocate();
    storedList(first.listId).nextIndex = STATUS_LIST_SIZE;
    const entries = await Promise.all([service.allocate(), makeService().allocate()]);
    expect(new Set(entries.map((e) => e.listId)).size).toBe(1);
    expect(entries[0].listId).not.toBe(first.listId);
    expect(entries.map((e) => e.idx).sort()).toEqual([0, 1]);
  });

  it.each([false, true])('recovers after pointer election and before list creation (rollover=%s)', async (rollover) => {
    if (rollover) {
      const first = await service.allocate();
      storedList(first.listId).nextIndex = STATUS_LIST_SIZE;
    }
    jest.spyOn(lists, 'saveIfUnchanged').mockRejectedValueOnce(new Error('process died'));
    await expect(service.allocate()).rejects.toThrow('process died');
    const active = await lists.loadActive();
    expect((await lists.load(active.listId!)).record).toBeNull();
    expect(await makeService().allocate()).toMatchObject({ listId: active.listId, idx: 0 });
  });

  it('does not recycle an allocation when the commit response is lost', async () => {
    const save = lists.saveIfUnchanged.bind(lists);
    jest.spyOn(lists, 'saveIfUnchanged').mockImplementationOnce(async (record, version) => {
      await save(record, version);
      throw new Error('response lost');
    });
    await expect(service.allocate()).rejects.toThrow('response lost');
    expect((await makeService().allocate()).idx).toBe(1);
  });

  it('propagates pointer write failures without creating an unreachable list', async () => {
    jest.spyOn(vault, 'kvWrite').mockRejectedValueOnce(new Error('Vault down'));
    await expect(service.allocate()).rejects.toThrow('Vault down');
    expect(kv.size).toBe(0);
    await expect(service.allocate()).resolves.toMatchObject({ idx: 0 });
  });

  it('returns 503 without overwriting when CAS retries are exhausted', async () => {
    const first = await service.allocate();
    jest.spyOn(lists, 'saveIfUnchanged').mockResolvedValue(false);
    await expect(service.allocate()).rejects.toThrow(ServiceUnavailableException);
    expect(storedList(first.listId).nextIndex).toBe(1);
  });

  it('persists all concurrent session appends using the real repository', async () => {
    await sessions.save({ id: 'session-a', credoIssuanceSessionId: 'session-a' });
    const entries = await Promise.all([issue(), issue('session-a', makeService())]);
    const session = await sessions.findOneById('session-a');
    expect(session!.statusEntries).toHaveLength(2);
    expect(new Set(session!.statusEntries!.map((e) => `${e.listId}/${e.idx}`)).size).toBe(2);
    await service.revokeBySessionId('session-a');
    for (const entry of entries) expect(await service.getStatus(entry.listId, entry.idx)).toBe(1);
  });

  it('aborts issuance on missing sessions, failed writes and session CAS exhaustion', async () => {
    await expect(service.allocateForSession('missing')).rejects.toThrow(NotFoundException);
    await sessions.save({ id: 'session-a', credoIssuanceSessionId: 'session-a' });
    const save = jest.spyOn(sessions, 'saveIfUnchanged').mockRejectedValueOnce(new Error('Vault down'));
    await expect(issue()).rejects.toThrow('Vault down');
    save.mockResolvedValue(false);
    await expect(issue()).rejects.toThrow(ServiceUnavailableException);
    expect((await sessions.findOneById('session-a'))!.statusEntries).toBeUndefined();
  });

  it('revokes entries across rollover, leaves neighbours valid, and reactivates with audit fields', async () => {
    const first = await issue();
    const other = await issue('session-b');
    storedList(first.listId).nextIndex = STATUS_LIST_SIZE;
    const second = await issue();
    const revoked = await service.revokeBySessionId('session-a', 'stolen');
    expect(revoked).toEqual([first, second]);
    for (const e of [first, second]) expect(await service.getStatus(e.listId, e.idx)).toBe(1);
    expect(await service.getStatus(other.listId, other.idx)).toBe(0);
    expect(await sessions.findOneById('session-a')).toMatchObject({
      revokedReason: 'stolen',
      revokedAt: expect.any(String),
      statusChange: { pending: false, value: 1 },
    });
    await expect(issue()).rejects.toThrow(ConflictException);
    await service.reactivateBySessionId('session-a');
    for (const e of [first, second]) expect(await service.getStatus(e.listId, e.idx)).toBe(0);
    expect((await sessions.findOneById('session-a'))!.revokedAt).toBeUndefined();
    expect((await sessions.findOneById('session-a'))!.revokedReason).toBeUndefined();
    await expect(issue()).resolves.toBeDefined();
  });

  it('refuses a blocked session before spending a slot on it', async () => {
    const entry = await issue();
    const { nextIndex } = storedList(entry.listId);
    await service.revokeBySessionId('session-a');
    await expect(issue()).rejects.toThrow(ConflictException);
    jest.spyOn(lists, 'saveIfUnchanged').mockRejectedValueOnce(new Error('Vault down'));
    await expect(service.reactivateBySessionId('session-a')).rejects.toThrow('Vault down'); // left pending
    await expect(issue()).rejects.toThrow(ConflictException);
    expect(storedList(entry.listId).nextIndex).toBe(nextIndex);
  });

  it('preserves both revocations when two sessions share a list', async () => {
    const first = await issue('session-a');
    const second = await issue('session-b');
    await Promise.all([service.revokeBySessionId('session-a'), makeService().revokeBySessionId('session-b')]);
    expect(await service.getStatus(first.listId, first.idx)).toBe(1);
    expect(await service.getStatus(second.listId, second.idx)).toBe(1);
  });

  it.each([-1, 0.5, 1])('refuses to change an invalid or unallocated session index %s', async (idx) => {
    const entry = await issue();
    await sessions.mutate('session-a', (current) => {
      current.statusEntries = [{ listId: entry.listId, idx }];
    });
    await expect(service.revokeBySessionId('session-a')).rejects.toThrow(NotFoundException);
    expect(await service.getStatus(entry.listId, entry.idx)).toBe(0);
  });

  it('retains pending intent when a referenced list is missing or its CAS retries are exhausted', async () => {
    const entry = await issue();
    const spy = jest.spyOn(lists, 'load').mockResolvedValueOnce({ record: null, version: 0 });
    await expect(service.revokeBySessionId('session-a')).rejects.toThrow(NotFoundException);
    spy.mockRestore();
    const save = jest.spyOn(lists, 'saveIfUnchanged').mockResolvedValue(false);
    await expect(service.revokeBySessionId('session-a')).rejects.toThrow(ServiceUnavailableException);
    expect(await service.getStatus(entry.listId, entry.idx)).toBe(0);
    expect((await sessions.findOneById('session-a'))!.statusChange!.pending).toBe(true);
    save.mockRestore();
    await makeService().revokeBySessionId('session-a');
    expect(await service.getStatus(entry.listId, entry.idx)).toBe(1);
  });

  it('addresses a session by exactly one of its local or Credo id', async () => {
    await sessions.save({ id: 'local-a', credoIssuanceSessionId: 'credo-a' });
    const entry = await service.allocateForSession('credo-a');
    expect(await service.revoke({ credoIssuanceSessionId: 'credo-a', reason: 'stolen' })).toEqual([entry]);
    expect(await service.getStatus(entry.listId, entry.idx)).toBe(1);
    expect((await sessions.findOneById('local-a'))!.revokedReason).toBe('stolen');
    await service.reactivate({ sessionId: 'local-a' });
    expect(await service.getStatus(entry.listId, entry.idx)).toBe(0);
    await expect(service.revoke({})).rejects.toThrow(BadRequestException);
    await expect(service.revoke({ sessionId: 'local-a', credoIssuanceSessionId: 'credo-a' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.revoke({ credoIssuanceSessionId: 'missing' })).rejects.toThrow(NotFoundException);
  });

  describe('by holder', () => {
    const HOLDER = 'did:key:zH';

    // The one-time backfill writes too; get it out of the way of "writes nothing" assertions.
    beforeEach(() => sessions.ensureHolderIndex());

    /** Creates an offer pinned to `holderDidKey`, indexed the way `createOffer` indexes it. */
    async function offer(id: string, holderDidKey = HOLDER) {
      await sessions.save({ id, credoIssuanceSessionId: id, holderDidKey });
      await sessions.indexHolder(holderDidKey, id);
    }

    /** The fields a status change writes and an abort restores. */
    async function audit(id: string) {
      const { statusChange, revokedAt, revokedReason } = (await sessions.findOneById(id))!;
      return { statusChange, revokedAt, revokedReason };
    }

    function listWrites(write: jest.SpyInstance) {
      return write.mock.calls.filter(([path]) => String(path).startsWith(`${LIST_FOLDER}/records/`));
    }

    it('revokes and reactivates every session pinned to a holder, fencing all of its offers', async () => {
      for (const id of ['h-1', 'h-2', 'h-open']) await offer(id);
      await offer('b-1', 'did:key:zB');
      const h1 = await service.allocateForSession('h-1');
      storedList(h1.listId).nextIndex = STATUS_LIST_SIZE; // h-2's entry lands on a second list
      const h2 = await service.allocateForSession('h-2');
      const b1 = await service.allocateForSession('b-1');
      const bits = () => Promise.all([h1, h2, b1].map((e) => service.getStatus(e.listId, e.idx)));

      expect(await service.revoke({ holderDidKey: HOLDER, reason: 'stolen' })).toHaveLength(2);
      expect(await bits()).toEqual([1, 1, 0]);
      expect(await holders.findByHolder(HOLDER)).toMatchObject({
        revokedReason: 'stolen',
        statusChange: { value: 1, pending: false },
      });

      // The holder record fences every offer, including one created after the
      // revocation, before a slot is spent.
      await offer('h-late');
      const nextIndex = storedList(h2.listId).nextIndex;
      await expect(service.allocateForSession('h-open')).rejects.toThrow(ConflictException);
      await expect(service.allocateForSession('h-late')).rejects.toThrow(ConflictException);
      expect(storedList(h2.listId).nextIndex).toBe(nextIndex);

      // Reactivating one offer by its own id does not lift the holder's fence.
      await service.reactivate({ sessionId: 'h-open' });
      await expect(service.allocateForSession('h-open')).rejects.toThrow(ConflictException);

      await service.reactivate({ holderDidKey: HOLDER });
      expect(await bits()).toEqual([0, 0, 0]);
      await expect(service.allocateForSession('h-open')).resolves.toBeDefined();
      await expect(service.allocateForSession('h-late')).resolves.toBeDefined();

      await expect(service.revoke({ sessionId: 'h-1', holderDidKey: HOLDER })).rejects.toThrow(BadRequestException);
    });

    it('refuses a redemption without a status entry while its session or holder blocks it', async () => {
      await expect(service.assertIssuable('missing')).rejects.toThrow(NotFoundException);
      for (const id of ['h-1', 'h-2']) await offer(id);
      const entry = await service.allocateForSession('h-1');
      const { nextIndex } = storedList(entry.listId);
      const write = jest.spyOn(vault, 'kvWrite');
      await expect(service.assertIssuable('h-1')).resolves.toBeDefined();
      expect(write).not.toHaveBeenCalled();

      await service.revoke({ sessionId: 'h-1' });
      await expect(service.assertIssuable('h-1')).rejects.toThrow(ConflictException);
      await expect(service.assertIssuable('h-2')).resolves.toBeDefined();
      await service.reactivate({ sessionId: 'h-1' });
      await expect(service.assertIssuable('h-1')).resolves.toBeDefined();

      // The holder record also fences an offer created after the revocation.
      await service.revoke({ holderDidKey: HOLDER });
      await offer('h-late');
      for (const id of ['h-1', 'h-2', 'h-late']) {
        await expect(service.assertIssuable(id)).rejects.toThrow(ConflictException);
      }
      await service.reactivate({ holderDidKey: HOLDER });
      for (const id of ['h-1', 'h-2', 'h-late']) await expect(service.assertIssuable(id)).resolves.toBeDefined();

      expect(storedList(entry.listId).nextIndex).toBe(nextIndex);
    });

    it('rejects an unknown holder without writing anything', async () => {
      const write = jest.spyOn(vault, 'kvWrite');
      await expect(service.revoke({ holderDidKey: 'did:key:zUnknown' })).rejects.toThrow(NotFoundException);
      expect(write).not.toHaveBeenCalled();
    });

    it("flips all of a holder's bits on one list in a single write", async () => {
      for (const id of ['h-1', 'h-2']) await offer(id);
      const entries = [await service.allocateForSession('h-1'), await service.allocateForSession('h-2')];
      const write = jest.spyOn(vault, 'kvWrite');
      await service.revoke({ holderDidKey: HOLDER });
      expect(listWrites(write)).toHaveLength(1);
      for (const e of entries) expect(await service.getStatus(e.listId, e.idx)).toBe(1);
    });

    it('refuses a change while a sessionId change is unfinished, writing nothing', async () => {
      for (const id of ['h-1', 'h-2']) await offer(id);
      await service.allocateForSession('h-1');
      await service.allocateForSession('h-2');
      jest.spyOn(lists, 'saveIfUnchanged').mockRejectedValueOnce(new Error('Vault down'));
      await expect(service.revokeBySessionId('h-2')).rejects.toThrow('Vault down'); // left pending
      const write = jest.spyOn(vault, 'kvWrite');
      await expect(service.reactivate({ holderDidKey: HOLDER })).rejects.toThrow(ConflictException);
      await expect(service.revoke({ holderDidKey: HOLDER })).rejects.toThrow(ConflictException);
      expect(write).not.toHaveBeenCalled();
    });

    it('leaves a revocation made by sessionId alone, in both directions', async () => {
      for (const id of ['h-1', 'h-2']) await offer(id);
      const leaked = await service.allocateForSession('h-1');
      const other = await service.allocateForSession('h-2');
      await service.revoke({ sessionId: 'h-1', reason: 'leaked' });
      const individual = await audit('h-1');
      const bits = () => Promise.all([leaked, other].map((e) => service.getStatus(e.listId, e.idx)));

      // The holder revoke changes only h-2, and keeps h-1's own reason and time.
      expect(await service.revoke({ holderDidKey: HOLDER, reason: 'stolen' })).toEqual([
        expect.objectContaining({ listId: other.listId, idx: other.idx }),
      ]);
      expect(await audit('h-1')).toEqual(individual);
      // The holder reactivate re-enables only what the holder revoke revoked.
      await service.reactivate({ holderDidKey: HOLDER });
      expect(await bits()).toEqual([1, 0]);
      expect(await audit('h-1')).toEqual(individual);
    });

    it('treats a sessionId revoke made after a holder revoke as individual', async () => {
      await offer('h-1');
      const entry = await service.allocateForSession('h-1');
      await service.revoke({ holderDidKey: HOLDER });
      await service.revoke({ sessionId: 'h-1', reason: 'leaked' });
      await service.reactivate({ holderDidKey: HOLDER });

      expect(await service.getStatus(entry.listId, entry.idx)).toBe(1);
      expect(await audit('h-1')).toMatchObject({ revokedReason: 'leaked', statusChange: { value: 1 } });
    });

    it('restores every session and the holder when an intent write fails, before any bit moves', async () => {
      for (const id of ['h-1', 'h-2', 'h-open']) await offer(id);
      const entries = [await service.allocateForSession('h-1'), await service.allocateForSession('h-2')];
      await service.revoke({ sessionId: 'h-1', reason: 'old' });
      const ids = ['h-1', 'h-2', 'h-open'];
      const before = await Promise.all(ids.map(audit));

      const save = sessions.saveIfUnchanged.bind(sessions);
      const intents = jest.spyOn(sessions, 'saveIfUnchanged').mockImplementation(async (record, version) => {
        if (record.id === 'h-2' && record.statusChange?.pending) throw new Error('Vault down');
        return save(record, version);
      });
      const write = jest.spyOn(vault, 'kvWrite');
      await expect(service.revoke({ holderDidKey: HOLDER, reason: 'stolen' })).rejects.toThrow('Vault down');
      intents.mockRestore();

      expect(listWrites(write)).toHaveLength(0);
      expect(await Promise.all(ids.map(audit))).toEqual(before);
      expect((await holders.findByHolder(HOLDER))!.statusChange).toBeUndefined();
      expect(await Promise.all(entries.map((e) => service.getStatus(e.listId, e.idx)))).toEqual([1, 0]);
      await expect(service.allocateForSession('h-open')).resolves.toBeDefined();
    });

    it('leaves the change pending once the bits are being written, and finishes it on re-send', async () => {
      for (const id of ['h-1', 'h-open']) await offer(id);
      const entry = await service.allocateForSession('h-1');
      jest.spyOn(lists, 'saveIfUnchanged').mockRejectedValueOnce(new Error('Vault down'));
      await expect(service.revoke({ holderDidKey: HOLDER, reason: 'stolen' })).rejects.toThrow('Vault down');

      expect((await holders.findByHolder(HOLDER))!.statusChange).toMatchObject({ value: 1, pending: true });
      await expect(service.allocateForSession('h-open')).rejects.toThrow(ConflictException);
      await expect(makeService().reactivate({ holderDidKey: HOLDER })).rejects.toThrow(ConflictException);

      await makeService().revoke({ holderDidKey: HOLDER, reason: 'replacement' });
      expect(await service.getStatus(entry.listId, entry.idx)).toBe(1);
      for (const record of [await holders.findByHolder(HOLDER), ...(await sessions.findByHolder(HOLDER))]) {
        expect(record).toMatchObject({ statusChange: { pending: false }, revokedReason: 'stolen' });
      }
    });

    it('revokes a credential whose redemption passed the holder check just before the fence', async () => {
      await offer('h-1');
      let raced!: AllocatedStatusEntry;
      const save = holders.saveIfUnchanged.bind(holders);
      jest.spyOn(holders, 'saveIfUnchanged').mockImplementationOnce(async (record, version) => {
        raced = await makeService().allocateForSession('h-1');
        return save(record, version);
      });
      await service.revoke({ holderDidKey: HOLDER });
      expect(await service.getStatus(raced.listId, raced.idx)).toBe(1);
    });

    const tick = () => new Promise((resolve) => setImmediate(resolve));

    it('never aborts a change that a concurrent request has committed', async () => {
      for (const id of ['h-1', 'h-2']) await offer(id);
      const entry = await service.allocateForSession('h-1');
      // The first request stalls claiming h-2 and then fails, after a second
      // request has resumed the same change and finished it.
      const stalled = deferred();
      const save = sessions.saveIfUnchanged.bind(sessions);
      let h2Claims = 0;
      jest.spyOn(sessions, 'saveIfUnchanged').mockImplementation(async (record, version) => {
        if (record.id === 'h-2' && record.statusChange?.pending && h2Claims++ === 0) {
          await stalled.promise;
          throw new Error('Vault down');
        }
        return save(record, version);
      });
      const failed = expect(service.revoke({ holderDidKey: HOLDER, reason: 'stolen' })).rejects.toThrow('Vault down');
      while (h2Claims < 1) await tick();
      await makeService().revoke({ holderDidKey: HOLDER });
      stalled.resolve();
      await failed;

      expect(await service.getStatus(entry.listId, entry.idx)).toBe(1);
      expect(await holders.findByHolder(HOLDER)).toMatchObject({
        revokedReason: 'stolen',
        statusChange: { pending: false },
      });
      for (const id of ['h-1', 'h-2']) {
        expect(await audit(id)).toMatchObject({ revokedReason: 'stolen', statusChange: { value: 1, pending: false } });
      }
    });

    it('releases what a request claimed when another request aborted the change', async () => {
      for (const id of ['h-1', 'h-2']) await offer(id);
      await service.allocateForSession('h-1');
      const before = await Promise.all(['h-1', 'h-2'].map(audit));
      // Both requests stall claiming h-2. The first then fails and aborts; the
      // second claims h-2 after that abort, so it must undo its own claim.
      const first = deferred();
      const second = deferred();
      const save = sessions.saveIfUnchanged.bind(sessions);
      let h2Claims = 0;
      jest.spyOn(sessions, 'saveIfUnchanged').mockImplementation(async (record, version) => {
        if (record.id === 'h-2' && record.statusChange?.pending) {
          const claim = h2Claims++;
          if (claim === 0) {
            await first.promise;
            throw new Error('Vault down');
          }
          if (claim === 1) await second.promise;
        }
        return save(record, version);
      });
      const write = jest.spyOn(vault, 'kvWrite');
      const firstFailed = expect(service.revoke({ holderDidKey: HOLDER })).rejects.toThrow('Vault down');
      while (h2Claims < 1) await tick();
      const secondFailed = expect(makeService().revoke({ holderDidKey: HOLDER })).rejects.toThrow(
        /aborted by another request/,
      );
      while (h2Claims < 2) await tick();
      first.resolve();
      await firstFailed;
      second.resolve();
      await secondFailed;

      expect(listWrites(write)).toHaveLength(0);
      expect(await Promise.all(['h-1', 'h-2'].map(audit))).toEqual(before);
      expect((await holders.findByHolder(HOLDER))!.statusChange).toBeUndefined();
    });

    it('refuses a single-session change to a session a holder change has claimed', async () => {
      for (const id of ['h-1', 'h-2']) await offer(id);
      const entry = await service.allocateForSession('h-1');
      const before = await audit('h-1');
      // While the holder change is still claiming, revoke h-1 by its own id.
      // Taking over the holder's intent would move a bit the abort below
      // does not know about.
      let single: unknown;
      const save = sessions.saveIfUnchanged.bind(sessions);
      jest.spyOn(sessions, 'saveIfUnchanged').mockImplementation(async (record, version) => {
        if (record.id === 'h-2' && record.statusChange?.pending) {
          while (!(await sessions.findOneById('h-1'))!.statusChange?.pending) await tick();
          single = await makeService()
            .revoke({ sessionId: 'h-1' })
            .catch((error: unknown) => error);
          throw new Error('Vault down');
        }
        return save(record, version);
      });
      await expect(service.revoke({ holderDidKey: HOLDER })).rejects.toThrow('Vault down');

      expect(single).toBeInstanceOf(ConflictException);
      expect(await service.getStatus(entry.listId, entry.idx)).toBe(0);
      expect(await audit('h-1')).toEqual(before);
    });

    it('takes over an intent an aborted holder change left behind, restoring what it stored', async () => {
      for (const id of ['h-1', 'h-2']) await offer(id);
      await service.allocateForSession('h-1');
      const stored = { statusChange: { id: 'old', value: 0 as const, pending: false, requestedAt: '2026-01-01' } };
      await sessions.mutate('h-1', (current) => {
        current.statusChange = { id: 'dead', value: 1, pending: true, requestedAt: '2026-01-02', prior: stored };
      });
      await expect(service.revoke({ sessionId: 'h-1' })).rejects.toThrow(/holder status change/);

      // An opposite holder change is not blocked by it, and its own abort
      // restores the stored state rather than the dead intent.
      const save = sessions.saveIfUnchanged.bind(sessions);
      const intents = jest.spyOn(sessions, 'saveIfUnchanged').mockImplementation(async (record, version) => {
        if (record.id === 'h-2' && record.statusChange?.pending) throw new Error('Vault down');
        return save(record, version);
      });
      await expect(service.reactivate({ holderDidKey: HOLDER })).rejects.toThrow('Vault down');
      intents.mockRestore();
      expect(await audit('h-1')).toEqual(stored);

      await service.reactivate({ holderDidKey: HOLDER });
      expect(await audit('h-1')).toMatchObject({ statusChange: { value: 0, pending: false } });
    });

    /** Stalls the first pending intent write to h-2 until `release` resolves. */
    function stallClaimOfH2(release: Promise<void>) {
      const entered = deferred();
      const save = sessions.saveIfUnchanged.bind(sessions);
      let claims = 0;
      jest.spyOn(sessions, 'saveIfUnchanged').mockImplementation(async (record, version) => {
        if (record.id === 'h-2' && record.statusChange?.pending && claims++ === 0) {
          entered.resolve();
          await release;
        }
        return save(record, version);
      });
      return entered.promise;
    }

    /** Stalls the first status list write until `release` resolves. */
    function stallFirstListWrite(release: Promise<void>) {
      const entered = deferred();
      const save = lists.saveIfUnchanged.bind(lists);
      jest.spyOn(lists, 'saveIfUnchanged').mockImplementationOnce(async (record, version) => {
        entered.resolve();
        await release;
        return save(record, version);
      });
      return entered.promise;
    }

    it('stops a delayed bit write once its holder change has finished', async () => {
      await offer('h-1');
      const entry = await service.allocateForSession('h-1');
      // The first request stalls before its list write. A re-send finishes the
      // change, and h-1 is then reactivated by its own id.
      const stalled = deferred();
      const entered = stallFirstListWrite(stalled.promise);
      const first = service.revoke({ holderDidKey: HOLDER });
      await entered;
      await makeService().revoke({ holderDidKey: HOLDER });
      await makeService().reactivate({ sessionId: 'h-1' });
      stalled.resolve();
      await expect(first).resolves.toBeDefined(); // its change did finish

      expect(await service.getStatus(entry.listId, entry.idx)).toBe(0);
      expect(await audit('h-1')).toMatchObject({ statusChange: { value: 0, pending: false } });
    });

    it('undoes a late claim instead of completing it, once the change has finished', async () => {
      await offer('h-1');
      const entry = await service.allocateForSession('h-1');
      await holders.mutate(HOLDER, (current) => {
        current.statusChange = {
          id: 'A',
          value: 1,
          pending: true,
          committed: true,
          requestedAt: '2026-01-01',
          prior: {},
        };
      });
      // Just after this request resumes the change, another request finishes it
      // and h-1 is then reactivated by sessionId.
      const reactivated = { id: 'Y', value: 0 as const, pending: false, requestedAt: '2026-01-02' };
      const saveHolder = holders.saveIfUnchanged.bind(holders);
      jest.spyOn(holders, 'saveIfUnchanged').mockImplementationOnce(async (record, version) => {
        const saved = await saveHolder(record, version);
        await holders.mutate(HOLDER, (current) => {
          current.statusChange!.pending = false;
        });
        await sessions.mutate('h-1', (current) => {
          current.statusChange = reactivated;
        });
        return saved;
      });
      await expect(service.revoke({ holderDidKey: HOLDER })).resolves.toBeDefined();

      expect(await service.getStatus(entry.listId, entry.idx)).toBe(0);
      expect(await audit('h-1')).toEqual({ statusChange: reactivated });
    });

    it.each([false, true])(
      'lets an unfinished sessionId change finish beside a holder change that does not own it (committed=%s)',
      async (committed) => {
        await offer('h-1');
        const entry = await service.allocateForSession('h-1');
        // A holder revoke abandoned before it finished, and a revoke of h-1 by
        // sessionId it never claimed, also abandoned: each used to wait for the other.
        await holders.mutate(HOLDER, (current) => {
          current.statusChange = { id: 'A', value: 1, pending: true, committed, requestedAt: '2026-01-01', prior: {} };
        });
        await sessions.mutate('h-1', (current) => {
          current.statusChange = { id: 'C', value: 1, pending: true, requestedAt: '2026-01-01' };
        });

        await expect(service.revoke({ sessionId: 'h-1' })).resolves.toHaveLength(1);
        await expect(service.revoke({ holderDidKey: HOLDER })).resolves.toEqual([]);
        expect(await service.getStatus(entry.listId, entry.idx)).toBe(1);
        expect(await holders.findByHolder(HOLDER)).toMatchObject({ statusChange: { pending: false } });
      },
    );

    it('never takes over the intent of a newer holder change', async () => {
      for (const id of ['h-1', 'h-2']) await offer(id);
      const stalled = deferred();
      const entered = stallClaimOfH2(stalled.promise);
      const failed = expect(service.revoke({ holderDidKey: HOLDER })).rejects.toThrow(/superseded/);
      await entered;
      // Meanwhile the first request's change is aborted, and a newer one claims h-2 and commits.
      const newer = { id: 'newer', value: 1 as const, pending: true, requestedAt: '2026-01-02', prior: {} };
      await holders.mutate(HOLDER, (current) => {
        current.statusChange = { ...newer, committed: true };
      });
      await sessions.mutate('h-2', (current) => {
        current.statusChange = newer;
      });
      stalled.resolve();
      await failed;

      expect((await sessions.findOneById('h-2'))!.statusChange).toMatchObject({ id: 'newer', pending: true });
      expect((await sessions.findOneById('h-1'))!.statusChange).toBeUndefined();
    });

    it('completes quietly when another request has already finished the change', async () => {
      for (const id of ['h-1', 'h-2']) await offer(id);
      const entry = await service.allocateForSession('h-1');
      const stalled = deferred();
      const entered = stallClaimOfH2(stalled.promise);
      const first = service.revoke({ holderDidKey: HOLDER });
      await entered;
      await makeService().revoke({ holderDidKey: HOLDER });
      const write = jest.spyOn(vault, 'kvWrite');
      stalled.resolve();

      await expect(first).resolves.toEqual([expect.objectContaining({ listId: entry.listId, idx: entry.idx })]);
      expect(listWrites(write)).toHaveLength(0);
      for (const id of ['h-1', 'h-2']) {
        expect(await audit(id)).toMatchObject({ statusChange: { value: 1, pending: false } });
      }
    });

    it('succeeds when a concurrent re-send finishes the change during its bit writes', async () => {
      await offer('h-1');
      const entry = await service.allocateForSession('h-1');
      const stalled = deferred();
      const entered = stallFirstListWrite(stalled.promise);
      const first = service.revoke({ holderDidKey: HOLDER });
      await entered;
      await makeService().revoke({ holderDidKey: HOLDER });
      stalled.resolve();

      await expect(first).resolves.toEqual([expect.objectContaining({ listId: entry.listId, idx: entry.idx })]);
      expect(await service.getStatus(entry.listId, entry.idx)).toBe(1);
      expect(await holders.findByHolder(HOLDER)).toMatchObject({ statusChange: { pending: false } });
    });

    it('never releases sessions that its finished change has completed', async () => {
      for (const id of ['h-1', 'h-2']) await offer(id);
      await service.allocateForSession('h-1');
      const stalled = deferred();
      const entered = stallClaimOfH2(stalled.promise);
      const late = expect(service.revoke({ holderDidKey: HOLDER, reason: 'stolen' })).rejects.toThrow(/superseded/);
      await entered;
      // A re-send finishes the change; then a newer change claims h-2, so the
      // stalled request fails and releases what it still holds.
      await makeService().revoke({ holderDidKey: HOLDER });
      const finished = await audit('h-1');
      const newer = { id: 'newer', value: 0 as const, pending: true, requestedAt: '2026-01-03', prior: {} };
      await holders.mutate(HOLDER, (current) => {
        current.statusChange = newer;
      });
      await sessions.mutate('h-2', (current) => {
        current.statusChange = newer;
      });
      stalled.resolve();
      await late;

      expect(finished).toMatchObject({ revokedReason: 'stolen', statusChange: { pending: false } });
      expect(await audit('h-1')).toEqual(finished);
    });

    it('reports a change it could not undo, rather than its original error', async () => {
      for (const id of ['h-1', 'h-2']) await offer(id);
      const save = sessions.saveIfUnchanged.bind(sessions);
      jest.spyOn(sessions, 'saveIfUnchanged').mockImplementation(async (record, version) => {
        if (record.id === 'h-2' && record.statusChange?.pending) throw new Error('Vault down');
        return save(record, version);
      });
      const saveHolder = holders.saveIfUnchanged.bind(holders);
      jest
        .spyOn(holders, 'saveIfUnchanged')
        .mockImplementationOnce(saveHolder)
        .mockRejectedValueOnce(new Error('still down'));

      await expect(service.revoke({ holderDidKey: HOLDER })).rejects.toThrow(ServiceUnavailableException);
      expect((await holders.findByHolder(HOLDER))!.statusChange).toMatchObject({ pending: true });
    });

    it('still issues for a holder did:key the index cannot hold', async () => {
      await sessions.save({ id: 'odd', credoIssuanceSessionId: 'odd', holderDidKey: 'did:key:not-base58!' });
      await expect(service.allocateForSession('odd')).resolves.toBeDefined();
      await expect(service.revoke({ sessionId: 'odd' })).resolves.toHaveLength(1);
    });
  });

  describe('holder index backfill', () => {
    const HOLDER = 'did:key:zH';
    const MARKER = `${SESSION_FOLDER}/migrations/by-holder`;

    it('indexes sessions saved before the index existed, so a holder revocation reaches them', async () => {
      await sessions.save({ id: 'legacy', credoIssuanceSessionId: 'legacy', holderDidKey: HOLDER });
      await sessions.save({ id: 'unindexable', holderDidKey: 'did:key:not-base58!' });
      await sessions.save({ id: 'anonymous' });
      const entry = await service.allocateForSession('legacy');

      await service.revoke({ holderDidKey: HOLDER });
      expect(await service.getStatus(entry.listId, entry.idx)).toBe(1);
      expect(kv.get(MARKER)?.data).toMatchObject({ sessions: 3 });
    });

    it('scans once per Vault, and once per process for concurrent lookups', async () => {
      await sessions.save({ id: 'legacy', holderDidKey: HOLDER });
      const list = jest.spyOn(vault, 'kvList');
      const scans = () => list.mock.calls.filter(([path]) => path === `${SESSION_FOLDER}/records`).length;

      await Promise.all([sessions.findByHolder(HOLDER), sessions.findByHolder(HOLDER)]);
      expect(scans()).toBe(1);
      // Another process reads the marker instead of scanning again.
      await new Oid4vcIssuanceSessionRepository(vault, tokenProvider).findByHolder(HOLDER);
      expect(scans()).toBe(1);
    });

    it('fails a lookup rather than answering from a partial index, and retries on the next', async () => {
      await sessions.save({ id: 'legacy', holderDidKey: HOLDER });
      jest.spyOn(vault, 'kvList').mockRejectedValueOnce(new Error('Vault down'));
      await expect(sessions.findByHolder(HOLDER)).rejects.toThrow('Vault down');
      expect(kv.has(MARKER)).toBe(false);
      expect((await sessions.findByHolder(HOLDER)).map((session) => session.id)).toEqual(['legacy']);
    });

    it('writes the marker with a fresh token, as the scan can outlast the first', async () => {
      await sessions.save({ id: 'legacy', holderDidKey: HOLDER });
      let issued = 0;
      const tokens = { getToken: async () => `token-${++issued}` } as unknown as AlgoVaultTokenProvider;
      const write = jest.spyOn(vault, 'kvWrite');
      await new Oid4vcIssuanceSessionRepository(vault, tokens).ensureHolderIndex();

      const [, , markerToken] = write.mock.calls.find(([path]) => path === MARKER)!;
      expect(markerToken).toBe(`token-${issued}`);
      expect(issued).toBeGreaterThan(1);
    });

    it('fails rather than skips a session when Vault rejects its index write', async () => {
      await sessions.save({ id: 'legacy', holderDidKey: HOLDER });
      jest.spyOn(vault, 'kvWrite').mockRejectedValueOnce(new BadRequestException('VaultException'));
      await expect(sessions.ensureHolderIndex()).rejects.toThrow(BadRequestException);
      expect(kv.has(MARKER)).toBe(false);
    });

    it('starts at boot when auto-init is on', async () => {
      const ensure = jest.spyOn(sessions, 'ensureHolderIndex');
      await makeService({ autoInit: false }).onModuleInit();
      expect(ensure).not.toHaveBeenCalled();
      await makeService({ agentError: new Error('agent unavailable') }).onModuleInit();
      expect(ensure).toHaveBeenCalledTimes(1);
    });
  });

  // `?holderDidKey=` reaches the repository unvalidated, and the value becomes a Vault KV path segment.
  it.each(['../../records', 'did:key:z../../records', 'did:key:', ''])(
    'refuses to build a holder index path from %p',
    async (holderDidKey) => {
      const list = jest.spyOn(vault, 'kvList');
      await expect(sessions.findByHolder(holderDidKey)).rejects.toThrow(BadRequestException);
      await expect(sessions.indexHolder(holderDidKey, 'session-a')).rejects.toThrow(BadRequestException);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown and unredeemed sessions', async () => {
    await expect(service.revokeBySessionId('missing')).rejects.toThrow(NotFoundException);
    await sessions.save({ id: 'empty' });
    await expect(service.revokeBySessionId('empty')).rejects.toThrow(/no status list entry/);
  });

  it('persists intent before writes, blocks opposite operations, and resumes after partial failure', async () => {
    const first = await issue();
    storedList(first.listId).nextIndex = STATUS_LIST_SIZE;
    const second = await issue();
    const save = lists.saveIfUnchanged.bind(lists);
    jest.spyOn(lists, 'saveIfUnchanged').mockImplementationOnce(save).mockRejectedValueOnce(new Error('Vault down'));
    await expect(service.revokeBySessionId('session-a', 'original reason')).rejects.toThrow('Vault down');
    expect(await service.getStatus(first.listId, first.idx)).toBe(1);
    expect(await service.getStatus(second.listId, second.idx)).toBe(0);
    expect((await sessions.findOneById('session-a'))!.statusChange!.pending).toBe(true);
    await expect(issue('session-a', makeService())).rejects.toThrow(ConflictException);
    await expect(makeService().reactivateBySessionId('session-a')).rejects.toThrow(ConflictException);
    await makeService().revokeBySessionId('session-a', 'replacement reason');
    expect(await service.getStatus(second.listId, second.idx)).toBe(1);
    expect((await sessions.findOneById('session-a'))!.revokedReason).toBe('original reason');
  });

  it('does not report success when intent or completion cannot be persisted', async () => {
    const entry = await issue();
    const save = sessions.saveIfUnchanged.bind(sessions);
    const spy = jest.spyOn(sessions, 'saveIfUnchanged').mockRejectedValueOnce(new Error('intent failed'));
    await expect(service.revokeBySessionId('session-a')).rejects.toThrow('intent failed');
    expect(await service.getStatus(entry.listId, entry.idx)).toBe(0);
    spy.mockImplementationOnce(save).mockRejectedValueOnce(new Error('completion failed'));
    await expect(service.revokeBySessionId('session-a')).rejects.toThrow('completion failed');
    expect(await service.getStatus(entry.listId, entry.idx)).toBe(1);
    await makeService().revokeBySessionId('session-a');
    expect((await sessions.findOneById('session-a'))!.statusChange!.pending).toBe(false);
  });

  it('blocks an issuance append which loses a race with revocation intent', async () => {
    await issue();
    const save = sessions.saveIfUnchanged.bind(sessions);
    jest.spyOn(sessions, 'saveIfUnchanged').mockImplementationOnce(async (record, version) => {
      await makeService().revokeBySessionId('session-a');
      return save(record, version);
    });
    await expect(issue()).rejects.toThrow(ConflictException);
    expect((await sessions.findOneById('session-a'))!.statusEntries).toHaveLength(1);
  });

  it('includes an append which commits before revocation intent', async () => {
    const first = await issue();
    let second: Awaited<ReturnType<typeof issue>>;
    const save = sessions.saveIfUnchanged.bind(sessions);
    jest.spyOn(sessions, 'saveIfUnchanged').mockImplementationOnce(async (record, version) => {
      second = await issue('session-a', makeService());
      return save(record, version);
    });
    await service.revokeBySessionId('session-a');
    for (const e of [first, second!]) expect(await service.getStatus(e.listId, e.idx)).toBe(1);
  });

  it.each([false, true])(
    'fences a delayed worker after a retry completes and status reverses (reactivating=%s)',
    async (reactivating) => {
      const entry = await issue();
      if (reactivating) await service.revokeBySessionId('session-a');
      const entered = deferred();
      const resume = deferred();
      const save = lists.saveIfUnchanged.bind(lists);
      jest.spyOn(lists, 'saveIfUnchanged').mockImplementationOnce(async (record, version) => {
        entered.resolve();
        await resume.promise;
        return save(record, version);
      });
      const change = (svc: Oid4vcStatusService) =>
        reactivating ? svc.reactivateBySessionId('session-a') : svc.revokeBySessionId('session-a');
      const delayed = change(service);
      const rejected = expect(delayed).rejects.toThrow(ConflictException);
      await entered.promise;
      await change(makeService());
      if (reactivating) await makeService().revokeBySessionId('session-a');
      else await makeService().reactivateBySessionId('session-a');
      resume.resolve();
      await rejected;
      expect(await service.getStatus(entry.listId, entry.idx)).toBe(reactivating ? 1 : 0);
    },
  );

  it('does not overwrite newer audit state when an old completion write is delayed', async () => {
    const entry = await issue();
    const entered = deferred();
    const resume = deferred();
    const save = sessions.saveIfUnchanged.bind(sessions);
    const spy = jest.spyOn(sessions, 'saveIfUnchanged');
    spy.mockImplementationOnce(save).mockImplementationOnce(async (record, version) => {
      entered.resolve();
      await resume.promise;
      return save(record, version);
    });
    const delayed = service.revokeBySessionId('session-a', 'old reason');
    const rejected = expect(delayed).rejects.toThrow(ConflictException);
    await entered.promise;
    await makeService().revokeBySessionId('session-a');
    await makeService().reactivateBySessionId('session-a');
    resume.resolve();
    await rejected;
    expect(await service.getStatus(entry.listId, entry.idx)).toBe(0);
    const session = await sessions.findOneById('session-a');
    expect(session!.statusChange).toMatchObject({ value: 0, pending: false });
    expect(session!.revokedAt).toBeUndefined();
    expect(session!.revokedReason).toBeUndefined();
  });

  it('mirrors Credo state without overwriting a concurrent revocation', async () => {
    await issue();
    const handlers = new Map<string, (event: any) => Promise<void>>();
    const mirror = new Oid4vcSessionMirrorService(
      {
        getAgent: async () => ({
          events: { on: (name: string, handler: (event: any) => Promise<void>) => handlers.set(name, handler) },
        }),
      } as unknown as Oid4vcAgentProvider,
      { autoInit: true } as Oid4vcConfig,
      sessions,
      {} as never,
    );
    await mirror.onModuleInit();
    const save = sessions.saveIfUnchanged.bind(sessions);
    jest.spyOn(sessions, 'saveIfUnchanged').mockImplementationOnce(async (record, version) => {
      await makeService().revokeBySessionId('session-a');
      return save(record, version);
    });
    await [...handlers.values()][0]({ payload: { issuanceSession: { id: 'session-a', state: 'Completed' } } });
    expect(await sessions.findOneById('session-a')).toMatchObject({
      state: 'Completed',
      statusChange: { value: 1, pending: false },
    });
  });

  it('signs a real status JWT and reuses it across allocations, but observes other instances immediately', async () => {
    const entry = await issue();
    const jwt = await service.getStatusListJwt(entry.listId);
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'EdDSA',
      typ: 'statuslist+jwt',
      kid: `${ISSUER_DID}#keys-1`,
    });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims).toMatchObject({ iss: ISSUER_DID, sub: entry.uri, iat: expect.any(Number) });
    expect(claims.exp).toBeUndefined();
    expect(
      crypto.verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')),
    ).toBe(true);
    await service.allocate();
    expect(await service.getStatusListJwt(entry.listId)).toBe(jwt);
    expect(sign).toHaveBeenCalledTimes(1);
    await makeService().revokeBySessionId('session-a');
    expect(getListFromStatusListJWT(await service.getStatusListJwt(entry.listId)).getStatus(entry.idx)).toBe(1);
    await makeService().reactivateBySessionId('session-a');
    expect(getListFromStatusListJWT(await service.getStatusListJwt(entry.listId)).getStatus(entry.idx)).toBe(0);
    expect(sign).toHaveBeenCalledTimes(3);
  });

  it('does not serve cached status when Vault is unavailable or the list is missing', async () => {
    const entry = await service.allocate();
    await service.getStatusListJwt(entry.listId);
    jest.spyOn(lists, 'load').mockRejectedValueOnce(new Error('Vault down'));
    await expect(service.getStatusListJwt(entry.listId)).rejects.toThrow('Vault down');
    kv.delete(`${LIST_FOLDER}/records/${entry.listId}`);
    await expect(service.getStatusListJwt(entry.listId)).rejects.toThrow(NotFoundException);
  });

  it('serialises token builds with bit writes, and signs concurrent misses once', async () => {
    const entry = await issue();
    const entered = deferred();
    const resume = deferred();
    const signer = sign.getMockImplementation()!;
    sign.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      return signer(...args);
    });
    const first = service.getStatusListJwt(entry.listId);
    await entered.promise;
    const revoke = service.revokeBySessionId('session-a');
    resume.resolve();
    await first;
    await revoke;
    const tokens = await Promise.all([service.getStatusListJwt(entry.listId), service.getStatusListJwt(entry.listId)]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(getListFromStatusListJWT(tokens[0]).getStatus(entry.idx)).toBe(1);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it.each(['default', '../active', '..', 'missing'])(
    'rejects non-UUID public list id %s before storage access',
    async (id) => {
      const load = jest.spyOn(lists, 'load');
      await expect(service.getStatusListJwt(id)).rejects.toThrow(NotFoundException);
      expect(load).not.toHaveBeenCalled();
    },
  );

  describe('local resolution', () => {
    let networkFetch: jest.Mock;
    let host: { getStatusListFetcher: (context: AgentContext) => (uri: string) => Promise<string> };
    let agent: unknown;
    beforeEach(() => {
      networkFetch = jest.fn(async (uri: string) => `remote:${uri}`);
      host = { getStatusListFetcher: () => networkFetch };
      agent = { context: { dependencyManager: { resolve: () => host } } };
    });
    it('resolves UUID lists in-process and falls through for foreign and non-list URLs', async () => {
      const svc = makeService({ agent });
      const entry = await issue('session-a', svc);
      await svc.onModuleInit();
      const fetcher = host.getStatusListFetcher({} as AgentContext);
      expect(await fetcher(entry.uri)).toBe(await svc.getStatusListJwt(entry.listId));
      expect(networkFetch).not.toHaveBeenCalled();
      for (const uri of [
        'https://foreign.example/list/1',
        `${entry.uri}/nested`,
        `${entry.uri}?x=1`,
        LIST_BASE,
        `${LIST_BASE}/default`,
      ]) {
        expect(svc.localStatusListId(uri)).toBeUndefined();
        expect(await fetcher(uri)).toBe(`remote:${uri}`);
      }
      await makeService().revokeBySessionId('session-a');
      expect(getListFromStatusListJWT(await fetcher(entry.uri)).getStatus(entry.idx)).toBe(1);
    });
    it('leaves the fetcher untouched when disabled and handles unavailable agents', async () => {
      const original = host.getStatusListFetcher;
      await makeService({ agent, autoInit: false }).onModuleInit();
      expect(host.getStatusListFetcher).toBe(original);
      await expect(makeService({ agentError: new Error('agent unavailable') }).onModuleInit()).resolves.toBeUndefined();
    });
  });

  // Explicit opt-in: capacity coverage, not a throughput claim or routine CI workload.
  (process.env.STATUS_LIST_CAPACITY_TEST === '1' ? it : it.skip)(
    'allocates 1,000,001 unique entries across 62 lists',
    async () => {
      const counts = new Map<string, number>();
      for (let i = 0; i < 1_000_001; i++) {
        const entry = await service.allocate();
        const expected = counts.get(entry.listId) ?? 0;
        if (entry.idx !== expected) throw new Error(`Duplicate or skipped allocation at ${i}`);
        counts.set(entry.listId, expected + 1);
      }
      expect(counts.size).toBe(62);
      expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(1_000_001);
      for (const [id, count] of counts) expect(storedList(id).nextIndex).toBe(count);
    },
    120_000,
  );
});

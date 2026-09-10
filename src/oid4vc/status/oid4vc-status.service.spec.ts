import * as crypto from 'crypto';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
import { StatusListRepository } from './status-list.repository';
import { Oid4vcStatusService } from './oid4vc-status.service';

const ISSUER_DID = 'did:algo:testnet:app:1:' + 'aa'.repeat(32);
const LIST_BASE = 'http://localhost:3000/v1/credential/status/list';
const LIST_FOLDER = 'intermezzo/oid4vc/status-lists';

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
      sign,
    } as unknown as VaultService;
    lists = new StatusListRepository(vault, tokenProvider);
    sessions = new Oid4vcIssuanceSessionRepository(vault, tokenProvider);
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

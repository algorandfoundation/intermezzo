import * as crypto from 'crypto';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getListFromStatusListJWT } from '@sd-jwt/jwt-status-list';
import { AgentContext } from '@credo-ts/core';

import { Oid4vcAgentProvider } from '../agent/oid4vc-agent.provider';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';
import { Oid4vcConfig } from '../oid4vc.config';
import { VaultService } from '../../vault/vault.service';
import { Oid4vcIssuanceSessionRepository } from '../sessions/vault-repository';
import { Oid4vcIssuanceSession } from '../entities/oid4vc-issuance-session.entity';
import { STATUS_LIST_SIZE, StatusListRecord } from '../entities/status-list.entity';
import { StatusListRepository } from './status-list.repository';
import { DEFAULT_STATUS_LIST_ID, Oid4vcStatusService } from './oid4vc-status.service';

const ISSUER_DID = 'did:algo:testnet:app:1:' + 'aa'.repeat(32);
const LIST_BASE = 'http://localhost:3000/v1/credential/status/list';
const LIST_URI = `${LIST_BASE}/${DEFAULT_STATUS_LIST_ID}`;

/**
 * Minimal in-memory stand-in for {@link VaultRepository}. Hand-rolled rather
 * than auto-mocked because the tests care about the read-modify-write
 * behaviour the service is built on, not about call assertions.
 */
function fakeRepo<T extends { id: string }>() {
  const store = new Map<string, T>();
  return {
    store,
    findOneById: jest.fn(async (id: string) => store.get(id) ?? null),
    save: jest.fn(async (entity: Partial<T>) => {
      const merged = { ...store.get(entity.id as string), ...entity } as T;
      store.set(merged.id, merged);
      return merged;
    }),
    update: jest.fn(async (criteria: Partial<T>, partial: Partial<T>) => {
      const existing = store.get(criteria.id as string);
      if (!existing) return { affected: 0 };
      store.set(existing.id, { ...existing, ...partial });
      return { affected: 1 };
    }),
  };
}

/**
 * Stand-in for {@link StatusListRepository}, versioned the way Vault KV-v2
 * is so the service's compare-and-set retry loop actually runs. Records are
 * copied in and out, so a caller holding one cannot mutate the store without
 * committing.
 */
function fakeListRepo() {
  const store = new Map<string, { record: StatusListRecord; version: number }>();
  return {
    store,
    load: jest.fn(async (id: string) => {
      const held = store.get(id);
      return { record: held ? { ...held.record } : null, version: held?.version ?? 0 };
    }),
    saveIfUnchanged: jest.fn(async (record: StatusListRecord, version: number) => {
      const held = store.get(record.id);
      if ((held?.version ?? 0) !== version) return false;
      store.set(record.id, { record: { ...record }, version: version + 1 });
      return true;
    }),
  };
}

describe('Oid4vcStatusService', () => {
  let service: Oid4vcStatusService;
  let lists: ReturnType<typeof fakeListRepo>;
  let sessions: ReturnType<typeof fakeRepo<Oid4vcIssuanceSession>>;
  let sign: jest.Mock;
  let publicKey: crypto.KeyObject;
  let privateKey: crypto.KeyObject;

  /** Builds a service, optionally with a stub agent and `autoInit` disabled. */
  function makeService(opts: { agent?: unknown; agentError?: Error; autoInit?: boolean } = {}) {
    const configService = {
      get: <T>(key: string, fallback?: T) =>
        key === 'OID4VC_AUTO_INIT' && opts.autoInit === false ? ('false' as unknown as T) : fallback,
    } as unknown as ConfigService;

    const agentProvider = {
      ensureIssuerDid: jest.fn(async () => ({
        did: ISSUER_DID,
        verificationMethodId: `${ISSUER_DID}#keys-1`,
      })),
      getAgent: jest.fn(async () => {
        if (opts.agentError) throw opts.agentError;
        return opts.agent;
      }),
    } as unknown as Oid4vcAgentProvider;

    return new Oid4vcStatusService(
      new Oid4vcConfig(configService),
      lists as unknown as StatusListRepository,
      sessions as unknown as Oid4vcIssuanceSessionRepository,
      agentProvider,
      { sign } as unknown as VaultService,
      { getToken: jest.fn(async () => 'vault-token') } as unknown as AlgoVaultTokenProvider,
    );
  }

  beforeEach(() => {
    const keyPair = crypto.generateKeyPairSync('ed25519');
    publicKey = keyPair.publicKey;
    privateKey = keyPair.privateKey;

    lists = fakeListRepo();
    sessions = fakeRepo<Oid4vcIssuanceSession>();

    // Sign for real, so the published token can be verified the way a
    // verifier would rather than merely inspected.
    sign = jest.fn(async (_key: string, _path: string, data: Uint8Array) => {
      const signature = crypto.sign(null, Buffer.from(data), privateKey);
      return `vault:v1:${signature.toString('base64')}`;
    });

    service = makeService();
  });

  /** Registers a redeemed issuance session holding one entry per `idx`. */
  async function seedSession(id: string, ...indices: number[]): Promise<void> {
    await sessions.save({
      id,
      statusEntries: indices.map((idx) => ({ listId: DEFAULT_STATUS_LIST_ID, idx })),
    } as Oid4vcIssuanceSession);
  }

  /** The stored list record, without the version wrapper the fake keeps. */
  function storedList(listId = DEFAULT_STATUS_LIST_ID): StatusListRecord {
    return lists.store.get(listId)!.record;
  }

  function decodePayload(jwt: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  }

  describe('allocate', () => {
    it('creates the list on first use and hands out consecutive indices', async () => {
      expect(await service.allocate()).toEqual({ listId: DEFAULT_STATUS_LIST_ID, idx: 0, uri: LIST_URI });
      expect(await service.allocate()).toEqual({ listId: DEFAULT_STATUS_LIST_ID, idx: 1, uri: LIST_URI });

      expect(storedList()).toMatchObject({ bits: 1, size: STATUS_LIST_SIZE, nextIndex: 2 });
    });

    it('hands out distinct indices when redemptions overlap', async () => {
      const allocations = await Promise.all(Array.from({ length: 25 }, () => service.allocate()));
      const indices = allocations.map((a) => a.idx).sort((a, b) => a - b);
      expect(indices).toEqual(Array.from({ length: 25 }, (_, i) => i));
      expect(storedList().nextIndex).toBe(25);
    });

    it('does not reuse an index another process took mid-write', async () => {
      await service.allocate();

      // Land a competing commit between this service's read and its write:
      // the record handed back is stale by the time `saveIfUnchanged` runs.
      lists.load.mockImplementationOnce(async (id: string) => {
        const held = lists.store.get(id)!;
        const stale = { record: { ...held.record }, version: held.version };
        held.record.nextIndex += 1;
        held.version += 1;
        return stale;
      });

      // Index 1 went to the competitor, so the retry must hand out 2.
      expect(await service.allocate()).toEqual({ listId: DEFAULT_STATUS_LIST_ID, idx: 2, uri: LIST_URI });
      expect(storedList().nextIndex).toBe(3);
    });

    it('gives up rather than clobbering a list it keeps losing', async () => {
      await service.allocate();
      lists.saveIfUnchanged.mockResolvedValue(false);

      await expect(service.allocate()).rejects.toThrow(ServiceUnavailableException);
      // Still where the successful first allocation left it.
      expect(storedList().nextIndex).toBe(1);
    });

    it('refuses to allocate past the end of the list', async () => {
      await service.allocate();
      // Fast-forward rather than allocating 16384 times.
      storedList().nextIndex = storedList().size;

      await expect(service.allocate()).rejects.toThrow(/is full/);
    });
  });

  describe('revocation', () => {
    it('flips only the targeted entry', async () => {
      const first = await service.allocate();
      const second = await service.allocate();
      await seedSession('session-a', first.idx);
      await seedSession('session-b', second.idx);

      await service.revokeBySessionId('session-a');

      expect(await service.getStatus(DEFAULT_STATUS_LIST_ID, first.idx)).toBe(1);
      expect(await service.getStatus(DEFAULT_STATUS_LIST_ID, second.idx)).toBe(0);
      expect(await service.getStatus(DEFAULT_STATUS_LIST_ID, STATUS_LIST_SIZE - 1)).toBe(0);
    });

    it('revokes every credential the session issued, not just the last', async () => {
      const first = await service.allocate();
      const second = await service.allocate();
      const other = await service.allocate();
      await seedSession('session-a', first.idx, second.idx);
      await seedSession('session-b', other.idx);

      const revoked = await service.revokeBySessionId('session-a');

      expect(revoked).toEqual([
        { listId: DEFAULT_STATUS_LIST_ID, idx: first.idx, uri: LIST_URI },
        { listId: DEFAULT_STATUS_LIST_ID, idx: second.idx, uri: LIST_URI },
      ]);
      expect(await service.getStatus(DEFAULT_STATUS_LIST_ID, first.idx)).toBe(1);
      expect(await service.getStatus(DEFAULT_STATUS_LIST_ID, second.idx)).toBe(1);
      expect(await service.getStatus(DEFAULT_STATUS_LIST_ID, other.idx)).toBe(0);
    });

    it('records who and why, and clears it on reactivation', async () => {
      const entry = await service.allocate();
      await seedSession('session-a', entry.idx);

      await service.revokeBySessionId('session-a', 'device reported stolen');
      expect(sessions.store.get('session-a')).toMatchObject({
        revokedAt: expect.any(Date),
        revokedReason: 'device reported stolen',
      });

      await service.reactivateBySessionId('session-a');
      expect(await service.getStatus(DEFAULT_STATUS_LIST_ID, entry.idx)).toBe(0);
      expect(sessions.store.get('session-a')?.revokedAt).toBeUndefined();
      expect(sessions.store.get('session-a')?.revokedReason).toBeUndefined();
    });

    it('rejects sessions it cannot map to an entry', async () => {
      await expect(service.revokeBySessionId('nope')).rejects.toThrow(NotFoundException);

      await sessions.save({ id: 'unredeemed' } as Oid4vcIssuanceSession);
      await expect(service.revokeBySessionId('unredeemed')).rejects.toThrow(/no status list entry/);
    });
  });

  describe('published token', () => {
    it('is signed by the issuer key and carries the revocation', async () => {
      const entry = await service.allocate();
      await seedSession('session-a', entry.idx);
      await service.revokeBySessionId('session-a');

      const jwt = await service.getStatusListJwt();
      const [encodedHeader, , encodedSignature] = jwt.split('.');

      expect(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString())).toEqual({
        alg: 'EdDSA',
        typ: 'statuslist+jwt',
        kid: `${ISSUER_DID}#keys-1`,
      });

      const payload = decodePayload(jwt);
      expect(payload).toMatchObject({ iss: ISSUER_DID, sub: LIST_URI, iat: expect.any(Number) });
      // An `exp` would fail every credential pointing at the list once it
      // passed, for no benefit — the token is regenerated on every write.
      expect(payload.exp).toBeUndefined();

      const verified = crypto.verify(
        null,
        Buffer.from(jwt.slice(0, jwt.lastIndexOf('.'))),
        publicKey,
        Buffer.from(encodedSignature, 'base64url'),
      );
      expect(verified).toBe(true);

      expect(getListFromStatusListJWT(jwt).getStatus(entry.idx)).toBe(1);
    });

    it('serves a cached token until a bit changes', async () => {
      const entry = await service.allocate();
      await seedSession('session-a', entry.idx);

      const first = await service.getStatusListJwt();
      expect(await service.getStatusListJwt()).toBe(first);
      expect(sign).toHaveBeenCalledTimes(1);

      // Allocating does not change the published bitstring, so the cached
      // token stays valid.
      await service.allocate();
      expect(await service.getStatusListJwt()).toBe(first);
      expect(sign).toHaveBeenCalledTimes(1);

      await service.revokeBySessionId('session-a');
      const afterRevoke = await service.getStatusListJwt();
      expect(afterRevoke).not.toBe(first);
      expect(sign).toHaveBeenCalledTimes(2);
      expect(getListFromStatusListJWT(afterRevoke).getStatus(entry.idx)).toBe(1);
    });

    it('signs once when concurrent misses race', async () => {
      await service.allocate();
      const tokens = await Promise.all([service.getStatusListJwt(), service.getStatusListJwt()]);
      expect(tokens[0]).toBe(tokens[1]);
      expect(sign).toHaveBeenCalledTimes(1);
    });

    it('fails loudly for a list that was never created', async () => {
      await expect(service.getStatusListJwt('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('in-process status list resolution', () => {
    let networkFetch: jest.Mock;
    let host: { getStatusListFetcher: jest.Mock };
    let agent: unknown;

    beforeEach(() => {
      networkFetch = jest.fn(async (uri: string) => `remote-token-for:${uri}`);
      host = { getStatusListFetcher: jest.fn(() => networkFetch) };
      agent = { context: { dependencyManager: { resolve: jest.fn(() => host) } } };
    });

    /** The fetcher Credo would build for a verification, after patching. */
    function currentFetcher(): (uri: string) => Promise<string> {
      return host.getStatusListFetcher({} as AgentContext);
    }

    describe('URI matching', () => {
      it.each([
        [`${LIST_BASE}/default`, 'default'],
        [`${LIST_BASE}/default-2`, 'default-2'],
      ])('claims %s as its own', (uri, expected) => {
        expect(service.localStatusListId(uri)).toBe(expected);
      });

      it.each([
        ['https://another-issuer.example/statuslist/1', 'a foreign issuer'],
        [`${LIST_BASE}/nested/path`, 'a nested path'],
        [`${LIST_BASE}/default?refresh=1`, 'a query string'],
        [`${LIST_BASE}/`, 'an empty id'],
        [LIST_BASE, 'the bare base URL'],
      ])('leaves %s to the network (%s)', (uri) => {
        expect(service.localStatusListId(uri)).toBeUndefined();
      });
    });

    it('answers our own URIs without touching the network', async () => {
      const svc = makeService({ agent });
      const entry = await svc.allocate();
      await svc.onModuleInit();

      const token = await currentFetcher()(entry.uri);

      expect(token).toBe(await svc.getStatusListJwt());
      expect(networkFetch).not.toHaveBeenCalled();
      // This is the property that matters: wallet auth must not depend on the
      // process being able to reach itself at its advertised hostname.
      expect(getListFromStatusListJWT(token).getStatus(entry.idx)).toBe(0);
    });

    it('delegates every other issuer to the original fetcher', async () => {
      const svc = makeService({ agent });
      await svc.onModuleInit();

      const foreign = 'https://another-issuer.example/statuslist/1';
      await expect(currentFetcher()(foreign)).resolves.toBe(`remote-token-for:${foreign}`);
      expect(networkFetch).toHaveBeenCalledWith(foreign);
    });

    it('reflects a revocation immediately', async () => {
      const svc = makeService({ agent });
      const entry = await svc.allocate();
      await seedSession('session-a', entry.idx);
      await svc.onModuleInit();

      await svc.revokeBySessionId('session-a');

      const token = await currentFetcher()(entry.uri);
      expect(getListFromStatusListJWT(token).getStatus(entry.idx)).toBe(1);
    });

    it('leaves the fetcher alone when auto-init is off', async () => {
      const svc = makeService({ agent, autoInit: false });
      await svc.onModuleInit();

      // Untouched: still the stub installed by this test's setup.
      await expect(currentFetcher()('anything')).resolves.toBe('remote-token-for:anything');
    });

    it('falls back to HTTP rather than failing boot when the agent is unavailable', async () => {
      const svc = makeService({ agentError: new Error('askar wallet unavailable') });

      await expect(svc.onModuleInit()).resolves.toBeUndefined();
    });
  });
});

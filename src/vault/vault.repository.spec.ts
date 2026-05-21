import { VaultRepository, BaseEntity } from './vault.repository';
import { VaultService } from './vault.service';
import { AlgoVaultTokenProvider } from '../oid4vc/algo/algo-vault-token.provider';

interface TestEntity extends BaseEntity {
  name: string;
  externalId?: string;
}

describe('VaultRepository', () => {
  let vault: jest.Mocked<Pick<VaultService, 'kvRead' | 'kvWrite' | 'kvList' | 'kvDelete'>>;
  let tokenProvider: jest.Mocked<Pick<AlgoVaultTokenProvider, 'getToken'>>;
  let repo: VaultRepository<TestEntity>;

  const folder = 'test-folder';
  const token = 'vault-token';

  beforeEach(() => {
    vault = {
      kvRead: jest.fn(),
      kvWrite: jest.fn().mockResolvedValue(undefined),
      kvList: jest.fn(),
      kvDelete: jest.fn().mockResolvedValue(undefined),
    };
    tokenProvider = {
      getToken: jest.fn().mockResolvedValue(token),
    };
    repo = new VaultRepository<TestEntity>(
      vault as unknown as VaultService,
      tokenProvider as unknown as AlgoVaultTokenProvider,
      folder,
      'externalId',
    );
  });

  describe('create', () => {
    it('returns the input cast as the entity type', () => {
      const data = { name: 'alice' };
      const result = repo.create(data);
      expect(result).toBe(data);
    });
  });

  describe('save', () => {
    it('persists a new entity, generating an id and timestamps', async () => {
      vault.kvRead.mockResolvedValue(undefined);

      const result = await repo.save({ name: 'alice' });

      expect(result.id).toEqual(expect.any(String));
      expect(result.name).toBe('alice');
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
      expect(vault.kvWrite).toHaveBeenCalledWith(
        `${folder}/records/${result.id}`,
        expect.objectContaining({ id: result.id, name: 'alice' }),
        token,
      );
    });

    it('preserves createdAt and writes the index when indexField is set', async () => {
      const existingCreatedAt = new Date('2024-01-01T00:00:00Z');
      vault.kvRead.mockResolvedValueOnce({
        id: 'fixed-id',
        name: 'alice',
        createdAt: existingCreatedAt,
        updatedAt: existingCreatedAt,
      } as any);

      const result = await repo.save({ id: 'fixed-id', name: 'alice-v2', externalId: 'ext-1' });

      expect(result.id).toBe('fixed-id');
      expect(result.name).toBe('alice-v2');
      expect(new Date(result.createdAt).toISOString()).toBe(existingCreatedAt.toISOString());
      expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(existingCreatedAt.getTime());
      expect(vault.kvWrite).toHaveBeenCalledWith(
        `${folder}/records/fixed-id`,
        expect.objectContaining({ id: 'fixed-id', externalId: 'ext-1' }),
        token,
      );
      expect(vault.kvWrite).toHaveBeenCalledWith(`${folder}/index/externalId/ext-1`, { id: 'fixed-id' }, token);
    });

    it('does not write an index entry when the indexed field is unset', async () => {
      vault.kvRead.mockResolvedValue(undefined);

      await repo.save({ name: 'no-index' });

      expect(vault.kvWrite).toHaveBeenCalledTimes(1);
      expect(vault.kvWrite).not.toHaveBeenCalledWith(
        expect.stringContaining('/index/'),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('findOneById', () => {
    it('returns the entity with dates rehydrated', async () => {
      vault.kvRead.mockResolvedValueOnce({
        id: 'a',
        name: 'alice',
        createdAt: '2024-01-01T00:00:00Z' as any,
        updatedAt: '2024-01-02T00:00:00Z' as any,
      });

      const result = await repo.findOneById('a');

      expect(vault.kvRead).toHaveBeenCalledWith(`${folder}/records/a`, token);
      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.updatedAt).toBeInstanceOf(Date);
      expect(result?.name).toBe('alice');
    });

    it('returns null when the record is missing', async () => {
      vault.kvRead.mockResolvedValueOnce(undefined);
      await expect(repo.findOneById('missing')).resolves.toBeNull();
    });
  });

  describe('findOneBy', () => {
    it('routes to findOneById when criteria.id is set', async () => {
      vault.kvRead.mockResolvedValueOnce({
        id: 'a',
        name: 'alice',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const result = await repo.findOneBy({ id: 'a' });
      expect(result?.id).toBe('a');
      expect(vault.kvRead).toHaveBeenCalledWith(`${folder}/records/a`, token);
    });

    it('routes to findOneByIndex when the indexed criteria is set', async () => {
      // index lookup, then record lookup
      vault.kvRead.mockResolvedValueOnce({ id: 'a' } as any).mockResolvedValueOnce({
        id: 'a',
        name: 'alice',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await repo.findOneBy({ externalId: 'ext-1' });

      expect(vault.kvRead).toHaveBeenNthCalledWith(1, `${folder}/index/externalId/ext-1`, token);
      expect(vault.kvRead).toHaveBeenNthCalledWith(2, `${folder}/records/a`, token);
      expect(result?.id).toBe('a');
    });

    it('returns null when no usable criteria is given', async () => {
      await expect(repo.findOneBy({ name: 'alice' })).resolves.toBeNull();
      expect(vault.kvRead).not.toHaveBeenCalled();
    });
  });

  describe('findOneByIndex', () => {
    it('returns null when no indexField is configured', async () => {
      const noIndexRepo = new VaultRepository<TestEntity>(
        vault as unknown as VaultService,
        tokenProvider as unknown as AlgoVaultTokenProvider,
        folder,
      );
      await expect(noIndexRepo.findOneByIndex('whatever')).resolves.toBeNull();
      expect(vault.kvRead).not.toHaveBeenCalled();
    });

    it('returns null when the index mapping is missing', async () => {
      vault.kvRead.mockResolvedValueOnce(undefined);
      await expect(repo.findOneByIndex('nope')).resolves.toBeNull();
      expect(vault.kvRead).toHaveBeenCalledTimes(1);
    });
  });

  describe('find', () => {
    it('returns all records and skips entries that no longer exist', async () => {
      vault.kvList.mockResolvedValueOnce(['a', 'b', 'gone']);
      vault.kvRead
        .mockResolvedValueOnce({
          id: 'a',
          name: 'alice',
          createdAt: '2024-01-02T00:00:00Z' as any,
          updatedAt: '2024-01-02T00:00:00Z' as any,
        })
        .mockResolvedValueOnce({
          id: 'b',
          name: 'bob',
          createdAt: '2024-01-01T00:00:00Z' as any,
          updatedAt: '2024-01-01T00:00:00Z' as any,
        })
        .mockResolvedValueOnce(undefined);

      const result = await repo.find();

      expect(vault.kvList).toHaveBeenCalledWith(`${folder}/records`, token);
      expect(result.map((r) => r.id)).toEqual(['a', 'b']);
    });

    it('sorts results ASC by the requested field', async () => {
      vault.kvList.mockResolvedValueOnce(['a', 'b']);
      vault.kvRead
        .mockResolvedValueOnce({
          id: 'a',
          name: 'zeta',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: 'b',
          name: 'alpha',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      const result = await repo.find({ order: { name: 'ASC' } });
      expect(result.map((r) => r.name)).toEqual(['alpha', 'zeta']);
    });

    it('sorts results DESC by the requested field', async () => {
      vault.kvList.mockResolvedValueOnce(['a', 'b']);
      vault.kvRead
        .mockResolvedValueOnce({
          id: 'a',
          name: 'alpha',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: 'b',
          name: 'zeta',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      const result = await repo.find({ order: { name: 'DESC' } });
      expect(result.map((r) => r.name)).toEqual(['zeta', 'alpha']);
    });

    it('returns an empty array when there are no records', async () => {
      vault.kvList.mockResolvedValueOnce([]);
      await expect(repo.find()).resolves.toEqual([]);
    });
  });

  describe('update', () => {
    it('updates an existing record by id', async () => {
      const existing = {
        id: 'a',
        name: 'alice',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
      };
      // findOneById in update() + findOneById inside save() (existing lookup)
      vault.kvRead.mockResolvedValueOnce(existing).mockResolvedValueOnce(existing);

      const result = await repo.update({ id: 'a' }, { name: 'alice-v2' });

      expect(result).toEqual({ affected: 1 });
      expect(vault.kvWrite).toHaveBeenCalledWith(
        `${folder}/records/a`,
        expect.objectContaining({ id: 'a', name: 'alice-v2' }),
        token,
      );
    });

    it('reports zero affected when the record is missing', async () => {
      vault.kvRead.mockResolvedValueOnce(undefined);
      const result = await repo.update({ id: 'missing' }, { name: 'x' });
      expect(result).toEqual({ affected: 0 });
      expect(vault.kvWrite).not.toHaveBeenCalled();
    });

    it('updates an existing record by indexed field', async () => {
      const existing = {
        id: 'a',
        name: 'alice',
        externalId: 'ext-1',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
      };
      // index lookup -> record lookup -> save's existing lookup
      vault.kvRead
        .mockResolvedValueOnce({ id: 'a' } as any)
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(existing);

      const result = await repo.update({ externalId: 'ext-1' }, { name: 'alice-v2' });

      expect(result).toEqual({ affected: 1 });
      expect(vault.kvWrite).toHaveBeenCalledWith(
        `${folder}/records/a`,
        expect.objectContaining({ name: 'alice-v2' }),
        token,
      );
    });

    it('warns and returns zero affected when no usable criteria is provided', async () => {
      const warnSpy = jest.spyOn((repo as any).logger, 'warn').mockImplementation(() => undefined);

      const result = await repo.update({ name: 'alice' }, { name: 'alice-v2' });

      expect(result).toEqual({ affected: 0 });
      expect(warnSpy).toHaveBeenCalledWith('Update called without id or indexed field; scan not implemented');
      expect(vault.kvWrite).not.toHaveBeenCalled();
    });
  });
});

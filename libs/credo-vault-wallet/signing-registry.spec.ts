import { vaultSigningRegistry } from './signing-registry';
import { parseVaultSignature } from './vault-signature';
import type { KeyRefStore, VaultKeyBinding } from './ports';

describe('vaultSigningRegistry', () => {
  beforeEach(() => vaultSigningRegistry.reset());

  it('stores and retrieves bindings by publicKeyBase58 (cache-only when no store is set)', async () => {
    await vaultSigningRegistry.bind('pkA', { vaultKeyName: 'k1', transitPath: 'pawn/users' });
    await expect(vaultSigningRegistry.getBinding('pkA')).resolves.toEqual({
      vaultKeyName: 'k1',
      transitPath: 'pawn/users',
    });
    await expect(vaultSigningRegistry.getBinding('pkB')).resolves.toBeUndefined();
  });

  it('overrides bindings on re-bind (idempotent for the same key)', async () => {
    await vaultSigningRegistry.bind('pk', { vaultKeyName: 'old', transitPath: 'p' });
    await vaultSigningRegistry.bind('pk', { vaultKeyName: 'new', transitPath: 'p' });
    await expect(vaultSigningRegistry.getBinding('pk')).resolves.toMatchObject({
      vaultKeyName: 'new',
    });
  });

  it('removes bindings via unbind', async () => {
    await vaultSigningRegistry.bind('pk', { vaultKeyName: 'k', transitPath: 'p' });
    await vaultSigningRegistry.unbind('pk');
    await expect(vaultSigningRegistry.getBinding('pk')).resolves.toBeUndefined();
  });

  it('throws from sign() when no signer has been registered', async () => {
    await expect(
      vaultSigningRegistry.sign({ vaultKeyName: 'k', transitPath: 'p' }, new Uint8Array([1])),
    ).rejects.toThrow(/no signer registered/);
  });

  it('delegates to the registered signer', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const signer = jest.fn(async (_b: VaultKeyBinding, _d: Uint8Array) => new Uint8Array([9, 9, 9]));
    vaultSigningRegistry.setSigner(signer);
    const out = await vaultSigningRegistry.sign({ vaultKeyName: 'k', transitPath: 'p' }, new Uint8Array([1, 2]));
    expect(signer).toHaveBeenCalledWith({ vaultKeyName: 'k', transitPath: 'p' }, new Uint8Array([1, 2]));
    expect(Array.from(out)).toEqual([9, 9, 9]);
  });

  describe('with a KeyRefStore', () => {
    // Minimal in-memory fake — exercises the write-through and cache-miss
    // fallback behaviour without needing any real persistence layer. The
    // shape mirrors what a real host adapter (TypeORM / Prisma / …)
    // would provide.
    const buildFakeStore = (): {
      store: KeyRefStore;
      rows: Map<string, VaultKeyBinding>;
      saves: jest.Mock;
      finds: jest.Mock;
      deletes: jest.Mock;
    } => {
      const rows = new Map<string, VaultKeyBinding>();
      const saves = jest.fn(async (pk: string, b: VaultKeyBinding) => {
        rows.set(pk, b);
      });
      const finds = jest.fn(async (pk: string) => rows.get(pk) ?? null);
      const deletes = jest.fn(async (pk: string) => {
        rows.delete(pk);
      });
      const store: KeyRefStore = {
        save: saves as unknown as KeyRefStore['save'],
        find: finds as unknown as KeyRefStore['find'],
        delete: deletes as unknown as KeyRefStore['delete'],
      };
      return { store, rows, saves, finds, deletes };
    };

    it('persists bindings through bind() (write-through)', async () => {
      const { store, rows, saves } = buildFakeStore();
      vaultSigningRegistry.setStore(store);

      await vaultSigningRegistry.bind('pk-persist', { vaultKeyName: 'kn', transitPath: 'pawn/users' });

      expect(saves).toHaveBeenCalledTimes(1);
      expect(rows.get('pk-persist')).toEqual({
        vaultKeyName: 'kn',
        transitPath: 'pawn/users',
      });
    });

    it('falls back to the store when the cache misses, and warms the cache', async () => {
      const { store, rows, finds } = buildFakeStore();
      // Pre-seed a row directly (simulates a previous process having
      // persisted a binding before this one started).
      rows.set('pk-cold', { vaultKeyName: 'kn-cold', transitPath: 'pawn/users' });
      vaultSigningRegistry.setStore(store);

      // First lookup: cache miss → store hit.
      const first = await vaultSigningRegistry.getBinding('pk-cold');
      expect(first).toEqual({ vaultKeyName: 'kn-cold', transitPath: 'pawn/users' });
      expect(finds).toHaveBeenCalledTimes(1);

      // Second lookup: served from cache, no extra store call.
      const second = await vaultSigningRegistry.getBinding('pk-cold');
      expect(second).toEqual({ vaultKeyName: 'kn-cold', transitPath: 'pawn/users' });
      expect(finds).toHaveBeenCalledTimes(1);
    });

    it('unbind() deletes the row and the cache entry', async () => {
      const { store, rows } = buildFakeStore();
      vaultSigningRegistry.setStore(store);
      await vaultSigningRegistry.bind('pk-rm', { vaultKeyName: 'kn', transitPath: 'p' });
      await vaultSigningRegistry.unbind('pk-rm');
      expect(rows.has('pk-rm')).toBe(false);
      await expect(vaultSigningRegistry.getBinding('pk-rm')).resolves.toBeUndefined();
    });
  });
});

describe('parseVaultSignature', () => {
  it('parses a valid vault:v1:<b64> signature into 64 raw bytes', () => {
    const raw = Buffer.alloc(64, 0x42);
    const wire = `vault:v1:${raw.toString('base64')}`;
    const out = parseVaultSignature(wire);
    expect(out).toEqual(new Uint8Array(raw));
  });

  it('tolerates higher key versions in the prefix', () => {
    const raw = Buffer.alloc(64, 0x07);
    const wire = `vault:v17:${raw.toString('base64')}`;
    expect(parseVaultSignature(wire)).toEqual(new Uint8Array(raw));
  });

  it('rejects signatures missing the vault: prefix', () => {
    expect(() => parseVaultSignature('plain:base64data==')).toThrow(/unexpected Vault signature/);
  });

  it('rejects signatures whose payload is not 64 bytes', () => {
    const wire = `vault:v1:${Buffer.alloc(32, 0).toString('base64')}`;
    expect(() => parseVaultSignature(wire)).toThrow(/expected 64-byte ed25519 signature/);
  });
});

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { AlgoVaultTokenProvider } from './algo-vault-token.provider';
import { VaultService } from '../../vault/vault.service';

describe('AlgoVaultTokenProvider', () => {
  const vault = {
    checkToken: jest.fn(),
    getTokenWithRole: jest.fn(),
  };
  const env: Record<string, string | undefined> = {};
  const config = { get: jest.fn((key: string) => env[key]) } as unknown as ConfigService;

  let provider: AlgoVaultTokenProvider;

  beforeEach(async () => {
    // Use mockReset (not clearAllMocks) so queued `mockResolvedValueOnce`
    // implementations don't bleed between tests.
    vault.checkToken.mockReset();
    vault.getTokenWithRole.mockReset();
    (config.get as jest.Mock).mockReset().mockImplementation((key: string) => env[key]);
    for (const k of Object.keys(env)) delete env[k];
    const moduleRef = await Test.createTestingModule({
      providers: [
        AlgoVaultTokenProvider,
        { provide: VaultService, useValue: vault },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    provider = moduleRef.get(AlgoVaultTokenProvider);
  });

  describe('isConfigured', () => {
    it('returns false when either AppRole credential is missing', () => {
      expect(provider.isConfigured()).toBe(false);
      env.VAULT_ROLE_ID = 'role';
      expect(provider.isConfigured()).toBe(false);
      env.VAULT_SECRET_ID = 'secret';
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('getToken', () => {
    it('throws when AppRole credentials are missing', async () => {
      await expect(provider.getToken()).rejects.toThrow(/VAULT_ROLE_ID/);
    });

    it('logs in via AppRole and caches the resulting token', async () => {
      env.VAULT_ROLE_ID = 'role';
      env.VAULT_SECRET_ID = 'secret';
      vault.getTokenWithRole.mockResolvedValueOnce('vault-token-1');
      vault.checkToken.mockResolvedValue(undefined);

      const t1 = await provider.getToken();
      const t2 = await provider.getToken();
      expect(t1).toBe('vault-token-1');
      expect(t2).toBe('vault-token-1');
      // Login happens once; the second call validates the cached token.
      expect(vault.getTokenWithRole).toHaveBeenCalledTimes(1);
      expect(vault.checkToken).toHaveBeenCalledWith('vault-token-1');
    });

    it('re-logs in when the cached token is rejected by Vault', async () => {
      env.VAULT_ROLE_ID = 'role';
      env.VAULT_SECRET_ID = 'secret';
      vault.getTokenWithRole.mockResolvedValueOnce('expired').mockResolvedValueOnce('fresh');
      // First getToken() has no cache → goes straight to login (no checkToken
      // call). Second getToken() finds the cached token and runs checkToken,
      // which rejects → the provider drops the cache and re-logs in.
      vault.checkToken.mockRejectedValueOnce(new Error('expired'));

      const first = await provider.getToken();
      expect(first).toBe('expired');
      const second = await provider.getToken();
      expect(second).toBe('fresh');
      expect(vault.getTokenWithRole).toHaveBeenCalledTimes(2);
      expect(vault.checkToken).toHaveBeenCalledTimes(1);
    });

    it('coalesces concurrent login requests into a single AppRole call', async () => {
      env.VAULT_ROLE_ID = 'role';
      env.VAULT_SECRET_ID = 'secret';
      let resolveLogin: (v: string) => void = () => undefined;
      vault.getTokenWithRole.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          resolveLogin = resolve;
        }),
      );

      const a = provider.getToken();
      const b = provider.getToken();
      resolveLogin('shared');
      await expect(a).resolves.toBe('shared');
      await expect(b).resolves.toBe('shared');
      expect(vault.getTokenWithRole).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidate', () => {
    it('forces the next getToken call to re-authenticate', async () => {
      env.VAULT_ROLE_ID = 'role';
      env.VAULT_SECRET_ID = 'secret';
      vault.getTokenWithRole.mockResolvedValueOnce('a').mockResolvedValueOnce('b');
      vault.checkToken.mockResolvedValue(undefined);
      await provider.getToken();
      provider.invalidate();
      await expect(provider.getToken()).resolves.toBe('b');
      expect(vault.getTokenWithRole).toHaveBeenCalledTimes(2);
    });
  });
});

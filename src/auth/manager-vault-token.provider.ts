import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VaultService } from '../vault/vault.service';

/**
 * Acquires a manager-scoped Vault token via the platform `VAULT_ROLE_ID` /
 * `VAULT_SECRET_ID` AppRole. Tokens are cached for the configured TTL
 * (default 30 minutes; configurable via `MANAGER_TOKEN_TTL_MS`) to keep
 * AppRole login traffic off the hot path.
 *
 * The provider is the way did:key-authenticated controllers obtain a
 * Vault token; their HTTP requests do not carry a Vault token themselves
 * (only the legacy JWT-authenticated routes carry `request.vault_token`).
 */
@Injectable()
export class ManagerVaultTokenProvider {
  private cached?: { token: string; acquiredAt: number };

  constructor(
    private readonly config: ConfigService,
    private readonly vaultService: VaultService,
  ) {}

  async getToken(): Promise<string> {
    const ttlMs = Number(this.config.get<string>('MANAGER_TOKEN_TTL_MS') ?? 30 * 60 * 1000);
    if (this.cached && Date.now() - this.cached.acquiredAt < ttlMs) {
      return this.cached.token;
    }
    const roleId = this.config.get<string>('VAULT_ROLE_ID');
    const secretId = this.config.get<string>('VAULT_SECRET_ID');
    if (!roleId || !secretId) {
      throw new Error('ManagerVaultTokenProvider requires VAULT_ROLE_ID and VAULT_SECRET_ID to be configured.');
    }
    const token = await this.vaultService.getTokenWithRole(roleId, secretId);
    this.cached = { token, acquiredAt: Date.now() };
    return token;
  }
}

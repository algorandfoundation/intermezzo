import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { VaultService } from '../../vault/vault.service';

/**
 * Issues and caches a Vault token that the OID4VC subsystem uses for two
 * things:
 *
 *  1. Letting the {@link AlgoDidRegistrar} call into {@link DidService} to
 *     publish/delete `did:algo` documents on chain, which requires signing
 *     application transactions with the manager's Vault-held ed25519 key.
 *  2. (future) Letting Credo sign credentials with a `did:algo` issuer whose
 *     verification-method key lives in Vault.
 *
 * Per-request user Vault tokens (the ones minted by `AuthService`) cannot be
 * used here because the agent runs ambient operations (`onModuleInit`, event
 * handlers) outside of any HTTP request. We therefore authenticate the
 * service to Vault via the manager AppRole credentials — `VAULT_ROLE_ID`
 * and `VAULT_SECRET_ID` — the same AppRole the rest of the platform uses
 * for machine-to-machine Vault access (see `ManagerVaultTokenProvider`).
 * A dedicated OID4VC role is intentionally not provisioned: the OID4VC
 * subsystem operates on behalf of the manager identity, so reusing the
 * manager role keeps Vault policy surface area minimal.
 *
 * The token is cached in-memory and refreshed lazily when the cached value
 * fails a `lookup-self`. Vault TTLs and renewals are not handled explicitly
 * here; on rotation, a `lookup-self` failure simply triggers a fresh AppRole
 * login.
 */
@Injectable()
export class AlgoVaultTokenProvider {
  private readonly logger = new Logger(AlgoVaultTokenProvider.name);

  private cachedToken: string | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly vaultService: VaultService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Returns whether the caller has configured AppRole credentials. The
   * registrar/resolver use this to fail loudly when a publish is attempted
   * but the platform was deployed without the OID4VC AppRole wired up.
   */
  isConfigured(): boolean {
    return Boolean(
      this.configService.get<string>('VAULT_ROLE_ID') && this.configService.get<string>('VAULT_SECRET_ID'),
    );
  }

  /**
   * Resolves a working Vault token, performing an AppRole login on cache
   * miss or when a cached token has expired/been revoked.
   */
  async getToken(): Promise<string> {
    if (this.cachedToken) {
      try {
        await this.vaultService.checkToken(this.cachedToken);
        return this.cachedToken;
      } catch (err) {
        this.logger.warn(
          `Cached manager Vault token rejected (${(err as Error).message}); re-authenticating via AppRole`,
        );
        this.cachedToken = undefined;
      }
    }

    if (!this.inFlight) {
      this.inFlight = this.login().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /** Drop any cached token; next `getToken()` will re-authenticate. */
  invalidate(): void {
    this.cachedToken = undefined;
  }

  private async login(): Promise<string> {
    const roleId = this.configService.get<string>('VAULT_ROLE_ID');
    const secretId = this.configService.get<string>('VAULT_SECRET_ID');
    if (!roleId || !secretId) {
      throw new Error('VAULT_ROLE_ID and VAULT_SECRET_ID must be configured to use the did:algo registrar/issuer.');
    }
    const token = await this.vaultService.getTokenWithRole(roleId, secretId);
    this.cachedToken = token;
    this.logger.log('Acquired manager Vault token via AppRole login for OID4VC');
    return token;
  }
}

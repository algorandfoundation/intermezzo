import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosResponse } from 'axios';
import { HttpErrorByCode } from '@nestjs/common/utils/http-error-by-code.util';
import { UserInfoDto } from './user-info.dto';

export type KeyType = 'ed25519' | 'ecdsa-p256';
export type HashAlgorithm = 'sha2-256' | 'sha2-512';

@Injectable()
export class VaultService implements OnModuleInit, OnModuleDestroy {
  private serviceRoleId?: string;
  private serviceSecretId?: string;
  private cachedServiceToken?: string;
  private cachedServiceTokenExpiry?: number; // epoch ms
  private tokenRenewTimer?: NodeJS.Timeout;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Support both generic SERVICE_* names and Sponsor-specific names
    this.serviceRoleId =
      this.configService.get<string>('VAULT_SERVICE_ROLE_ID') || this.configService.get<string>('VAULT_SPONSOR_ROLE_ID');
    this.serviceSecretId =
      this.configService.get<string>('VAULT_SERVICE_SECRET_ID') || this.configService.get<string>('VAULT_SPONSOR_SECRET_ID');
    if (this.serviceRoleId && this.serviceSecretId) {
      try {
        await this.setupServiceToken();
        Logger.log('VaultService: service token initialized');
      } catch (err) {
        Logger.error('VaultService: failed to initialize service token', JSON.stringify(err));
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.tokenRenewTimer) clearTimeout(this.tokenRenewTimer);
  }

  /**
   *
   * @param token - personal access token
   * @returns
   */
  async authGithub(token: string): Promise<string> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const vaultNamespace: string = this.configService.get<string>('VAULT_NAMESPACE');

    let result: AxiosResponse;
    try {
      result = await this.httpService.axiosRef.post(
        `${baseUrl}/v1/auth/github/login`,
        {
          token: token,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
          },
        },
      );

      // log with stringify
      Logger.log('Github login result: ', JSON.stringify(result.data));
    } catch (error) {
      Logger.error('Failed to login with Personal Access Token', JSON.stringify(error));
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }
    const vault_token: string = result.data.auth.client_token;
    return vault_token;
  }

  async transitCreateKey(keyName: string, transitKeyPath: string, token: string): Promise<Buffer> {
    // https://developer.hashicorp.com/vault/api-docs/secret/transit#create-key
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');

    let result: AxiosResponse;

    const url: string = `${baseUrl}/v1/${transitKeyPath}/keys/${keyName}`;
    try {
      result = await this.httpService.axiosRef.post(
        url,
        {
          type: 'ed25519',
          derived: false,
          allow_deletion: false,
        },
        {
          headers: { 'X-Vault-Token': token },
        },
      );
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }

    const publicKeyBase64: string = result.data.data.keys['1'].public_key;
    return Buffer.from(publicKeyBase64, 'base64');
  }

  /**
   * Implicitly uses a (GET) HTTP request to retrieve the public key of a user from the vault.
   *
   * @param keyName - user id
   * @param transitKeyPath - path to the transit engine
   * @param token - vault token
   * @returns - public key of the user
   */
  async getKey(keyName: string, transitKeyPath: string, token: string): Promise<Buffer> {
    // https://developer.hashicorp.com/vault/api-docs/secret/transit#read-key
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const vaultNamespace: string = this.configService.get<string>('VAULT_NAMESPACE');

    let result: AxiosResponse;
    try {
      const url = `${baseUrl}/v1/${transitKeyPath}/keys/${keyName}`;
      Logger.log('getKey url: ', url);

      result = await this.httpService.axiosRef.get(url, {
        headers: {
          'X-Vault-Token': token,
          'Content-Type': 'application/json',
          ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
        },
      });
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }

    const publicKeyBase64: string = result.data.data.keys['1'].public_key;
    // return new AlgorandEncoder().encodeAddress(Buffer.from(publicKeyBase64, 'base64'));
    return Buffer.from(publicKeyBase64, 'base64');
  }

  public async sign(keyName: string, transitPath: string, data: Uint8Array, token: string): Promise<Buffer> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const vaultNamespace: string = this.configService.get<string>('VAULT_NAMESPACE');

    let result: AxiosResponse;
    try {
      result = await this.httpService.axiosRef.post(
        `${baseUrl}/v1/${transitPath}/sign/${keyName}`,
        {
          input: Buffer.from(data).toString('base64'),
        },
        {
          headers: {
            'X-Vault-Token': token,
            ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
          },
        },
      );
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }

    return result.data.data.signature;
  }

  /**
   *
   * @param roleId - Role ID of the AppRole
   * @param secretId - Secret ID of the AppRole
   * @returns - client token based on the AppRole
   * @throws - VaultException
   * @description - This method is used to authenticate with the Vault using AppRole authentication.
   * The AppRole authentication method is used to authenticate machines or applications that need to access the Vault.
   * The method takes the Role ID and Secret ID of the AppRole and returns a client token that can be used to access the Vault.
   * The client token is valid for a certain period of time and can be used to access the Vault until it expires.
   * The method uses the AppRole authentication endpoint of the Vault API to authenticate and retrieve the client token.
   * The method throws a VaultException if the authentication fails or if there is an error while communicating with the Vault.
   */
  async getTokenWithRole(roleId: string, secretId: string): Promise<string> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');

    let result: AxiosResponse;
    try {
      result = await this.httpService.axiosRef.post(`${baseUrl}/v1/auth/approle/login`, {
        role_id: roleId,
        secret_id: secretId,
      });
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }
    const token: string = result.data.auth.client_token;
    return token;
  }

  /**
   * Internal: perform AppRole login and return token + lease info.
   */
  private async appRoleLogin(roleId: string, secretId: string): Promise<{ token: string; leaseDuration?: number; renewable?: boolean }> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    let result: AxiosResponse;
    try {
      result = await this.httpService.axiosRef.post(`${baseUrl}/v1/auth/approle/login`, {
        role_id: roleId,
        secret_id: secretId,
      });
    } catch (error) {
      throw new HttpErrorByCode[error.response?.status]('VaultException');
    }
    const token: string = result.data.auth.client_token;
    const leaseDuration: number | undefined = result.data.auth.lease_duration;
    const renewable: boolean | undefined = result.data.auth.renewable;
    return { token, leaseDuration, renewable };
  }

  /**
   * Setup service token lifecycle: login and schedule renewals.
   */
  private async setupServiceToken(): Promise<void> {
    if (!this.serviceRoleId || !this.serviceSecretId) return;
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    try {
      const { token, leaseDuration } = await this.appRoleLogin(this.serviceRoleId, this.serviceSecretId);
      this.cachedServiceToken = token;
      if (leaseDuration && leaseDuration > 0) {
        // set expiry time
        this.cachedServiceTokenExpiry = Date.now() + leaseDuration * 1000;
        this.scheduleTokenRenewal(leaseDuration);
      } else {
        // fallback: renew every 45 minutes
        this.cachedServiceTokenExpiry = Date.now() + 45 * 60 * 1000;
        this.scheduleTokenRenewal(45 * 60);
      }
      Logger.log('VaultService: obtained service token');
    } catch (error) {
      Logger.error('VaultService: failed to obtain service token', JSON.stringify(error));
      throw error;
    }
  }

  private scheduleTokenRenewal(leaseDurationSeconds: number) {
    // Renew at 80% of lease duration
    const renewAfterMs = Math.max(30 * 1000, Math.floor(leaseDurationSeconds * 0.8) * 1000);
    if (this.tokenRenewTimer) clearTimeout(this.tokenRenewTimer);
    this.tokenRenewTimer = setTimeout(() => void this.renewServiceToken(), renewAfterMs);
  }

  private async renewServiceToken(): Promise<void> {
    if (!this.cachedServiceToken) {
      // attempt fresh login
      await this.setupServiceToken();
      return;
    }
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    try {
      const result = await this.httpService.axiosRef.post(
        `${baseUrl}/v1/auth/token/renew-self`,
        {},
        { headers: { 'X-Vault-Token': this.cachedServiceToken } },
      );
      const leaseDuration: number | undefined = result.data.auth?.lease_duration;
      if (leaseDuration && leaseDuration > 0) {
        this.cachedServiceTokenExpiry = Date.now() + leaseDuration * 1000;
        this.scheduleTokenRenewal(leaseDuration);
        Logger.log('VaultService: renewed service token');
        return;
      }
    } catch (err) {
      Logger.warn('VaultService: token renewal failed, attempting re-login');
    }

    // If renewal failed, re-login with AppRole
    try {
      await this.setupServiceToken();
      Logger.log('VaultService: re-logged service token after renewal failure');
    } catch (err) {
      Logger.error('VaultService: failed re-login after renewal failure', JSON.stringify(err));
    }
  }

  /**
   * Return cached service token, logging in if missing/expired.
   */
  async getServiceToken(): Promise<string> {
    if (this.cachedServiceToken && (!this.cachedServiceTokenExpiry || Date.now() < this.cachedServiceTokenExpiry)) {
      return this.cachedServiceToken;
    }
    // lazy init using configured service role
    this.serviceRoleId =
      this.serviceRoleId || this.configService.get<string>('VAULT_SERVICE_ROLE_ID') || this.configService.get<string>('VAULT_SPONSOR_ROLE_ID');
    this.serviceSecretId =
      this.serviceSecretId || this.configService.get<string>('VAULT_SERVICE_SECRET_ID') || this.configService.get<string>('VAULT_SPONSOR_SECRET_ID');
    if (!this.serviceRoleId || !this.serviceSecretId) throw new Error('Service AppRole not configured');
    await this.setupServiceToken();
    if (!this.cachedServiceToken) throw new Error('Failed to obtain service token');
    return this.cachedServiceToken;
  }

  async checkToken(token: string): Promise<boolean> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');

    try {
      await this.httpService.axiosRef.get(`${baseUrl}/v1/auth/token/lookup-self`, {
        headers: { 'X-Vault-Token': token },
      });
      return true;
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }
  }

  async signAsUser(user_id: string, data: Uint8Array, token: string): Promise<Buffer> {
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');

    return this.sign(user_id, transitKeyPath, data, token);
  }

  async signAsManager(data: Uint8Array, token: string): Promise<Buffer> {
    const manager_id = this.configService.get('VAULT_MANAGER_KEY');
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_MANAGERS_PATH');

    return this.sign(manager_id, transitKeyPath, data, token);
  }

  async getUserPublicKey(keyName: string, token: string): Promise<Buffer> {
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');

    return this.getKey(keyName, transitKeyPath, token);
  }

  async getManagerPublicKey(token: string): Promise<Buffer> {
    const manager_id = this.configService.get('VAULT_MANAGER_KEY');
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_MANAGERS_PATH');

    return this.getKey(manager_id, transitKeyPath, token);
  }

  /**
   * Expecting a manager token to retrieve all keys from the vault and return an array of user objects including
   * it's user id and public address.
   *
   * @param token - manager token
   * @returns
   */
  async getKeys(token: string): Promise<UserInfoDto[]> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');

    let result: AxiosResponse;

    try {
      // method LIST
      result = await this.httpService.axiosRef.request({
        url: `${baseUrl}/v1/${transitKeyPath}/keys`,
        method: 'LIST',
        headers: { 'X-Vault-Token': token },
      });
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }

    const users: string[] = result.data.data.keys;

    // for each add the public address to an array of user object (id, public address)
    const usersObjs: UserInfoDto[] = [];
    for (let i = 0; i < users.length; i++) {
      const userObj = {
        public_address: (await this.getKey(users[i], transitKeyPath, token)).toString('base64'), // TODO: rename public_address that is actually the public key in base64 format
        user_id: users[i],
      };
      usersObjs.push(userObj);
    }

    return usersObjs;
  }
}

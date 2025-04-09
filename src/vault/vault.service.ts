import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosResponse } from 'axios';
import { HttpErrorByCode } from '@nestjs/common/utils/http-error-by-code.util';
import { UserInfoDto } from './user-info.dto';

export type KeyType = 'ed25519' | 'ecdsa-p256';
export type HashAlgorithm = 'sha2-256' | 'sha2-512';

@Injectable()
export class VaultService {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

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
    }
    catch (error) {
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
    return Buffer.from(publicKeyBase64, 'base64')
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
    return Buffer.from(publicKeyBase64, 'base64')
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

    return result.data.data.signature
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
      result = await this.httpService.axiosRef.post(
        `${baseUrl}/v1/auth/approle/login`,
        {
          role_id: roleId,
          secret_id: secretId,
        },
      );
    }
    catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }
    const token: string = result.data.auth.client_token;
    return token;
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
    let usersObjs: UserInfoDto[] = [];
    for (let i = 0; i < users.length; i++) {
      let userObj = {
        user_id: users[i],
        public_address: (await this.getKey(users[i], transitKeyPath, token)).toString('base64'),
      };
      usersObjs.push(userObj);
    }

    return usersObjs;
  }
}

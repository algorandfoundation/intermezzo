import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosResponse } from 'axios';
import { AlgorandEncoder } from '@algorandfoundation/algo-models';
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

  async transitCreateKey(keyName: string, transitKeyPath: string, token: string): Promise<string> {
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
    return new AlgorandEncoder().encodeAddress(Buffer.from(publicKeyBase64, 'base64'));
  }

  /**
   * Implicitly uses a (GET) HTTP request to retrieve the public key of a user from the vault.
   *
   * @param keyName - user id
   * @param transitKeyPath - path to the transit engine
   * @param token - vault token
   * @returns - public Algorand address of the user
   */
  private async _transitGetKey(keyName: string, transitKeyPath: string, token: string): Promise<string> {
    // https://developer.hashicorp.com/vault/api-docs/secret/transit#read-key
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');

    let result: AxiosResponse;
    try {
      result = await this.httpService.axiosRef.get(`${baseUrl}/v1/${transitKeyPath}/keys/${keyName}`, {
        headers: { 'X-Vault-Token': token },
      });
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }

    const publicKeyBase64: string = result.data.data.keys['1'].public_key;
    return new AlgorandEncoder().encodeAddress(Buffer.from(publicKeyBase64, 'base64'));
  }

  private async _sign(keyName: string, transitPath: string, data: Uint8Array, token: string): Promise<Uint8Array> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');

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
          },
        },
      );
    } catch (error) {
      throw new HttpErrorByCode[error.response.status]('VaultException');
    }

    const sig: string = result.data.data.signature.toString();
    // split vault specific prefixes vault:${version}:signature
    const signature = sig.split(':')[2];
    // vault default base64 decode
    const decoded: Buffer = Buffer.from(signature, 'base64');
    // return as Uint8Array
    return new Uint8Array(decoded);
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

  async signAsUser(user_id: string, data: Uint8Array, token: string): Promise<Uint8Array> {
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');

    return this._sign(user_id, transitKeyPath, data, token);
  }

  async signAsManager(data: Uint8Array, token: string): Promise<Uint8Array> {
    const manager_id = this.configService.get('VAULT_MANAGER_KEY');
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_MANAGERS_PATH');

    return this._sign(manager_id, transitKeyPath, data, token);
  }

  async getUserPublicAddress(keyName: string, token: string): Promise<string> {
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');

    return this._transitGetKey(keyName, transitKeyPath, token);
  }

  async getManagerPublicAddress(token: string): Promise<string> {
    const manager_id = this.configService.get('VAULT_MANAGER_KEY');
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_MANAGERS_PATH');

    return this._transitGetKey(manager_id, transitKeyPath, token);
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
        public_address: await this._transitGetKey(users[i], transitKeyPath, token),
      };
      usersObjs.push(userObj);
    }

    return usersObjs;
  }
}

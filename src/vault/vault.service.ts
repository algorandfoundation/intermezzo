import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosResponse } from 'axios';
import { HttpErrorByCode } from '@nestjs/common/utils/http-error-by-code.util';
import { UserInfoDto } from './user-info.dto';

export type KeyType = 'ed25519' | 'ecdsa-p256';
export type HashAlgorithm = 'sha2-256' | 'sha2-512';

/**
 * A Falcon-1024 key as held by the `algorand-pq` secrets engine.
 *
 * `salt` is not decoration: the Algorand PQ address digest is
 * `SHA512-256("PQA" || scheme || salt || pk)`, and one public key can
 * control up to 256 addresses, so the salt has to travel with the key
 * for the address to be reproducible.
 */
export type PqKey = {
  scheme: string;
  salt: number;
  publicKey: Buffer;
  address: string;
};

/** The legacy shape returned by `getKeys`: public keys are base64 encoded. */
export type TransitUserKey = Pick<UserInfoDto, 'user_id' | 'public_address'>;

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

  // ────────────────────────────────────────────────────────────────
  // Algorand PQ (Falcon-1024) secrets engine
  //
  // Backed by the custom `algorand-pq` plugin in `vault/plugin`,
  // whose API deliberately mirrors transit so these wrappers keep the
  // same shape as their ed25519 siblings above. Two differences are
  // real and intentional:
  //
  //   - Signatures come back raw. There is no `vault:v1:` envelope to
  //     split, so `decodeVaultSignature` (which asserts a 64-byte
  //     ed25519 length) must never see one of these.
  //   - A missing key is an answer, not an error. The account-type
  //     probe reads a 404 from `pqGetKey` as "not a PQ account", so
  //     that method returns `undefined` where transit's `getKey`
  //     throws.
  //
  // The mount defaults to `pawn/pq-users` (what `development-init.ts`
  // mounts) and can be overridden with `VAULT_PQ_USERS_PATH`.
  // ────────────────────────────────────────────────────────────────

  private getPqMount(): string {
    return this.configService.get<string>('VAULT_PQ_USERS_PATH') ?? 'pawn/pq-users';
  }

  /**
   * Single request path for the PQ engine. Returns the inner `data`
   * object, or `undefined` when Vault answers 404 — callers that
   * cannot treat a miss as an answer turn that back into a throw.
   */
  private async pqRequest(
    method: 'GET' | 'POST' | 'LIST',
    path: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<any | undefined> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const vaultNamespace: string = this.configService.get<string>('VAULT_NAMESPACE');

    try {
      const result: AxiosResponse = await this.httpService.axiosRef.request({
        url: `${baseUrl}/v1/${this.getPqMount()}/${path}`,
        method,
        ...(body ? { data: body } : {}),
        headers: {
          'X-Vault-Token': token,
          ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
        },
      });
      return result.data.data;
    } catch (error) {
      const status = error?.response?.status ?? 500;
      if (status === 404) return undefined;
      throw new HttpErrorByCode[status]('VaultException');
    }
  }

  private static toPqKey(data: any): PqKey {
    return {
      scheme: data.scheme,
      salt: data.salt,
      publicKey: Buffer.from(data.public_key, 'base64'),
      address: data.address,
    };
  }

  /**
   * Idempotently create a Falcon-1024 key. Re-creating an existing
   * key returns the key that is already stored rather than rotating
   * it, matching the transit engine's `allow_deletion: false` usage.
   */
  async pqCreateKey(keyName: string, token: string): Promise<PqKey> {
    const data = await this.pqRequest('POST', `keys/${keyName}`, token, {});
    if (!data) throw new HttpErrorByCode[404]('VaultException');

    return VaultService.toPqKey(data);
  }

  /**
   * Read a Falcon-1024 key, or `undefined` when the key does not
   * exist. The miss is load-bearing: it is how a caller learns that a
   * `user_id` is not a PQ account.
   */
  async pqGetKey(keyName: string, token: string): Promise<PqKey | undefined> {
    const data = await this.pqRequest('GET', `keys/${keyName}`, token);

    return data ? VaultService.toPqKey(data) : undefined;
  }

  /**
   * Falcon-sign raw bytes. As with transit, the caller owns any
   * domain prefix (`"TX"` for transactions) — this signs exactly the
   * bytes it is given and returns the compressed signature.
   */
  async pqSign(keyName: string, data: Uint8Array, token: string): Promise<Buffer> {
    const result = await this.pqRequest('POST', `sign/${keyName}`, token, {
      input: Buffer.from(data).toString('base64'),
    });
    if (!result) throw new HttpErrorByCode[404]('VaultException');

    return Buffer.from(result.signature, 'base64');
  }

  /**
   * List PQ key names. An unmounted or empty engine lists as `[]` so
   * callers can merge this with the transit listing unconditionally.
   */
  async pqListKeys(token: string): Promise<string[]> {
    const data = await this.pqRequest('LIST', 'keys', token);

    return data?.keys ?? [];
  }

  // ────────────────────────────────────────────────────────────────
  // KV v2 helpers
  //
  // Small, generic wrappers around Vault's KV-v2 secret engine so
  // host modules can persist non-secret operational state (app ids,
  // single-use challenges, etc.) alongside the existing key material
  // instead of reaching for a side database or the `.env` file.
  //
  // The mount path defaults to `secret` (Vault dev/prod default
  // mount for KV v2) and can be overridden with `VAULT_KV_MOUNT`.
  // All keys are scoped under a caller-supplied path; callers are
  // expected to namespace them (e.g. `intermezzo/manager/app-id`).
  // ────────────────────────────────────────────────────────────────

  private getKvMount(): string {
    return this.configService.get<string>('VAULT_KV_MOUNT') ?? 'secret';
  }

  /**
   * Read a KV-v2 entry at `path` (relative to the configured mount).
   * Returns `undefined` when the entry does not exist (404) or has
   * been soft-deleted; throws on any other error.
   */
  async kvRead<T extends Record<string, unknown> = Record<string, unknown>>(
    path: string,
    token: string,
  ): Promise<T | undefined> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const vaultNamespace: string = this.configService.get<string>('VAULT_NAMESPACE');
    const mount = this.getKvMount();
    const url = `${baseUrl}/v1/${mount}/data/${path}`;
    try {
      const result = await this.httpService.axiosRef.get(url, {
        headers: {
          'X-Vault-Token': token,
          ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
        },
      });
      const data = result.data?.data?.data;
      // KV-v2 returns `data: null` for soft-deleted versions.
      return (data ?? undefined) as T | undefined;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 404) return undefined;
      throw new HttpErrorByCode[status ?? 500]('VaultException');
    }
  }

  /**
   * Write a KV-v2 entry at `path` (creates a new version on update).
   */
  async kvWrite(path: string, data: Record<string, unknown>, token: string): Promise<void> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const vaultNamespace: string = this.configService.get<string>('VAULT_NAMESPACE');
    const mount = this.getKvMount();
    const url = `${baseUrl}/v1/${mount}/data/${path}`;
    try {
      await this.httpService.axiosRef.post(
        url,
        { data },
        {
          headers: {
            'X-Vault-Token': token,
            'Content-Type': 'application/json',
            ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
          },
        },
      );
    } catch (error) {
      const status = error?.response?.status ?? 500;
      throw new HttpErrorByCode[status]('VaultException');
    }
  }

  /**
   * Permanently delete every version of a KV-v2 entry at `path`. Used
   * for short-lived state (e.g. single-use attestation challenges)
   * where soft-delete semantics are undesirable.
   */
  async kvDelete(path: string, token: string): Promise<void> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const vaultNamespace: string = this.configService.get<string>('VAULT_NAMESPACE');
    const mount = this.getKvMount();
    const url = `${baseUrl}/v1/${mount}/metadata/${path}`;
    try {
      await this.httpService.axiosRef.delete(url, {
        headers: {
          'X-Vault-Token': token,
          ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
        },
      });
    } catch (error) {
      const status = error?.response?.status;
      if (status === 404) return;
      throw new HttpErrorByCode[status ?? 500]('VaultException');
    }
  }

  /**
   * List immediate child keys of a KV-v2 folder at `path`. Returns
   * an empty array when the folder is missing.
   */
  async kvList(path: string, token: string): Promise<string[]> {
    const baseUrl: string = this.configService.get<string>('VAULT_BASE_URL');
    const vaultNamespace: string = this.configService.get<string>('VAULT_NAMESPACE');
    const mount = this.getKvMount();
    const url = `${baseUrl}/v1/${mount}/metadata/${path}`;
    try {
      const result = await this.httpService.axiosRef.request({
        url,
        method: 'LIST',
        headers: {
          'X-Vault-Token': token,
          ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
        },
      });
      return (result.data?.data?.keys ?? []) as string[];
    } catch (error) {
      const status = error?.response?.status;
      if (status === 404) return [];
      throw new HttpErrorByCode[status ?? 500]('VaultException');
    }
  }

  /**
   * Expecting a manager token to retrieve all keys from the vault and return an array of user objects including
   * it's user id and public address.
   *
   * Lists both user mounts, since a `user_id` lives in exactly one of
   * them and the caller should not have to know which.
   *
   * @param token - manager token
   * @returns
   */
  async getKeys(token: string): Promise<TransitUserKey[]> {
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
      const status = error?.response?.status ?? 500;
      // Vault answers LIST on an empty mount with a 404. Treating that
      // as "no ed25519 users" rather than an error matters now that a
      // deployment can hold PQ users and no transit ones at all.
      if (status !== 404) throw new HttpErrorByCode[status]('VaultException');
    }

    const users: string[] = result?.data?.data?.keys ?? [];

    // Preserve the original service contract: despite the historical field
    // name, `public_address` contains the transit public key in base64.
    const usersObjs: TransitUserKey[] = [];
    for (let i = 0; i < users.length; i++) {
      const userObj: TransitUserKey = {
        public_address: (await this.getKey(users[i], transitKeyPath, token)).toString('base64'),
        user_id: users[i],
      };
      usersObjs.push(userObj);
    }

    return usersObjs;
  }

  /**
   * Return normalized PQ users separately from the legacy transit listing.
   * WalletService combines the two only after the caller has passed the
   * original transit LIST authorization check.
   */
  async getPqUsers(token: string): Promise<UserInfoDto[]> {
    const users: UserInfoDto[] = [];
    for (const name of await this.pqListKeys(token)) {
      const key = await this.pqGetKey(name, token);
      if (!key) continue; // deleted between LIST and read
      users.push({ user_id: name, public_address: key.address, account_type: 'falcon1024' });
    }

    return users;
  }
}

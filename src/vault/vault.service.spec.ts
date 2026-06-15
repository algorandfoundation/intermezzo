import { VaultService } from './vault.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Axios, AxiosResponse } from 'axios';
import { randomBytes } from 'crypto';
import { HttpErrorByCode } from '@nestjs/common/utils/http-error-by-code.util';
import createMockInstance from 'jest-create-mock-instance';
import { UserInfoDto } from './user-info.dto';

describe('VaultService', () => {
  let vaultService: VaultService;
  let httpService: HttpService;
  let configService: ConfigService;

  beforeAll(async () => {
    vaultService = createMockInstance(VaultService);
    configService = createMockInstance(ConfigService);
    httpService = createMockInstance(HttpService);

    Object.defineProperty(httpService, 'axiosRef', {
      value: createMockInstance(Axios),
    });
  });

  beforeEach(() => {
    jest.resetAllMocks();

    vaultService = new VaultService(httpService, configService);
  });

  describe('authGithub', () => {
    it('\(OK) should be able to use personal access token to auth', async () => {
      const personal_token: string = 'personal_token';
      const baseUrl: string = 'http://vault';

      (configService.get as jest.Mock).mockReturnValueOnce(baseUrl);
      (httpService.axiosRef.post as jest.Mock).mockResolvedValueOnce({
        data: {
          auth: {
            client_token: 'vault_token',
          },
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: {} as any },
      } as AxiosResponse);

      const result: string = await vaultService.authGithub(personal_token);
      expect(httpService.axiosRef.post).toHaveBeenCalledWith(
        `${baseUrl}/v1/auth/github/login`,
        { token: personal_token },
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
      expect(result).toEqual('vault_token');
    });

    it('\(FAIL) should throw error when auth fails', async () => {
      const personal_token: string = 'personal_token';
      const baseUrl: string = 'http://vault';

      (configService.get as jest.Mock).mockReturnValueOnce(baseUrl);
      (httpService.axiosRef.post as jest.Mock).mockRejectedValueOnce({
        response: { status: 401 },
      });

      await expect(vaultService.authGithub(personal_token)).rejects.toThrow(HttpErrorByCode[401]);
      expect(httpService.axiosRef.post).toHaveBeenCalledWith(
        `${baseUrl}/v1/auth/github/login`,
        { token: personal_token },
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });
  });

  describe('checkToken', () => {
    it('should return true when token is valid', async () => {
      const baseUrl = 'http://vault';
      (configService.get as jest.Mock).mockReturnValue(baseUrl);
      (httpService.axiosRef.get as jest.Mock).mockResolvedValue({
        data: {},
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: {} as any },
      } as AxiosResponse);

      const result = await vaultService.checkToken('valid-token');

      expect(httpService.axiosRef.get).toHaveBeenCalledWith(`${baseUrl}/v1/auth/token/lookup-self`, {
        headers: { 'X-Vault-Token': 'valid-token' },
      });
      expect(result).toBe(true);
    });

    it('should throw error when token is invalid', async () => {
      const baseUrl = 'http://vault';
      (configService.get as jest.Mock).mockReturnValue(baseUrl);
      const error = { response: { status: 401 } };
      (httpService.axiosRef.get as jest.Mock).mockRejectedValue(error);

      await expect(vaultService.checkToken('invalid-token')).rejects.toThrow(HttpErrorByCode[401]);
    });
  });

  describe('getKeys()', () => {
    it('(\OK) should return an array of keys', async () => {
      const baseUrl = 'http://vault';
      (configService.get as jest.Mock).mockReturnValueOnce(baseUrl);

      const keysPath = 'transit/users';
      (configService.get as jest.Mock).mockReturnValueOnce(keysPath);

      (configService.get as jest.Mock).mockReturnValueOnce(baseUrl);
      (configService.get as jest.Mock).mockReturnValueOnce(baseUrl);

      const key1: Buffer = randomBytes(32);

      const axiosResponse: AxiosResponse = {
        data: {
          data: {
            keys: ['user-key1', 'user-key2'],
          },
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: {} as any },
      };

      (httpService.axiosRef.request as jest.Mock).mockResolvedValueOnce(axiosResponse);

      // mock two calls for get keys
      (httpService.axiosRef.get as jest.Mock).mockResolvedValue({
        data: {
          data: {
            keys: {
              '1': { public_key: key1.toString('base64') },
            },
          },
        },
      });

      const result: UserInfoDto[] = await vaultService.getKeys('token');

      expect(httpService.axiosRef.request).toHaveBeenCalledWith({
        method: 'LIST',
        url: `${baseUrl}/v1/transit/users/keys`,
        headers: { 'X-Vault-Token': 'token' },
      });

      expect(result).toEqual([
        {
          user_id: 'user-key1',
          public_address: key1.toString('base64'),
        },
        {
          user_id: 'user-key2',
          public_address: key1.toString('base64'),
        },
      ]);
    });
  });

  describe('getUserPublicKey (using _transitCreateKey)', () => {
    it('should create key and return encoded public key', async () => {
      const baseUrl = 'http://vault';
      const transitPath = 'transit/path';
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'VAULT_BASE_URL') return baseUrl;
        if (key === 'VAULT_TRANSIT_USERS_PATH') return transitPath;
      });

      // Use a fake public key that matches what you expect (e.g. "managerPublicKey").
      const publicKey: Buffer = randomBytes(32);
      const base64PublicKey = Buffer.from(publicKey).toString('base64');
      const axiosResponse: AxiosResponse = {
        data: {
          data: {
            keys: {
              '1': { public_key: base64PublicKey },
            },
          },
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: {} as any },
      };

      (httpService.axiosRef.get as jest.Mock).mockResolvedValue(axiosResponse);

      const result: Buffer = await vaultService.getUserPublicKey('user-key', 'valid-token');

      expect(httpService.axiosRef.get).toHaveBeenCalledWith(`${baseUrl}/v1/${transitPath}/keys/user-key`, {
        headers: {
          'X-Vault-Token': 'valid-token',
          'Content-Type': 'application/json',
        },
      });
      expect(result.toString('base64')).toEqual(publicKey.toString('base64'));
    });

    it('\(FAIL) should throw 403 when lacking permissions', async () => {
      const baseUrl = 'http://vault';
      const transitPath = 'transit/path';
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'VAULT_BASE_URL') return baseUrl;
        if (key === 'VAULT_TRANSIT_USERS_PATH') return transitPath;
      });
      const error = { response: { status: 403 } };
      (httpService.axiosRef.get as jest.Mock).mockRejectedValue(error);

      // check code to be 403
      await expect(vaultService.getUserPublicKey('user-key', 'token')).rejects.toThrow(HttpErrorByCode[403]);
    });
  });

  describe('signAsUser (using _sign)', () => {
    it('should sign data and return a Uint8Array signature', async () => {
      const transitPath = 'transit/users';
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'VAULT_TRANSIT_USERS_PATH') return transitPath;
      });
      const fakeData = new Uint8Array([1, 2, 3]);
      // Construct a signature string in the expected vault format: "vault:<version>:<base64-signature>"
      const rawSignature = 'signature';
      const signatureBase64 = Buffer.from(rawSignature).toString('base64');
      const vaultSignature = `vault:1:${signatureBase64}`;
      const axiosResponse: AxiosResponse = {
        data: { data: { signature: vaultSignature } },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: {} as any },
      };
      (httpService.axiosRef.post as jest.Mock).mockResolvedValueOnce(axiosResponse);

      const result = await vaultService.signAsUser('user-key', fakeData, 'token');

      expect(httpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining(`${transitPath}/sign/user-key`),
        { input: Buffer.from(fakeData).toString('base64') },
        { headers: { 'X-Vault-Token': 'token' } },
      );
      expect(result).toEqual(vaultSignature);
    });

    it('should throw UnauthorizedException when vault returns 401 in _sign', async () => {
      const transitPath = 'transit/users';
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'VAULT_TRANSIT_USERS_PATH') return transitPath;
      });
      const error = { response: { status: 401 } };
      (httpService.axiosRef.post as jest.Mock).mockRejectedValue(error);

      const fakeData = new Uint8Array([1, 2, 3]);
      await expect(vaultService.signAsUser('user-key', fakeData, 'token')).rejects.toThrow(HttpErrorByCode[401]);
    });
  });

  describe('signAsManager', () => {
    it('should sign data for manager and return a Uint8Array signature', async () => {
      const transitPath = 'transit/managers';
      const managerId = 'manager-key';
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'VAULT_TRANSIT_MANAGERS_PATH') return transitPath;
        if (key === 'VAULT_MANAGER_KEY') return managerId;
      });
      const fakeData = new Uint8Array([4, 5, 6]);
      const rawSignature = 'managerSignature';
      const signatureBase64 = Buffer.from(rawSignature).toString('base64');
      const vaultSignature = `vault:1:${signatureBase64}`;
      const axiosResponse: AxiosResponse = {
        data: { data: { signature: vaultSignature } },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: {} as any },
      };
      (httpService.axiosRef.post as jest.Mock).mockResolvedValueOnce(axiosResponse);

      const result = await vaultService.signAsManager(fakeData, 'token');

      expect(httpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining(`${transitPath}/sign/${managerId}`),
        { input: Buffer.from(fakeData).toString('base64') },
        { headers: { 'X-Vault-Token': 'token' } },
      );
      expect(result).toEqual(vaultSignature);
    });

    it('should throw InternalServerErrorException for unknown error in _sign (manager)', async () => {
      const transitPath = 'transit/managers';
      const managerId = 'manager-key';
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'VAULT_TRANSIT_MANAGERS_PATH') return transitPath;
        if (key === 'VAULT_MANAGER_KEY') return managerId;
      });
      const error = { response: { status: 500 } };
      (httpService.axiosRef.post as jest.Mock).mockRejectedValue(error);

      const fakeData = new Uint8Array([4, 5, 6]);
      await expect(vaultService.signAsManager(fakeData, 'token')).rejects.toThrow(HttpErrorByCode[500]);
    });
  });

  describe('getManagerPublicKey', () => {
    it('should create key for manager and return encoded public key', async () => {
      const baseUrl = 'http://vault';
      const transitPath = 'transit/managers';
      const managerId = 'manager-key';
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'VAULT_BASE_URL') return baseUrl;
        if (key === 'VAULT_TRANSIT_MANAGERS_PATH') return transitPath;
        if (key === 'VAULT_MANAGER_KEY') return managerId;
      });

      const fakePublicKey = 'managerPublicKey';
      const fakePublicKeyBase64 = Buffer.from(fakePublicKey).toString('base64');
      const axiosResponse: AxiosResponse = {
        data: {
          data: {
            keys: {
              '1': { public_key: fakePublicKeyBase64 },
            },
          },
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: {} as any },
      };
      (httpService.axiosRef.get as jest.Mock).mockResolvedValue(axiosResponse);

      const result = await vaultService.getManagerPublicKey('token');

      expect(httpService.axiosRef.get).toHaveBeenCalledWith(`${baseUrl}/v1/${transitPath}/keys/${managerId}`, {
        headers: {
          'X-Vault-Token': 'token',
          'Content-Type': 'application/json',
        },
      });
      expect(result.toString('base64')).toBe(fakePublicKeyBase64);
    });
  });

  describe('kv helpers', () => {
    const baseUrl = 'http://vault';
    const defaultMount = 'secret';

    const configWith = (overrides: Record<string, string | undefined> = {}) => {
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'VAULT_BASE_URL') return baseUrl;
        if (key in overrides) return overrides[key];
        return undefined;
      });
    };

    describe('kvRead', () => {
      it('(OK) should return the inner data payload', async () => {
        configWith();
        const payload = { appId: '123' };
        (httpService.axiosRef.get as jest.Mock).mockResolvedValueOnce({
          data: { data: { data: payload } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: { headers: {} as any },
        } as AxiosResponse);

        const result = await vaultService.kvRead('intermezzo/manager/app-id', 'token');

        expect(httpService.axiosRef.get).toHaveBeenCalledWith(
          `${baseUrl}/v1/${defaultMount}/data/intermezzo/manager/app-id`,
          { headers: { 'X-Vault-Token': 'token' } },
        );
        expect(result).toEqual(payload);
      });

      it('(OK) should honor VAULT_KV_MOUNT and VAULT_NAMESPACE overrides', async () => {
        configWith({ VAULT_KV_MOUNT: 'kv', VAULT_NAMESPACE: 'tenant-a' });
        (httpService.axiosRef.get as jest.Mock).mockResolvedValueOnce({
          data: { data: { data: { ok: true } } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: { headers: {} as any },
        } as AxiosResponse);

        await vaultService.kvRead('foo/bar', 'token');

        expect(httpService.axiosRef.get).toHaveBeenCalledWith(`${baseUrl}/v1/kv/data/foo/bar`, {
          headers: { 'X-Vault-Token': 'token', 'X-Vault-Namespace': 'tenant-a' },
        });
      });

      it('(OK) should return undefined when payload is soft-deleted (data: null)', async () => {
        configWith();
        (httpService.axiosRef.get as jest.Mock).mockResolvedValueOnce({
          data: { data: { data: null } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: { headers: {} as any },
        } as AxiosResponse);

        const result = await vaultService.kvRead('foo', 'token');
        expect(result).toBeUndefined();
      });

      it('(OK) should return undefined on 404', async () => {
        configWith();
        (httpService.axiosRef.get as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });

        const result = await vaultService.kvRead('missing', 'token');
        expect(result).toBeUndefined();
      });

      it('(FAIL) should throw HttpErrorByCode on non-404 errors', async () => {
        configWith();
        (httpService.axiosRef.get as jest.Mock).mockRejectedValue({ response: { status: 500 } });

        await expect(vaultService.kvRead('foo', 'token')).rejects.toThrow(HttpErrorByCode[500]);
        await expect(vaultService.kvRead('foo', 'token')).rejects.toThrow('VaultException');
      });
    });

    describe('kvWrite', () => {
      it('(OK) should POST the data wrapped under `data`', async () => {
        configWith();
        (httpService.axiosRef.post as jest.Mock).mockResolvedValueOnce({
          data: {},
          status: 200,
          statusText: 'OK',
          headers: {},
          config: { headers: {} as any },
        } as AxiosResponse);

        await vaultService.kvWrite('intermezzo/manager/app-id', { appId: '123' }, 'token');

        expect(httpService.axiosRef.post).toHaveBeenCalledWith(
          `${baseUrl}/v1/${defaultMount}/data/intermezzo/manager/app-id`,
          { data: { appId: '123' } },
          {
            headers: {
              'X-Vault-Token': 'token',
              'Content-Type': 'application/json',
            },
          },
        );
      });

      it('(FAIL) should throw HttpErrorByCode when vault rejects the write', async () => {
        configWith();
        (httpService.axiosRef.post as jest.Mock).mockRejectedValueOnce({ response: { status: 403 } });

        await expect(vaultService.kvWrite('foo', { x: 1 }, 'token')).rejects.toThrow(HttpErrorByCode[403]);
      });
    });

    describe('kvDelete', () => {
      it('(OK) should DELETE the metadata endpoint', async () => {
        configWith();
        (httpService.axiosRef.delete as jest.Mock).mockResolvedValueOnce({
          data: {},
          status: 204,
          statusText: 'No Content',
          headers: {},
          config: { headers: {} as any },
        } as AxiosResponse);

        await vaultService.kvDelete('intermezzo/challenges/abc', 'token');

        expect(httpService.axiosRef.delete).toHaveBeenCalledWith(
          `${baseUrl}/v1/${defaultMount}/metadata/intermezzo/challenges/abc`,
          { headers: { 'X-Vault-Token': 'token' } },
        );
      });

      it('(OK) should swallow 404 (already-gone is success)', async () => {
        configWith();
        (httpService.axiosRef.delete as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });

        await expect(vaultService.kvDelete('missing', 'token')).resolves.toBeUndefined();
      });

      it('(FAIL) should throw HttpErrorByCode on non-404 errors', async () => {
        configWith();
        (httpService.axiosRef.delete as jest.Mock).mockRejectedValueOnce({ response: { status: 500 } });

        await expect(vaultService.kvDelete('foo', 'token')).rejects.toThrow(HttpErrorByCode[500]);
      });
    });

    describe('kvList', () => {
      it('(OK) should return the array of immediate child keys', async () => {
        configWith();
        (httpService.axiosRef.request as jest.Mock).mockResolvedValueOnce({
          data: { data: { keys: ['a', 'b', 'c'] } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: { headers: {} as any },
        } as AxiosResponse);

        const result = await vaultService.kvList('intermezzo/challenges', 'token');

        expect(httpService.axiosRef.request).toHaveBeenCalledWith({
          url: `${baseUrl}/v1/${defaultMount}/metadata/intermezzo/challenges`,
          method: 'LIST',
          headers: { 'X-Vault-Token': 'token' },
        });
        expect(result).toEqual(['a', 'b', 'c']);
      });

      it('(OK) should return [] on 404', async () => {
        configWith();
        (httpService.axiosRef.request as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });

        const result = await vaultService.kvList('missing', 'token');
        expect(result).toEqual([]);
      });

      it('(FAIL) should throw HttpErrorByCode on non-404 errors', async () => {
        configWith();
        (httpService.axiosRef.request as jest.Mock).mockRejectedValueOnce({ response: { status: 500 } });

        await expect(vaultService.kvList('foo', 'token')).rejects.toThrow(HttpErrorByCode[500]);
      });
    });
  });
});

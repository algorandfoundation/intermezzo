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

  const BASE_URL = 'http://vault';

  // jest-create-mock-instance builds its mocks on a private ModuleMocker that
  // jest.resetAllMocks() does not reach, so the mocks are recreated per test to
  // keep call history and queued responses from leaking between tests.
  beforeEach(() => {
    configService = createMockInstance(ConfigService);
    httpService = createMockInstance(HttpService);
    Object.defineProperty(httpService, 'axiosRef', { value: createMockInstance(Axios) });

    vaultService = new VaultService(httpService, configService);
  });

  /** Stubs configService.get by key. VAULT_BASE_URL is always set. */
  const configWith = (overrides: Record<string, string | undefined> = {}) => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'VAULT_BASE_URL') return BASE_URL;
      if (key in overrides) return overrides[key];
      return undefined;
    });
  };

  const okResponse = (data: unknown): AxiosResponse =>
    ({ data, status: 200, statusText: 'OK', headers: {}, config: { headers: {} as any } }) as AxiosResponse;

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
      configWith();
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
      configWith();
      const error = { response: { status: 401 } };
      (httpService.axiosRef.get as jest.Mock).mockRejectedValue(error);

      await expect(vaultService.checkToken('invalid-token')).rejects.toThrow(HttpErrorByCode[401]);
    });
  });

  describe('getTokenWithRole', () => {
    it('(OK) should return the client token from an AppRole login', async () => {
      configWith();
      (httpService.axiosRef.post as jest.Mock).mockResolvedValueOnce(okResponse({ auth: { client_token: 'token' } }));

      await expect(vaultService.getTokenWithRole('role', 'secret')).resolves.toEqual('token');
    });

    it('(FAIL) should throw 401 when Vault rejects the AppRole credentials', async () => {
      configWith();
      (httpService.axiosRef.post as jest.Mock).mockRejectedValueOnce({ response: { status: 401 } });

      await expect(vaultService.getTokenWithRole('role', 'secret')).rejects.toThrow(HttpErrorByCode[401]);
    });
  });

  describe('getKeys()', () => {
    it('(\OK) should return an array of keys', async () => {
      const baseUrl = 'http://vault';
      const keysPath = 'transit/users';
      configWith({ VAULT_TRANSIT_USERS_PATH: keysPath });

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

  describe('getUserPublicKey (using _getKey)', () => {
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

  describe('X-Vault-Namespace header', () => {
    const namespace = 'tenant-a';
    const transitPath = 'transit/users';
    const keyResponse = { data: { keys: { '1': { public_key: Buffer.alloc(32, 0xab).toString('base64') } } } };
    const token = { 'X-Vault-Token': 'token' };
    const json = { 'Content-Type': 'application/json' };
    const ns = { 'X-Vault-Namespace': namespace };

    // Every VaultService method that talks to Vault: the axios function it uses, a
    // response its parsing accepts, and the exact arguments expected with VAULT_NAMESPACE set.
    const vaultCalls = [
      {
        method: 'authGithub',
        axiosMethod: 'post',
        response: { auth: { client_token: 'token' } },
        act: () => vaultService.authGithub('pat'),
        expected: [`${BASE_URL}/v1/auth/github/login`, { token: 'pat' }, { headers: { ...json, ...ns } }],
      },
      {
        method: 'getTokenWithRole',
        axiosMethod: 'post',
        response: { auth: { client_token: 'token' } },
        act: () => vaultService.getTokenWithRole('role', 'secret'),
        expected: [`${BASE_URL}/v1/auth/approle/login`, { role_id: 'role', secret_id: 'secret' }, { headers: ns }],
      },
      {
        method: 'checkToken',
        axiosMethod: 'get',
        response: {},
        act: () => vaultService.checkToken('token'),
        expected: [`${BASE_URL}/v1/auth/token/lookup-self`, { headers: { ...token, ...ns } }],
      },
      {
        method: 'transitCreateKey',
        axiosMethod: 'post',
        response: keyResponse,
        act: () => vaultService.transitCreateKey('user-key', transitPath, 'token'),
        expected: [
          `${BASE_URL}/v1/${transitPath}/keys/user-key`,
          { type: 'ed25519', derived: false, allow_deletion: false },
          { headers: { ...token, ...ns } },
        ],
      },
      {
        method: 'getUserPublicKey',
        axiosMethod: 'get',
        response: keyResponse,
        act: () => vaultService.getUserPublicKey('user-key', 'token'),
        expected: [`${BASE_URL}/v1/${transitPath}/keys/user-key`, { headers: { ...token, ...json, ...ns } }],
      },
      {
        method: 'signAsUser',
        axiosMethod: 'post',
        response: { data: { signature: 'vault:v1:c2ln' } },
        act: () => vaultService.signAsUser('user-key', new Uint8Array([1, 2, 3]), 'token'),
        expected: [
          `${BASE_URL}/v1/${transitPath}/sign/user-key`,
          { input: Buffer.from([1, 2, 3]).toString('base64') },
          { headers: { ...token, ...ns } },
        ],
      },
      {
        method: 'getKeys',
        axiosMethod: 'request',
        response: { data: { keys: [] } },
        act: () => vaultService.getKeys('token'),
        expected: [{ url: `${BASE_URL}/v1/${transitPath}/keys`, method: 'LIST', headers: { ...token, ...ns } }],
      },
      {
        method: 'kvRead',
        axiosMethod: 'get',
        response: { data: { data: {} } },
        act: () => vaultService.kvRead('foo', 'token'),
        expected: [`${BASE_URL}/v1/secret/data/foo`, { headers: { ...token, ...ns } }],
      },
      {
        method: 'kvWrite',
        axiosMethod: 'post',
        response: {},
        act: () => vaultService.kvWrite('foo', { a: 1 }, 'token'),
        expected: [`${BASE_URL}/v1/secret/data/foo`, { data: { a: 1 } }, { headers: { ...token, ...json, ...ns } }],
      },
      {
        method: 'kvDelete',
        axiosMethod: 'delete',
        response: {},
        act: () => vaultService.kvDelete('foo', 'token'),
        expected: [`${BASE_URL}/v1/secret/metadata/foo`, { headers: { ...token, ...ns } }],
      },
      {
        method: 'kvList',
        axiosMethod: 'request',
        response: { data: { keys: [] } },
        act: () => vaultService.kvList('foo', 'token'),
        expected: [{ url: `${BASE_URL}/v1/secret/metadata/foo`, method: 'LIST', headers: { ...token, ...ns } }],
      },
    ] as const;

    it.each(vaultCalls)(
      '(OK) $method should send X-Vault-Namespace when VAULT_NAMESPACE is set',
      async ({ axiosMethod, response, act, expected }) => {
        configWith({ VAULT_TRANSIT_USERS_PATH: transitPath, VAULT_NAMESPACE: namespace });
        const mock = httpService.axiosRef[axiosMethod] as jest.Mock;
        mock.mockResolvedValueOnce(okResponse(response));

        await act();

        expect(mock).toHaveBeenCalledTimes(1);
        expect(mock).toHaveBeenCalledWith(...expected);
      },
    );

    describe.each([
      ['unset', undefined],
      // `VAULT_NAMESPACE=` in an env file must behave as unset, not send a blank header.
      ['empty', ''],
    ])('when VAULT_NAMESPACE is %s', (_label, value) => {
      it.each(vaultCalls)('(OK) $method should omit X-Vault-Namespace', async ({ axiosMethod, response, act }) => {
        configWith({ VAULT_TRANSIT_USERS_PATH: transitPath, VAULT_NAMESPACE: value });
        const mock = httpService.axiosRef[axiosMethod] as jest.Mock;
        mock.mockResolvedValueOnce(okResponse(response));

        await act();

        expect(mock).toHaveBeenCalledTimes(1);
        // The axios config is always the last argument. Object.keys is deliberate:
        // toHaveBeenCalledWith would treat an undefined-valued key as absent.
        const args = mock.mock.calls[0];
        expect(args[args.length - 1]).toHaveProperty('headers');
        expect(Object.keys(args[args.length - 1].headers)).not.toContain('X-Vault-Namespace');
      });
    });
  });

  describe('kv helpers', () => {
    const baseUrl = 'http://vault';
    const defaultMount = 'secret';

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

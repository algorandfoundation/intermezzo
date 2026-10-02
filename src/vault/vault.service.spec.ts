import { VaultCasConflictError, VaultService } from './vault.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Axios, AxiosResponse } from 'axios';
import { randomBytes } from 'crypto';
import { HttpErrorByCode } from '@nestjs/common/utils/http-error-by-code.util';
import createMockInstance from 'jest-create-mock-instance';

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
    const baseUrl = 'http://vault';
    const keysPath = 'transit/users';
    const configForTransit = () => {
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'VAULT_BASE_URL') return baseUrl;
        if (key === 'VAULT_TRANSIT_USERS_PATH') return keysPath;
        return undefined;
      });
    };

    const listResponse = (keys: string[]): AxiosResponse =>
      ({
        data: { data: { keys } },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: {} as any },
      }) as AxiosResponse;

    it('(\OK) should return an array of keys', async () => {
      configForTransit();

      const key1: Buffer = randomBytes(32);

      (httpService.axiosRef.request as jest.Mock).mockResolvedValueOnce(listResponse(['user-key1', 'user-key2']));

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

      const result = await vaultService.getKeys('token');

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
      expect(httpService.axiosRef.request).toHaveBeenCalledTimes(1);
    });

    it('(FAIL) should still throw when the transit LIST fails for a non-404 reason', async () => {
      configForTransit();
      (httpService.axiosRef.request as jest.Mock).mockRejectedValueOnce({ response: { status: 403 } });

      await expect(vaultService.getKeys('token')).rejects.toThrow(HttpErrorByCode[403]);
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

  describe('canCreateUserKey', () => {
    const baseUrl = 'http://vault';
    const path = 'pawn/pq-users/keys/pq-user';

    beforeEach(() => {
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'VAULT_BASE_URL') return baseUrl;
        return undefined;
      });
    });

    it('checks the exact target path', async () => {
      (httpService.axiosRef.post as jest.Mock).mockResolvedValueOnce({ data: { [path]: ['create', 'update'] } });

      await expect(vaultService.canCreateUserKey('pq-user', 'falcon1024', 'token')).resolves.toBe(true);
      expect(httpService.axiosRef.post).toHaveBeenCalledWith(
        `${baseUrl}/v1/sys/capabilities-self`,
        { paths: [path] },
        { headers: { 'X-Vault-Token': 'token' } },
      );
    });

    it('returns false when Vault denies the target path', async () => {
      (httpService.axiosRef.post as jest.Mock).mockResolvedValueOnce({ data: { [path]: ['deny'] } });

      await expect(vaultService.canCreateUserKey('pq-user', 'falcon1024', 'token')).resolves.toBe(false);
    });

    it('skips the preflight when capabilities-self is unavailable', async () => {
      (httpService.axiosRef.post as jest.Mock).mockRejectedValueOnce({ response: { status: 403 } });

      await expect(vaultService.canCreateUserKey('pq-user', 'falcon1024', 'token')).resolves.toBeUndefined();
    });
  });

  describe('X-Vault-Namespace header', () => {
    const namespace = 'tenant-a';
    const transitPath = 'transit/users';
    const keyResponse = { data: { keys: { '1': { public_key: Buffer.alloc(32, 0xab).toString('base64') } } } };
    const token = { 'X-Vault-Token': 'token' };
    const json = { 'Content-Type': 'application/json' };
    const ns = { 'X-Vault-Namespace': namespace };

    // Every VaultService request to Vault: the axios function it uses, a response its
    // parsing accepts, and the exact arguments expected with VAULT_NAMESPACE set. The four
    // pq* methods share one request path, represented here by pqListKeys.
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
        method: 'canCreateUserKey',
        axiosMethod: 'post',
        response: { data: { 'pawn/pq-users/keys/user-key': ['create'] } },
        act: () => vaultService.canCreateUserKey('user-key', 'falcon1024', 'token'),
        expected: [
          `${BASE_URL}/v1/sys/capabilities-self`,
          { paths: ['pawn/pq-users/keys/user-key'] },
          { headers: { ...token, ...ns } },
        ],
      },
      {
        method: 'pqListKeys',
        axiosMethod: 'request',
        response: { data: { keys: [] } },
        act: () => vaultService.pqListKeys('token'),
        expected: [{ url: `${BASE_URL}/v1/pawn/pq-users/keys`, method: 'LIST', headers: { ...token, ...ns } }],
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
        method: 'kvCreate',
        axiosMethod: 'post',
        response: {},
        act: () => vaultService.kvCreate('foo', { a: 1 }, 'token'),
        expected: [
          `${BASE_URL}/v1/secret/data/foo`,
          { data: { a: 1 }, options: { cas: 0 } },
          { headers: { ...token, ...json, ...ns } },
        ],
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

      it('(OK) should send `cas` as a write option when one is given', async () => {
        configWith();
        (httpService.axiosRef.post as jest.Mock).mockResolvedValueOnce({
          data: {},
          status: 200,
          statusText: 'OK',
          headers: {},
          config: { headers: {} as any },
        } as AxiosResponse);

        await vaultService.kvWrite('foo', { x: 1 }, 'token', 4);

        expect(httpService.axiosRef.post).toHaveBeenCalledWith(
          `${baseUrl}/v1/${defaultMount}/data/foo`,
          { data: { x: 1 }, options: { cas: 4 } },
          expect.anything(),
        );
      });

      it('(FAIL) should report a lost compare-and-set as VaultCasConflictError', async () => {
        configWith();
        (httpService.axiosRef.post as jest.Mock).mockRejectedValueOnce({
          response: { status: 400, data: { errors: ['check-and-set parameter did not match the current version'] } },
        });

        await expect(vaultService.kvWrite('foo', { x: 1 }, 'token', 4)).rejects.toThrow(VaultCasConflictError);
      });

      it('(FAIL) should not mistake an unrelated 400 for a conflict', async () => {
        configWith();
        (httpService.axiosRef.post as jest.Mock).mockRejectedValueOnce({
          response: { status: 400, data: { errors: ['missing data'] } },
        });

        await expect(vaultService.kvWrite('foo', { x: 1 }, 'token', 4)).rejects.toThrow(HttpErrorByCode[400]);
      });
    });

    describe('kvReadVersioned', () => {
      it('(OK) should return the payload with its version', async () => {
        configWith();
        (httpService.axiosRef.get as jest.Mock).mockResolvedValueOnce({
          data: { data: { data: { appId: '123' }, metadata: { version: 7 } } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: { headers: {} as any },
        } as AxiosResponse);

        expect(await vaultService.kvReadVersioned('foo', 'token')).toEqual({ data: { appId: '123' }, version: 7 });
      });

      it('(OK) should report version 0 for an entry that does not exist', async () => {
        configWith();
        (httpService.axiosRef.get as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });

        // 0 is what `cas` uses to mean "only if nobody has created it".
        expect(await vaultService.kvReadVersioned('missing', 'token')).toEqual({ version: 0 });
      });
    });

    describe('kvCreate', () => {
      it('uses CAS zero and reports whether the claim was created', async () => {
        configWith();
        (httpService.axiosRef.post as jest.Mock).mockResolvedValueOnce({ data: {} });
        const claim = { schemaVersion: 1, userId: 'alice', accountType: 'ed25519' };

        await expect(vaultService.kvCreate('intermezzo/account-types/hash', claim, 'token')).resolves.toBe(true);
        expect(httpService.axiosRef.post).toHaveBeenCalledWith(
          `${baseUrl}/v1/${defaultMount}/data/intermezzo/account-types/hash`,
          { data: claim, options: { cas: 0 } },
          {
            headers: {
              'X-Vault-Token': 'token',
              'Content-Type': 'application/json',
            },
          },
        );
      });

      it('returns false only for a CAS conflict', async () => {
        configWith();
        (httpService.axiosRef.post as jest.Mock).mockRejectedValueOnce({
          response: { status: 400, data: { errors: ['check-and-set parameter did not match the current version'] } },
        });

        await expect(vaultService.kvCreate('claim', { x: 1 }, 'token')).resolves.toBe(false);
      });

      it('preserves unrelated Vault errors', async () => {
        configWith();
        (httpService.axiosRef.post as jest.Mock).mockRejectedValueOnce({
          response: { status: 400, data: { errors: ['expected a map'] } },
        });

        await expect(vaultService.kvCreate('claim', { x: 1 }, 'token')).rejects.toThrow(HttpErrorByCode[400]);
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

  describe('pq (Falcon-1024) engine', () => {
    const baseUrl = 'http://vault';
    const defaultMount = 'pawn/pq-users';

    const publicKey = Buffer.alloc(1793, 9);
    const keyPayload = {
      public_key: publicKey.toString('base64'),
    };

    const ok = (data: any) =>
      ({
        data,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: {} as any },
      }) as AxiosResponse;

    it.each(['pqCreateKey', 'pqGetKey'] as const)('%s rejects malformed public keys from Vault', async (method) => {
      configWith();
      for (const public_key of [
        undefined,
        42,
        '',
        'not-base64!!',
        Buffer.alloc(32).toString('base64'),
        publicKey.subarray(1).toString('base64'),
        keyPayload.public_key + '!',
      ]) {
        (httpService.axiosRef.request as jest.Mock).mockResolvedValueOnce(ok({ data: { public_key } }));
        await expect(vaultService[method]('user-1', 'token')).rejects.toThrow(HttpErrorByCode[502]);
      }
    });

    describe('pqCreateKey', () => {
      it('(OK) should POST to the key path and parse the plugin response', async () => {
        configWith();
        (httpService.axiosRef.request as jest.Mock).mockResolvedValueOnce(ok({ data: keyPayload }));

        const result = await vaultService.pqCreateKey('user-1', 'token');

        expect(httpService.axiosRef.request).toHaveBeenCalledWith({
          url: `${baseUrl}/v1/${defaultMount}/keys/user-1`,
          method: 'POST',
          data: {},
          headers: { 'X-Vault-Token': 'token' },
        });
        expect(result).toEqual(publicKey);
        expect(Buffer.isBuffer(result)).toBe(true);
      });

      it('(OK) should honour VAULT_PQ_USERS_PATH and the namespace header', async () => {
        configWith({ VAULT_PQ_USERS_PATH: 'other/pq', VAULT_NAMESPACE: 'tenant-a' });
        (httpService.axiosRef.request as jest.Mock).mockResolvedValueOnce(ok({ data: keyPayload }));

        await vaultService.pqCreateKey('user-1', 'token');

        expect(httpService.axiosRef.request).toHaveBeenCalledWith({
          url: `${baseUrl}/v1/other/pq/keys/user-1`,
          method: 'POST',
          data: {},
          headers: { 'X-Vault-Token': 'token', 'X-Vault-Namespace': 'tenant-a' },
        });
      });

      it('(FAIL) should throw HttpErrorByCode when the engine rejects', async () => {
        configWith();
        (httpService.axiosRef.request as jest.Mock).mockRejectedValueOnce({ response: { status: 403 } });

        await expect(vaultService.pqCreateKey('user-1', 'token')).rejects.toThrow(HttpErrorByCode[403]);
      });
    });

    describe('pqGetKey', () => {
      it('(OK) should GET the key path and parse the plugin response', async () => {
        configWith();
        (httpService.axiosRef.request as jest.Mock).mockResolvedValueOnce(ok({ data: keyPayload }));

        const result = await vaultService.pqGetKey('user-1', 'token');

        expect(httpService.axiosRef.request).toHaveBeenCalledWith({
          url: `${baseUrl}/v1/${defaultMount}/keys/user-1`,
          method: 'GET',
          headers: { 'X-Vault-Token': 'token' },
        });
        expect(result).toEqual(publicKey);
      });

      it('(OK) should return undefined on 404 rather than throwing', async () => {
        // Load-bearing: the account-type probe reads a miss here as
        // "this user_id is not a PQ account", not as a failure.
        configWith();
        (httpService.axiosRef.request as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });

        await expect(vaultService.pqGetKey('missing', 'token')).resolves.toBeUndefined();
      });

      it('(FAIL) should throw HttpErrorByCode on non-404 errors', async () => {
        configWith();
        (httpService.axiosRef.request as jest.Mock).mockRejectedValueOnce({ response: { status: 500 } });

        await expect(vaultService.pqGetKey('user-1', 'token')).rejects.toThrow(HttpErrorByCode[500]);
      });
    });

    describe('pqSign', () => {
      it('(OK) should base64 the signing input unmodified and return raw signature bytes', async () => {
        configWith();
        const input = new Uint8Array([0x54, 0x58, 0x01, 0x02, 0x03]); // "TX" || payload
        const signature = Buffer.from('a-very-long-falcon-signature');
        (httpService.axiosRef.request as jest.Mock).mockResolvedValueOnce(
          ok({ data: { signature: signature.toString('base64') } }),
        );

        const result = await vaultService.pqSign('user-1', input, 'token');

        expect(httpService.axiosRef.request).toHaveBeenCalledWith({
          url: `${baseUrl}/v1/${defaultMount}/sign/user-1`,
          method: 'POST',
          data: { input: Buffer.from(input).toString('base64') },
          headers: { 'X-Vault-Token': 'token' },
        });
        // No `vault:v1:` envelope to split — the plugin returns the bare
        // signature, so anything that strips a transit prefix would corrupt it.
        expect(result).toEqual(signature);
      });

      it('(FAIL) should throw 404 for an unknown key instead of returning undefined', async () => {
        configWith();
        (httpService.axiosRef.request as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });

        await expect(vaultService.pqSign('missing', new Uint8Array([1]), 'token')).rejects.toThrow(
          HttpErrorByCode[404],
        );
      });
    });

    describe('pqListKeys', () => {
      it('(OK) should LIST the keys path', async () => {
        configWith();
        (httpService.axiosRef.request as jest.Mock).mockResolvedValueOnce(ok({ data: { keys: ['a', 'b'] } }));

        const result = await vaultService.pqListKeys('token');

        expect(httpService.axiosRef.request).toHaveBeenCalledWith({
          url: `${baseUrl}/v1/${defaultMount}/keys`,
          method: 'LIST',
          headers: { 'X-Vault-Token': 'token' },
        });
        expect(result).toEqual(['a', 'b']);
      });

      it('(OK) should return [] on 404 so it can be merged unconditionally', async () => {
        configWith();
        (httpService.axiosRef.request as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });

        await expect(vaultService.pqListKeys('token')).resolves.toEqual([]);
      });

      it('(FAIL) should throw HttpErrorByCode on non-404 errors', async () => {
        configWith();
        (httpService.axiosRef.request as jest.Mock).mockRejectedValueOnce({ response: { status: 500 } });

        await expect(vaultService.pqListKeys('token')).rejects.toThrow(HttpErrorByCode[500]);
      });
    });
  });
});

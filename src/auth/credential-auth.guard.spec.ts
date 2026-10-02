import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Oid4vcAgentProvider } from '../oid4vc/agent/oid4vc-agent.provider';
import { Oid4vcConfig } from '../oid4vc/oid4vc.config';
import { CREDENTIAL_HEADER, CredentialAuthGuard, CredentialAuthRequest } from './credential-auth.guard';

const ISSUER = 'did:algo:testnet:app:1:' + 'aa'.repeat(32);
const URI = 'http://localhost:3000/v1/credential/status/list/f538cd53-79e5-4877-b6c2-51c09c51f8ab';

describe('CredentialAuthGuard', () => {
  let guard: CredentialAuthGuard;
  let verify: jest.Mock;
  let payload: Record<string, unknown>;
  let request: CredentialAuthRequest;
  let context: ExecutionContext;

  beforeEach(() => {
    payload = {
      iss: ISSUER,
      vct: 'device-attestation-credential',
      cnf: { kid: 'did:key:z6MkExample#z6MkExample' },
      status: { status_list: { uri: URI, idx: 0 } },
    };
    verify = jest.fn(async () => ({ isValid: true, sdJwtVc: { payload } }));
    guard = new CredentialAuthGuard(
      {
        getAgent: async () => ({ sdJwtVc: { verify } }),
        ensureIssuerDid: async () => ({ did: ISSUER }),
      } as unknown as Oid4vcAgentProvider,
      new Oid4vcConfig({ get: <T>(_key: string, fallback?: T) => fallback } as unknown as ConfigService),
    );
    request = { headers: { [CREDENTIAL_HEADER]: 'signed-credential' } };
    context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  });

  it('accepts verified credentials with an issuer UUID list and exposes the holder', async () => {
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith({ compactSdJwtVc: 'signed-credential' });
    expect(request.didKey).toBe('did:key:z6MkExample');
    expect(request.credentialPayload).toBe(payload);
  });

  it.each([
    undefined,
    null,
    {},
    { status_list: {} },
    { status_list: { uri: URI } },
    ...[-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1].map((idx) => ({ status_list: { uri: URI, idx } })),
    ...[
      'https://foreign.example/list/1',
      URI.replace(/[^/]+$/, 'default'),
      URI + '?x=1',
      URI + '/nested',
      URI.replace('/v1/', '/v2/'),
      123,
    ].map((uri) => ({ status_list: { uri, idx: 0 } })),
  ])('rejects missing or malformed status references: %j', async (status) => {
    payload.status = status;
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(request.didKey).toBeUndefined();
  });

  it('rejects failed status or signature verification even with a well-formed reference', async () => {
    verify.mockResolvedValue({ isValid: false, error: new Error('Status is not valid') });
    await expect(guard.canActivate(context)).rejects.toThrow('Status is not valid');
  });

  it.each([
    { iss: 'did:algo:other' },
    { vct: 'other-credential' },
    { cnf: {} },
    { cnf: { kid: 'did:example:holder' } },
  ])('preserves issuer, credential type and holder validation: %j', async (invalid) => {
    Object.assign(payload, invalid);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects missing credentials before verification', async () => {
    request.headers = {};
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(verify).not.toHaveBeenCalled();
  });
});

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CredentialAuthGuard,
  CredentialAuthRequest,
  CREDENTIAL_HEADER,
  DEVICE_ATTESTATION_VCT,
  FEE_SPONSORSHIP_VCT,
} from './credential-auth.guard';
import { Oid4vcAgentProvider } from '../oid4vc/agent/oid4vc-agent.provider';

describe('CredentialAuthGuard', () => {
  const ISSUER_DID = 'did:algo:testnet:manager';
  const HOLDER_DID_KEY = 'did:key:z6MkfyG3dNC2Yg8bhLh1JzC2q6H8mBQvEXAMPLEexample';

  let guard: CredentialAuthGuard;
  let verifyMock: jest.Mock;
  let reflectorMock: { getAllAndOverride: jest.Mock };
  let request: CredentialAuthRequest;

  const buildContext = (headers: Record<string, string>): ExecutionContext => {
    request = { headers };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  };

  const validPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    iss: ISSUER_DID,
    vct: DEVICE_ATTESTATION_VCT,
    cnf: { kid: `${HOLDER_DID_KEY}#key-1` },
    ...overrides,
  });

  const mockVerifiedPayload = (payload: Record<string, unknown>) => {
    verifyMock.mockResolvedValueOnce({ isValid: true, sdJwtVc: { payload } });
  };

  beforeEach(() => {
    verifyMock = jest.fn();
    reflectorMock = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    const agentProviderMock = {
      getAgent: jest.fn().mockResolvedValue({ sdJwtVc: { verify: verifyMock } }),
      ensureIssuerDid: jest.fn().mockResolvedValue({ did: ISSUER_DID }),
    } as unknown as Oid4vcAgentProvider;
    guard = new CredentialAuthGuard(agentProviderMock, reflectorMock as unknown as Reflector);
  });

  it('(OK) accepts a valid device-attestation credential and attaches the holder did:key', async () => {
    mockVerifiedPayload(validPayload());

    await expect(guard.canActivate(buildContext({ [CREDENTIAL_HEADER]: 'sd-jwt' }))).resolves.toBe(true);
    expect(request.didKey).toBe(HOLDER_DID_KEY);
    expect(request.credentialPayload).toMatchObject({ vct: DEVICE_ATTESTATION_VCT });
  });

  it('(OK) requires the vct declared via @RequiredCredential route metadata', async () => {
    reflectorMock.getAllAndOverride.mockReturnValue(FEE_SPONSORSHIP_VCT);
    mockVerifiedPayload(validPayload({ vct: FEE_SPONSORSHIP_VCT }));

    await expect(guard.canActivate(buildContext({ [CREDENTIAL_HEADER]: 'sd-jwt' }))).resolves.toBe(true);
    expect(request.didKey).toBe(HOLDER_DID_KEY);
  });

  it('rejects a device-attestation credential on a route requiring the fee-sponsorship credential', async () => {
    reflectorMock.getAllAndOverride.mockReturnValue(FEE_SPONSORSHIP_VCT);
    mockVerifiedPayload(validPayload({ vct: DEVICE_ATTESTATION_VCT }));

    await expect(guard.canActivate(buildContext({ [CREDENTIAL_HEADER]: 'sd-jwt' }))).rejects.toThrow(
      new RegExp(`is not ${FEE_SPONSORSHIP_VCT}`),
    );
  });

  it('rejects a fee-sponsorship credential on a default (device-attestation) route', async () => {
    mockVerifiedPayload(validPayload({ vct: FEE_SPONSORSHIP_VCT }));

    await expect(guard.canActivate(buildContext({ [CREDENTIAL_HEADER]: 'sd-jwt' }))).rejects.toThrow(
      new RegExp(`is not ${DEVICE_ATTESTATION_VCT}`),
    );
  });

  it('rejects when the presentation header is missing', async () => {
    await expect(guard.canActivate(buildContext({}))).rejects.toThrow(UnauthorizedException);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('rejects when signature verification fails', async () => {
    verifyMock.mockResolvedValueOnce({ isValid: false, error: new Error('bad signature') });

    await expect(guard.canActivate(buildContext({ [CREDENTIAL_HEADER]: 'sd-jwt' }))).rejects.toThrow(
      /Credential failed verification: bad signature/,
    );
  });

  it('rejects a credential from an unexpected issuer', async () => {
    mockVerifiedPayload(validPayload({ iss: 'did:algo:testnet:impostor' }));

    await expect(guard.canActivate(buildContext({ [CREDENTIAL_HEADER]: 'sd-jwt' }))).rejects.toThrow(
      /does not match the manager issuer/,
    );
  });

  it('rejects a credential not bound to a did:key', async () => {
    mockVerifiedPayload(validPayload({ cnf: { kid: 'did:algo:testnet:user#key-1' } }));

    await expect(guard.canActivate(buildContext({ [CREDENTIAL_HEADER]: 'sd-jwt' }))).rejects.toThrow(
      /is not a did:key/,
    );
  });
});

import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { Oid4vcVerificationSessionRepository } from '../sessions/vault-repository';

import { Oid4vcVerifierService } from './oid4vc-verifier.service';
import { Oid4vcAgentProvider } from '../agent/oid4vc-agent.provider';
import { Oid4vcConfig } from '../oid4vc.config';

describe('Oid4vcVerifierService', () => {
  const mockRepo = {
    create: jest.fn((v) => v),
    save: jest.fn(async (v) => ({ id: 'local-1', ...v })),
    findOneBy: jest.fn(),
    find: jest.fn(async () => []),
  };

  const verifierApi = {
    getVerifierByVerifierId: jest.fn(),
    createVerifier: jest.fn(),
    createAuthorizationRequest: jest.fn(),
    getVerificationSessionById: jest.fn(),
    getVerifiedAuthorizationResponse: jest.fn(),
  };

  const fakeAgent = { modules: { openId4VcVerifier: verifierApi } } as never;

  const issuerAlgoDid = 'did:algo:testnet:app:99:' + 'c'.repeat(64);
  const agentProvider = {
    getAgent: jest.fn(async () => fakeAgent),
    ensureIssuerDid: jest.fn(async () => ({
      did: issuerAlgoDid,
      verificationMethodId: `${issuerAlgoDid}#keys-1`,
    })),
  };

  const config = { autoInit: false } as Oid4vcConfig;

  let service: Oid4vcVerifierService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        Oid4vcVerifierService,
        { provide: Oid4vcAgentProvider, useValue: agentProvider },
        { provide: Oid4vcConfig, useValue: config },
        { provide: Oid4vcVerificationSessionRepository, useValue: mockRepo },
      ],
    }).compile();
    service = moduleRef.get(Oid4vcVerifierService);
  });

  describe('ensureVerifier', () => {
    it('reuses existing verifier', async () => {
      verifierApi.getVerifierByVerifierId.mockResolvedValue({ verifierId: Oid4vcVerifierService.VERIFIER_ID });
      await service.ensureVerifier();
      expect(verifierApi.createVerifier).not.toHaveBeenCalled();
    });

    it('creates a verifier when missing', async () => {
      verifierApi.getVerifierByVerifierId.mockRejectedValue(new Error('not found'));
      verifierApi.createVerifier.mockResolvedValue({ verifierId: Oid4vcVerifierService.VERIFIER_ID });
      await service.ensureVerifier();
      expect(verifierApi.createVerifier).toHaveBeenCalledWith({ verifierId: Oid4vcVerifierService.VERIFIER_ID });
    });
  });

  describe('createPresentationRequest', () => {
    it('creates an authorization request and persists the local session', async () => {
      verifierApi.getVerifierByVerifierId.mockResolvedValue({ verifierId: Oid4vcVerifierService.VERIFIER_ID });
      verifierApi.createAuthorizationRequest.mockResolvedValue({
        authorizationRequest: 'openid4vp://request',
        verificationSession: { id: 'credo-v-1', state: 'RequestCreated' },
      });

      const definition = { id: 'def', input_descriptors: [] };
      const result = await service.createPresentationRequest({
        presentationDefinition: definition,
      });

      expect(verifierApi.createAuthorizationRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          verifierId: Oid4vcVerifierService.VERIFIER_ID,
          presentationExchange: { definition },
        }),
      );
      expect(result).toMatchObject({
        credoVerificationSessionId: 'credo-v-1',
        authorizationRequest: 'openid4vp://request',
      });
    });
  });

  describe('findSession', () => {
    it('throws when not present locally', async () => {
      mockRepo.findOneBy.mockResolvedValue(null);
      await expect(service.findSession('x')).rejects.toThrow(NotFoundException);
    });

    it('refreshes state from Credo and pulls verified claims when available', async () => {
      mockRepo.findOneBy.mockResolvedValue({
        id: 'x',
        credoVerificationSessionId: 'credo-v-1',
        state: 'RequestCreated',
      });
      verifierApi.getVerificationSessionById.mockResolvedValue({ state: 'ResponseVerified' });
      verifierApi.getVerifiedAuthorizationResponse.mockResolvedValue({
        idToken: { payload: { sub: 'holder' } },
        presentationExchange: { presentations: ['vp'], submission: { id: 's' } },
      });

      const r = await service.findSession('x');
      expect(r.state).toBe('ResponseVerified');
      expect(r.verifiedClaims).toEqual({
        idToken: { sub: 'holder' },
        presentations: ['vp'],
        submission: { id: 's' },
      });
    });
  });
});

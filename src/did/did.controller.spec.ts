import createMockInstance from 'jest-create-mock-instance';
import { BadRequestException } from '@nestjs/common';

import { DidController } from './did.controller';
import { DidService } from './did.service';
import { UnsupportedDidKeyError } from './did-key';
import { ManagerVaultTokenProvider } from '../auth/manager-vault-token.provider';
import type { CredentialAuthRequest } from '../auth/credential-auth.guard';

// The real guard pulls in the Credo agent (native askar); it never runs when calling handlers directly.
jest.mock('../auth/credential-auth.guard', () => ({ CredentialAuthGuard: class {} }));

describe('DidController', () => {
  const didKey = 'did:key:zBad';
  let didService: jest.Mocked<DidService>;
  let controller: DidController;

  beforeEach(() => {
    didService = createMockInstance(DidService);
    // Guards only run through the Nest router, so the controller can be exercised directly.
    controller = new DidController(didService, {
      getToken: async () => 'vt',
    } as unknown as ManagerVaultTokenProvider);
  });

  it('maps an unsupported caller did:key to 400 on manager and credential routes', async () => {
    const error = new UnsupportedDidKeyError(`did:key ${didKey} is not an ed25519 key`, didKey);
    didService.getUserDid.mockRejectedValue(error);
    didService.getUserDidLive.mockRejectedValue(error);
    didService.buildUserContractCreate.mockRejectedValue(error);

    for (const call of [
      controller.getIdentity(didKey, undefined, undefined, { vault_token: 'vt' }),
      controller.getIdentity(didKey, true, undefined, { vault_token: 'vt' }),
      controller.createTransactions({}, { didKey } as CredentialAuthRequest),
    ]) {
      await expect(call).rejects.toBeInstanceOf(BadRequestException);
      await expect(call).rejects.toThrow(error.message);
    }
  });

  it('leaves other failures, including a non-Ed25519 manager key, as server errors', async () => {
    const managerKey = new UnsupportedDidKeyError('manager key is not Ed25519');
    const other = new Error('vault down');
    didService.buildUserContractCreate.mockRejectedValueOnce(managerKey).mockRejectedValueOnce(other);

    await expect(controller.createTransactions({}, { didKey } as CredentialAuthRequest)).rejects.toBe(managerKey);
    await expect(controller.createTransactions({}, { didKey } as CredentialAuthRequest)).rejects.toBe(other);
  });
});

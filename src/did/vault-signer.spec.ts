import createMockInstance from 'jest-create-mock-instance';
import { randomBytes } from 'crypto';
import { Address } from '@algorandfoundation/algokit-utils';

// Stub the encodeTransaction helper so we don't need to construct a real
// algokit Transaction object — the signer treats whatever bytes it returns
// as opaque "encoded" input forwarded to vaultSign.
jest.mock('@algorandfoundation/algokit-utils/transact', () => ({
  encodeTransaction: jest.fn(),
}));

import { encodeTransaction } from '@algorandfoundation/algokit-utils/transact';
import { ChainService } from '../chain/chain.service';
import { VaultService } from '../vault/vault.service';
import { buildManagerSigner, buildVaultTransactionSigner, decodeVaultSignature } from './vault-signer';

const encodeTransactionMock = encodeTransaction as unknown as jest.Mock;

describe('vault-signer', () => {
  describe('decodeVaultSignature', () => {
    it('returns the base64-decoded payload after the "vault:vN:" prefix', () => {
      const sigBytes = new Uint8Array(64).fill(0xaa);
      const wrapped = Buffer.from(`vault:v1:${Buffer.from(sigBytes).toString('base64')}`);
      const decoded = decodeVaultSignature(wrapped);
      expect(decoded).toEqual(sigBytes);
    });
  });

  describe('buildVaultTransactionSigner', () => {
    let chainService: jest.Mocked<ChainService>;

    beforeEach(() => {
      chainService = createMockInstance(ChainService);
      encodeTransactionMock.mockReset();
    });

    it('encodes, signs, and assembles only the requested indexes', async () => {
      const encoded0 = new Uint8Array([1, 1, 1]);
      const encoded2 = new Uint8Array([2, 2, 2]);
      encodeTransactionMock.mockImplementation((txn: any) => (txn === 'tx0' ? encoded0 : encoded2));

      const signedFor0 = new Uint8Array([10]);
      const signedFor2 = new Uint8Array([20]);
      chainService.addSignatureToTxn.mockReturnValueOnce(signedFor0).mockReturnValueOnce(signedFor2);

      const sig0 = new Uint8Array(64).fill(1);
      const sig2 = new Uint8Array(64).fill(2);
      const vaultSign = jest
        .fn()
        .mockResolvedValueOnce(Buffer.from(`vault:v1:${Buffer.from(sig0).toString('base64')}`))
        .mockResolvedValueOnce(Buffer.from(`vault:v1:${Buffer.from(sig2).toString('base64')}`));

      const signer = buildVaultTransactionSigner(chainService, vaultSign);
      const result = await signer(['tx0', 'tx1', 'tx2'] as any, [0, 2]);

      expect(result).toEqual([signedFor0, signedFor2]);
      expect(vaultSign).toHaveBeenNthCalledWith(1, encoded0);
      expect(vaultSign).toHaveBeenNthCalledWith(2, encoded2);
      expect(chainService.addSignatureToTxn).toHaveBeenNthCalledWith(1, encoded0, sig0);
      expect(chainService.addSignatureToTxn).toHaveBeenNthCalledWith(2, encoded2, sig2);
    });

    it('returns an empty array when no indexes need signing', async () => {
      const signer = buildVaultTransactionSigner(chainService, jest.fn());
      const result = await signer([] as any, []);
      expect(result).toEqual([]);
    });
  });

  describe('buildManagerSigner', () => {
    it('returns the manager Address and a signer that signs via signAsManager', async () => {
      const vaultService = createMockInstance(VaultService);
      const chainService = createMockInstance(ChainService);
      const managerPubKey = randomBytes(32);

      vaultService.getManagerPublicKey.mockResolvedValueOnce(managerPubKey);

      const sig = new Uint8Array(64).fill(0x55);
      vaultService.signAsManager.mockResolvedValue(Buffer.from(`vault:v1:${Buffer.from(sig).toString('base64')}`));

      const encoded = new Uint8Array([9, 9, 9]);
      encodeTransactionMock.mockReturnValue(encoded);
      chainService.addSignatureToTxn.mockReturnValue(new Uint8Array([42]));

      const { address, signer } = await buildManagerSigner(vaultService, chainService, 'tok');

      expect(address.toString()).toBe(new Address(managerPubKey).toString());
      expect(vaultService.getManagerPublicKey).toHaveBeenCalledWith('tok');

      // Drive the returned signer once; it must call signAsManager with our
      // token and the encoded txn bytes.
      const out = await signer(['txA'] as any, [0]);
      expect(out).toEqual([new Uint8Array([42])]);
      expect(vaultService.signAsManager).toHaveBeenCalledWith(encoded, 'tok');
    });
  });
});

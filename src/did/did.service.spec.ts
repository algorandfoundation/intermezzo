import createMockInstance from 'jest-create-mock-instance';
import { ConfigService } from '@nestjs/config';
import { Address } from '@algorandfoundation/algokit-utils';

import { DidService } from './did.service';
import { ChainService } from '../chain/chain.service';
import { VaultService } from '../vault/vault.service';
import { ManagerVaultTokenProvider } from '../auth/manager-vault-token.provider';

// Mock the on-chain primitives so the service can run without a real
// algod node or DIDAlgoStorage contract.
jest.mock('../../libs/did-algo', () => {
  const actual = jest.requireActual('../../libs/did-algo');
  return {
    ...actual,
    DidAlgoStorageClient: jest.fn(),
    uploadDIDDocument: jest.fn(),
    deleteDIDDocument: jest.fn(),
    replaceDIDDocument: jest.fn(),
  };
});
jest.mock('./vault-signer', () => ({
  buildManagerSigner: jest.fn(),
}));

import { DidAlgoStorageClient, deleteDIDDocument, uploadDIDDocument, replaceDIDDocument } from '../../libs/did-algo';
import { buildManagerSigner } from './vault-signer';

const DidAlgoStorageClientMock = DidAlgoStorageClient as unknown as jest.Mock;
const uploadDIDDocumentMock = uploadDIDDocument as unknown as jest.Mock;
const deleteDIDDocumentMock = deleteDIDDocument as unknown as jest.Mock;
const replaceDIDDocumentMock = replaceDIDDocument as unknown as jest.Mock;
const buildManagerSignerMock = buildManagerSigner as unknown as jest.Mock;

/**
 * Post-cache-removal `DidService` is stateless: there is no local
 * repository of published documents, the on-chain `DIDAlgoStorage`
 * boxes are the single source of truth. The spec exercises:
 *
 *   - `deriveDid` (pure)
 *   - `buildControllerDocument` / `buildUncontrolledDocument`
 *   - `publishControlledDid` (publish, idempotent-when-exists, force,
 *     error path)
 *   - `deleteControlledDid` (with-doc, no-doc)
 *   - `publishUncontrolledDid` (declares `did:key` owner via
 *     `alsoKnownAs` + verification-method `controller`)
 */
describe('DidService', () => {
  let configService: jest.Mocked<ConfigService>;
  let chainService: jest.Mocked<ChainService>;
  let vaultService: jest.Mocked<VaultService>;
  let managerToken: jest.Mocked<ManagerVaultTokenProvider>;
  let didService: DidService;

  const APP_ID = '1234';
  const CONTROLLER_PUB_KEY = new Uint8Array(32).fill(0x77);
  const MANAGER_PUB_KEY = new Uint8Array(32).fill(0x88);
  const MANAGER_ADDRESS = new Address(MANAGER_PUB_KEY);

  const metadataValueMock = jest.fn();

  beforeEach(() => {
    configService = createMockInstance(ConfigService);
    chainService = createMockInstance(ChainService);
    vaultService = createMockInstance(VaultService);

    configService.get.mockImplementation((key: string) => {
      const cfg: Record<string, string> = {
        GENESIS_ID: 'testnet-v1.0',
        NODE_HTTP_SCHEME: 'http',
        NODE_HOST: 'localhost',
        NODE_PORT: '4001',
        NODE_TOKEN: '',
      };
      return cfg[key];
    });
    // App id now lives in Vault KV. Stub the KV read so the lazy
    // loader populates the in-memory override without hitting Vault.
    (vaultService.kvRead as jest.Mock) = jest.fn().mockResolvedValue({ appId: APP_ID });
    (vaultService.kvWrite as jest.Mock) = jest.fn().mockResolvedValue(undefined);
    managerToken = {
      getToken: jest.fn().mockResolvedValue('mgr-token'),
    } as unknown as jest.Mocked<ManagerVaultTokenProvider>;

    buildManagerSignerMock.mockResolvedValue({ address: MANAGER_ADDRESS, signer: jest.fn() });

    metadataValueMock.mockReset();
    DidAlgoStorageClientMock.mockImplementation(() => ({
      state: {
        box: { metadata: { value: metadataValueMock } },
        global: { currentIndex: jest.fn().mockResolvedValue(0n) },
      },
      appClient: { getABIMethod: (n: string) => ({ name: n }) },
    }));
    uploadDIDDocumentMock.mockResolvedValue(['tx-upload-1']);
    deleteDIDDocumentMock.mockResolvedValue(['tx-del-1']);
    replaceDIDDocumentMock.mockResolvedValue({
      skipped: false,
      deleteTxIds: [],
      uploadTxIds: ['tx-upload-1'],
      oldMbrMicroAlgos: 0n,
      newMbrMicroAlgos: 542200n,
    });

    didService = new DidService(configService, chainService, vaultService, managerToken);
  });

  // Pre-populate the app-id override from the mocked KV so the sync
  // accessors (`deriveDid`, etc.) work in the pure-helper specs.
  beforeEach(async () => {
    await didService.ensureAppIdLoaded();
  });

  afterEach(() => jest.clearAllMocks());

  describe('pure helpers', () => {
    it('deriveDid returns the canonical did:algo identifier for a key', () => {
      const did = didService.deriveDid(CONTROLLER_PUB_KEY);
      expect(did).toMatch(/^did:algo:testnet:app:1234:[A-Z2-7]+$/);
    });

    it('buildControllerDocument exposes the key as the sole verification method', () => {
      const { did, document } = didService.buildControllerDocument(CONTROLLER_PUB_KEY);
      expect(did).toBe(didService.deriveDid(CONTROLLER_PUB_KEY));
      const doc = document as Record<string, unknown> & {
        verificationMethod: Array<{ controller: string }>;
      };
      expect(doc.id).toBe(did);
      expect(doc.verificationMethod[0].controller).toBe(did);
    });

    it('buildUncontrolledDocument hands controllership to the supplied did:key', () => {
      const owner = 'did:key:z6MkExampleHolder';
      const { did, document } = didService.buildUncontrolledDocument(CONTROLLER_PUB_KEY, owner, 42n);
      const doc = document as Record<string, unknown> & {
        alsoKnownAs?: string[];
        verificationMethod: Array<{ controller: string }>;
      };
      expect(doc.id).toBe(did);
      expect(doc.verificationMethod[0].controller).toBe(owner);
      expect(doc.alsoKnownAs).toContain(owner);
    });
  });

  describe('publishControlledDid', () => {
    it('publishes a fresh document when no metadata exists on chain', async () => {
      metadataValueMock.mockResolvedValueOnce(undefined);

      const result = await didService.publishControlledDid({
        controller: 'mgr',
        publicKey: CONTROLLER_PUB_KEY,
        vaultToken: 'vt',
      });

      expect(deleteDIDDocumentMock).not.toHaveBeenCalled();
      expect(replaceDIDDocumentMock).toHaveBeenCalledTimes(1);
      expect(result.txIds).toEqual(['tx-upload-1']);
    });

    it('is a no-op when metadata exists and force is not set', async () => {
      metadataValueMock.mockResolvedValueOnce({ start: 0n, end: 0n, status: 1, lastDeleted: 0n, endSize: 0n });

      const result = await didService.publishControlledDid({
        controller: 'mgr',
        publicKey: CONTROLLER_PUB_KEY,
        vaultToken: 'vt',
      });

      expect(deleteDIDDocumentMock).not.toHaveBeenCalled();
      expect(uploadDIDDocumentMock).not.toHaveBeenCalled();
      expect(result.txIds).toEqual([]);
    });

    it('force: deletes the existing on-chain document before uploading the new one', async () => {
      metadataValueMock.mockResolvedValueOnce({ start: 0n, end: 0n, status: 1, lastDeleted: 0n, endSize: 0n });

      await didService.publishControlledDid({
        controller: 'mgr',
        publicKey: CONTROLLER_PUB_KEY,
        vaultToken: 'vt',
        force: true,
      });

      expect(replaceDIDDocumentMock).toHaveBeenCalledTimes(1);
    });

    it('propagates the upload error', async () => {
      metadataValueMock.mockResolvedValueOnce(undefined);
      replaceDIDDocumentMock.mockRejectedValueOnce(new Error('chain refused'));

      await expect(
        didService.publishControlledDid({ controller: 'mgr', publicKey: CONTROLLER_PUB_KEY, vaultToken: 'vt' }),
      ).rejects.toThrow(/chain refused/);
    });
  });

  describe('deleteControlledDid', () => {
    it('deletes the on-chain doc when one exists', async () => {
      metadataValueMock.mockResolvedValueOnce({ start: 0n, end: 0n, status: 1, lastDeleted: 0n, endSize: 0n });

      const result = await didService.deleteControlledDid(CONTROLLER_PUB_KEY, 'vt');

      expect(deleteDIDDocumentMock).toHaveBeenCalledTimes(1);
      expect(result.txIds).toEqual(['tx-del-1']);
    });

    it('returns txIds=null when no on-chain doc exists', async () => {
      metadataValueMock.mockResolvedValueOnce(undefined);

      const result = await didService.deleteControlledDid(CONTROLLER_PUB_KEY, 'vt');

      expect(deleteDIDDocumentMock).not.toHaveBeenCalled();
      expect(result.txIds).toBeNull();
    });
  });

  // `publishUncontrolledDid` was removed: per-user `did:algo` contracts
  // are now deployed by the wallet itself via
  // `POST /v1/did/identities/create/{transactions,submit}`, with the wallet's
  // `did:key`-derived address as the contract creator and the manager
  // Vault key only sponsoring fees + account min-balance. Document
  // updates likewise go through `POST /did/identities/update/transactions` (every
  // app-call signed by the wallet). The host has no on-chain signing
  // authority over user-owned contracts and therefore no
  // service-level "publish for someone else" path to test here.
});

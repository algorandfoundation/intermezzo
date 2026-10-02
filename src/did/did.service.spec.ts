import createMockInstance from 'jest-create-mock-instance';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { Address, AlgorandClient } from '@algorandfoundation/algokit-utils';
import { base58 } from '@scure/base';
import {
  encodeTransaction,
  decodeTransaction,
  encodeSignedTransaction,
} from '@algorandfoundation/algokit-utils/transact';
import { makePaymentTxnWithSuggestedParamsFromObject, msgpackRawDecode, msgpackRawEncode } from 'algosdk';

import { DidService, UserContractCreatePlan, UserDidUpdatePlan } from './did.service';
import { UnsupportedDidKeyError } from './did-key';
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
    resolveDIDDocument: jest.fn(),
  };
});
jest.mock('./vault-signer', () => ({
  ...jest.requireActual('./vault-signer'),
  buildManagerSigner: jest.fn(),
}));

import {
  DidAlgoStorageClient,
  deleteDIDDocument,
  uploadDIDDocument,
  replaceDIDDocument,
  resolveDIDDocument,
} from '../../libs/did-algo';
import { buildManagerSigner } from './vault-signer';

const DidAlgoStorageClientMock = DidAlgoStorageClient as unknown as jest.Mock;
const uploadDIDDocumentMock = uploadDIDDocument as unknown as jest.Mock;
const deleteDIDDocumentMock = deleteDIDDocument as unknown as jest.Mock;
const replaceDIDDocumentMock = replaceDIDDocument as unknown as jest.Mock;
const resolveDIDDocumentMock = resolveDIDDocument as unknown as jest.Mock;
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
  const USER_DID_KEY = 'did:key:z' + base58.encode(Uint8Array.from([0xed, 0x01, ...CONTROLLER_PUB_KEY]));

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
    DidAlgoStorageClientMock.mockImplementation((opts?: { appId?: bigint }) => ({
      state: {
        box: { metadata: { value: metadataValueMock } },
        global: { currentIndex: jest.fn().mockResolvedValue(0n) },
      },
      appClient: { getABIMethod: (n: string) => ({ name: n }) },
      appAddress: { toString: () => `addr-of-app-${opts?.appId ?? 'unknown'}` },
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

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

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
      const owner = USER_DID_KEY;
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

  describe('getUserDidLive', () => {
    const USER_PUB_KEY = new Uint8Array(32).fill(0x42);
    const USER_DID_KEY = 'did:key:z' + base58.encode(Uint8Array.from([0xed, 0x01, ...USER_PUB_KEY]));

    it('rejects a malformed did:key without any Vault or chain I/O', async () => {
      (vaultService.kvRead as jest.Mock).mockClear();

      const result = didService.getUserDidLive('did:key:not-a-key', 'vt');

      await expect(result).rejects.toBeInstanceOf(UnsupportedDidKeyError);
      await expect(result).rejects.toThrow('did:key did:key:not-a-key is not multibase-z encoded');
      expect(vaultService.kvRead).not.toHaveBeenCalled();
      expect(resolveDIDDocumentMock).not.toHaveBeenCalled();
    });

    it('uses the explicit appId override without consulting the Vault registry', async () => {
      (vaultService.kvRead as jest.Mock).mockClear();
      const document = { id: 'did:algo:...', verificationMethod: [] };
      resolveDIDDocumentMock.mockResolvedValueOnce(document);

      const result = await didService.getUserDidLive(USER_DID_KEY, 'vt', 555n);

      expect(result).toEqual({
        didKey: USER_DID_KEY,
        did: expect.stringMatching(/^did:algo:testnet:app:555:[A-Z2-7]+$/),
        appId: '555',
        appAddress: 'addr-of-app-555',
        didDocument: document,
      });
      expect(vaultService.kvRead).not.toHaveBeenCalled();
      expect(resolveDIDDocumentMock).toHaveBeenCalledWith(
        expect.objectContaining({ appAddress: expect.anything() }),
        USER_PUB_KEY,
      );
    });

    it('falls back to the Vault KV registry for the appId when none is supplied', async () => {
      (vaultService.kvRead as jest.Mock).mockClear();
      const document = { id: 'did:algo:...' };
      resolveDIDDocumentMock.mockResolvedValueOnce(document);

      const result = await didService.getUserDidLive(USER_DID_KEY, 'vt');

      expect(vaultService.kvRead).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent(USER_DID_KEY)), 'vt');
      expect(result).toEqual({
        didKey: USER_DID_KEY,
        did: expect.stringMatching(/^did:algo:testnet:app:1234:[A-Z2-7]+$/),
        appId: '1234',
        appAddress: 'addr-of-app-1234',
        didDocument: document,
      });
    });

    it('returns null when no appId is supplied and none is registered in Vault', async () => {
      (vaultService.kvRead as jest.Mock).mockResolvedValueOnce(undefined);

      const result = await didService.getUserDidLive(USER_DID_KEY, 'vt');

      expect(result).toBeNull();
      expect(resolveDIDDocumentMock).not.toHaveBeenCalled();
    });

    it('reports didDocument=null when the contract has no published document', async () => {
      resolveDIDDocumentMock.mockResolvedValueOnce(null);

      const result = await didService.getUserDidLive(USER_DID_KEY, 'vt', 42n);

      expect(result?.appId).toBe('42');
      expect(result?.didDocument).toBeNull();
    });
  });

  describe('Ed25519-only DID operations', () => {
    const unsupportedKeys = [
      ['Falcon-sized key with an Ed25519 prefix', Uint8Array.from([0xed, 0x01, ...new Uint8Array(1793)])],
      ['P-256 key', Uint8Array.from([0x80, 0x24, ...new Uint8Array(33)])],
      ['wrong codec with a 32-byte key', Uint8Array.from([0xec, 0x01, ...new Uint8Array(32)])],
    ] as const;

    it.each(unsupportedKeys)('rejects %s across all user DID paths before I/O', async (_name, key) => {
      const didKey = 'did:key:z' + base58.encode(key);
      vaultService.kvRead.mockClear();
      const operations = [
        () => didService.getUserAppId(didKey, 'vt'),
        () => didService.getUserDid(didKey, 'vt'),
        () => didService.getUserDidLive(didKey, 'vt'),
        () => didService.getUserDidLive(didKey, 'vt', 42n),
        () => didService.buildUserContractCreate({ didKey, vaultToken: 'vt' }),
        () => didService.submitUserContractCreate({ didKey, vaultToken: 'vt', signedTxns: [] }),
        () => didService.buildUserDidDocumentUpdate({ didKey, vaultToken: 'vt' }),
        () => didService.submitUserDidDocumentUpdate({ didKey, vaultToken: 'vt', document: {}, groups: [] }),
      ];
      for (const operation of operations) {
        await expect(operation()).rejects.toThrow(UnsupportedDidKeyError);
        await expect(operation()).rejects.toMatchObject({ didKey });
      }
      expect(vaultService.kvRead).not.toHaveBeenCalled();
      expect(vaultService.kvWrite).not.toHaveBeenCalled();
      expect(buildManagerSignerMock).not.toHaveBeenCalled();
      expect(DidAlgoStorageClientMock).not.toHaveBeenCalled();
      expect(resolveDIDDocumentMock).not.toHaveBeenCalled();
    });

    it.each([0, 31, 33, 1793])('rejects %i-byte raw keys before deriving, publishing, or deleting', async (length) => {
      const key = new Uint8Array(length);
      expect(() => didService.deriveDid(key)).toThrow(UnsupportedDidKeyError);
      expect(() => didService.buildControllerDocument(key)).toThrow(UnsupportedDidKeyError);
      expect(() => didService.buildUncontrolledDocument(key, USER_DID_KEY, 42n)).toThrow(UnsupportedDidKeyError);
      await expect(
        didService.publishControlledDid({ controller: 'pq', publicKey: key, vaultToken: 'vt' }),
      ).rejects.toThrow(UnsupportedDidKeyError);
      await expect(didService.deleteControlledDid(key, 'vt')).rejects.toThrow(UnsupportedDidKeyError);
      expect(buildManagerSignerMock).not.toHaveBeenCalled();
      expect(DidAlgoStorageClientMock).not.toHaveBeenCalled();
      expect(replaceDIDDocumentMock).not.toHaveBeenCalled();
      expect(deleteDIDDocumentMock).not.toHaveBeenCalled();
    });

    it('rejects a non-Ed25519 owner even with a standard document key', () => {
      const owner = 'did:key:z' + base58.encode(unsupportedKeys[1][1]);
      expect(() => didService.buildUncontrolledDocument(CONTROLLER_PUB_KEY, owner, 42n)).toThrow(
        UnsupportedDidKeyError,
      );
    });

    it('lists only Ed25519 identities without reading unsupported registry entries', async () => {
      jest.spyOn(didService['logger'], 'warn').mockImplementation(() => undefined);
      const invalidKey = 'did:key:z' + base58.encode(unsupportedKeys[0][1]);
      vaultService.kvList.mockResolvedValue([
        encodeURIComponent(invalidKey) + '/',
        encodeURIComponent(USER_DID_KEY) + '/',
      ]);
      vaultService.kvRead.mockClear();
      expect(await didService.listUserDids('vt')).toEqual([
        expect.objectContaining({ didKey: USER_DID_KEY, did: didService.deriveDid(CONTROLLER_PUB_KEY) }),
      ]);
      expect(vaultService.kvRead).toHaveBeenCalledTimes(1);
      expect(vaultService.kvRead).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent(USER_DID_KEY)), 'vt');
    });
  });

  describe('submitted DID signatures', () => {
    const signature = new Uint8Array(64).fill(1);
    const sdkTxn = makePaymentTxnWithSuggestedParamsFromObject({
      sender: MANAGER_ADDRESS.toString(),
      receiver: MANAGER_ADDRESS.toString(),
      amount: 1,
      suggestedParams: { fee: 1000, minFee: 1000, flatFee: true, firstValid: 1, lastValid: 1000 },
    });
    const txn = decodeTransaction(sdkTxn.bytesToSign());
    const unsigned = Buffer.from(encodeTransaction(txn)).toString('base64');
    const signed = encodeSignedTransaction({ txn, sig: signature });
    const envelope = msgpackRawDecode(signed) as Record<string, unknown>;
    const pq = { sch: Buffer.from('f1'), slt: 0, pk: new Uint8Array(1793), sig: new Uint8Array(1226) };
    const group: UserContractCreatePlan['group'] = {
      groupIdB64: '',
      txnGroup: [unsigned, unsigned, unsigned],
      indexesToSign: [2],
      signers: ['manager', 'manager', 'user'],
      kinds: ['pay', 'pay', 'pay'],
    };
    let broadcast: jest.Mock;

    beforeEach(() => {
      broadcast = jest.fn().mockResolvedValue({ txId: 'tx-id' });
      jest.spyOn(AlgorandClient, 'fromConfig').mockReturnValue({
        client: { algod: { sendRawTransaction: broadcast, simulateRawTransactions: jest.fn().mockResolvedValue({}) } },
      } as unknown as AlgorandClient);
      vaultService.kvRead.mockResolvedValue(undefined);
      vaultService.signAsManager.mockResolvedValue(
        Buffer.from(`vault:v1:${Buffer.from(signature).toString('base64')}`),
      );
      chainService.addSignatureToTxn.mockReturnValue(signed);
      jest.spyOn(didService, 'buildUserContractCreate').mockResolvedValue({
        didKey: USER_DID_KEY,
        userAddress: MANAGER_ADDRESS.toString(),
        managerAddress: MANAGER_ADDRESS.toString(),
        group,
      });
      jest
        .spyOn(didService, 'buildUserDidDocumentUpdate')
        .mockResolvedValue({ groups: [group, group] } as UserDidUpdatePlan);
    });

    it.each([
      ['PQ only', { txn: envelope.txn, pqsig: pq }],
      ['PQ alongside Ed25519', { ...envelope, pqsig: pq }],
      ['missing signature', { txn: envelope.txn }],
      ['short signature', { ...envelope, sig: new Uint8Array(63) }],
      ['logic signature', { ...envelope, lsig: { l: new Uint8Array([1]) } }],
      ['multisignature', { ...envelope, msig: { v: 1, thr: 1, subsig: [{ pk: CONTROLLER_PUB_KEY, s: signature }] } }],
    ])('rejects %s before signing or broadcasting any create/update group', async (_name, invalid) => {
      const signedTxns = [null, null, Buffer.from(msgpackRawEncode(invalid)).toString('base64')];
      await expect(
        didService.submitUserContractCreate({ didKey: USER_DID_KEY, vaultToken: 'vt', signedTxns }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        didService.submitUserDidDocumentUpdate({
          didKey: USER_DID_KEY,
          vaultToken: 'vt',
          document: {},
          groups: [{ signedTxns: [null, null, Buffer.from(signed).toString('base64')] }, { signedTxns }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(vaultService.signAsManager).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      expect(vaultService.kvWrite).not.toHaveBeenCalled();
    });

    it('continues to sponsor and broadcast standard Ed25519 updates', async () => {
      const signedTxns = [null, null, Buffer.from(signed).toString('base64')];
      await expect(
        didService.submitUserDidDocumentUpdate({
          didKey: USER_DID_KEY,
          vaultToken: 'vt',
          document: {},
          groups: [{ signedTxns }, { signedTxns }],
        }),
      ).resolves.toEqual({ txIds: ['tx-id', 'tx-id'] });
      expect(vaultService.signAsManager).toHaveBeenCalledTimes(4);
      expect(broadcast).toHaveBeenCalledTimes(2);
      expect(broadcast).toHaveBeenCalledWith([signed, signed, signed]);
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

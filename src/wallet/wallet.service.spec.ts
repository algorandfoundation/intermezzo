import createMockInstance from 'jest-create-mock-instance';
import { VaultService } from '../vault/vault.service';
import { WalletService } from './wallet.service';
import { ChainService } from '../chain/chain.service';
import { DidService } from '../did/did.service';
import { Oid4vcAgentProvider } from '../oid4vc/agent/oid4vc-agent.provider';
import { CreateAssetDto } from './create-asset.dto';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { ManagerDetailDto } from './manager-detail.dto';
import { plainToClass } from 'class-transformer';
import { randomBytes } from 'crypto';
import { Address, encodeAddress } from '@algorandfoundation/algokit-utils';
import {
  decodeTransaction,
  encodeSignedTransaction,
  encodeTransaction,
  Transaction,
  TransactionType,
} from '@algorandfoundation/algokit-utils/transact';
import {
  TruncatedAccountAssetResponse,
  TruncatedAccountResponse,
  TruncatedSuggestedParamsResponse,
} from 'src/chain/algo-node-responses';

describe('WalletService', () => {
  let walletService: WalletService;
  let vaultServiceMock: jest.Mocked<VaultService>;
  let chainServiceMock: jest.Mocked<ChainService>;
  let configServiceMock: jest.Mocked<ConfigService>;
  let didServiceMock: jest.Mocked<DidService>;
  let oid4vcAgentProviderMock: jest.Mocked<Oid4vcAgentProvider>;

  let chainService: ChainService;
  let httpService: HttpService;

  beforeEach(async () => {
    vaultServiceMock = createMockInstance(VaultService);
    chainServiceMock = createMockInstance(ChainService);
    configServiceMock = createMockInstance(ConfigService);
    didServiceMock = createMockInstance(DidService);
    didServiceMock.publishControlledDid.mockResolvedValue({
      did: 'did:algo:test:app:1:00',
      document: {} as never,
      txIds: [],
    });
    didServiceMock.deriveDid.mockReturnValue('did:algo:test:app:1:derived');
    oid4vcAgentProviderMock = createMockInstance(Oid4vcAgentProvider);
    walletService = new WalletService(
      vaultServiceMock,
      chainServiceMock,
      configServiceMock,
      didServiceMock,
      oid4vcAgentProviderMock,
    );

    httpService = createMockInstance(HttpService);
    chainService = new ChainService(configServiceMock, httpService);

    configServiceMock.get.mockImplementation((key: string) => {
      const config = {
        GENESIS_ID: 'test-genesis-id',
        GENESIS_HASH: 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
        NODE_HTTP_SCHEME: 'http',
        NODE_HOST: 'localhost',
        NODE_PORT: '4001',
        NODE_TOKEN: 'test-token',
      };
      return config[key];
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('\(OK) userCreate()', async () => {
    const pubKey = randomBytes(32);
    const userId = '123581253191824129481240513501928401928';

    vaultServiceMock.transitCreateKey.mockResolvedValueOnce(pubKey);
    chainServiceMock.getAccountBalance.mockResolvedValueOnce(0n);

    const result = await walletService.userCreate(userId, 'vault_token');

    expect(result).toStrictEqual({
      public_address: new Address(pubKey).toString(),
      user_id: userId,
      algoBalance: '0',
    });
  });

  it('\(OK) getKeys()', async () => {
    const pubKey = randomBytes(32);
    const userId = '123581253191824129481240513501928401928';

    vaultServiceMock.getUserPublicKey.mockResolvedValueOnce(pubKey);
    vaultServiceMock.getKeys.mockResolvedValueOnce([
      {
        user_id: userId,
        public_address: Buffer.from(pubKey).toString('base64'), // public_address here is actually publicKey from the vault
      },
    ]);

    chainServiceMock.getAccountBalance.mockResolvedValueOnce(0n);

    const result = await walletService.getKeys('vault_token');
    expect(result).toStrictEqual([
      {
        public_address: new Address(pubKey).toString(),
        user_id: userId,
      },
    ]);
  });

  it('getUserInfo() test', async () => {
    const pubKey = randomBytes(32);
    const algoBalanceMock = 10n;

    chainServiceMock.getAccountBalance.mockResolvedValueOnce(algoBalanceMock);
    vaultServiceMock.getUserPublicKey.mockResolvedValueOnce(pubKey);

    const result = await walletService.getUserInfo('123581253191824129481240513501928401928', 'vault_token');

    expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledWith(
      '123581253191824129481240513501928401928',
      'vault_token',
    );
    expect(result).toStrictEqual({
      public_address: new Address(pubKey).toString(),
      user_id: '123581253191824129481240513501928401928',
      algoBalance: algoBalanceMock.toString(),
    });
  });

  it('getManagerInfo() test', async () => {
    const pubKey = randomBytes(32);
    const algoBalanceMock = 10n;

    chainServiceMock.getAccountBalance.mockResolvedValueOnce(algoBalanceMock);
    chainServiceMock.getAccountAssetHoldings.mockResolvedValueOnce([]);

    vaultServiceMock.getManagerPublicKey.mockResolvedValueOnce(pubKey);

    const result = await walletService.getManagerInfo('vault_token');

    expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith('vault_token');

    expect(result).toStrictEqual(
      plainToClass(ManagerDetailDto, {
        public_address: new Address(pubKey).toString(),
        algoBalance: algoBalanceMock.toString(),
        assets: [],
      }),
    );
  });

  it('\(OK) createAsset()', async () => {
    const pubKey = randomBytes(32);

    const address = new Address(pubKey).toString();

    const createAssetDto: CreateAssetDto = {
      total: 5,
      decimals: BigInt(2),
      defaultFrozen: false,
      unitName: 'Tasst',
      assetName: 'Test Asset',
      url: 'https://example.com',
      managerAddress: address,
      reserveAddress: address,
      freezeAddress: address,
      clawbackAddress: address,
    };

    const vaultToken = 'vault_token';
    const tx = new Uint8Array(5); // Initialize with an empty Uint8Array
    const signedTx = new Uint8Array(64); // Initialize with an empty Uint8Array
    const signature = Buffer.from(`vault:1:${Buffer.from(signedTx).toString('base64')}`, 'utf-8');
    const transactionId = 'transactionId';

    vaultServiceMock.getManagerPublicKey.mockResolvedValueOnce(pubKey);
    chainServiceMock.craftAssetCreateTx.mockResolvedValueOnce(tx);
    vaultServiceMock.signAsManager.mockResolvedValueOnce(signature);
    chainServiceMock.addSignatureToTxn.mockReturnValueOnce(signedTx);
    chainServiceMock.submitTransaction.mockResolvedValueOnce({ txid: transactionId } as any);

    const result = await walletService.createAsset(createAssetDto, vaultToken);

    expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith(vaultToken);
    expect(chainServiceMock.craftAssetCreateTx).toHaveBeenCalledWith(address, createAssetDto);
    expect(vaultServiceMock.signAsManager).toHaveBeenCalledWith(tx, vaultToken);
    expect(chainServiceMock.addSignatureToTxn).toHaveBeenCalledWith(tx, signedTx);
    expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith(signedTx);
    expect(result).toBe(transactionId);
  });

  describe('transferAsset()', () => {
    const userPubKey = randomBytes(32);
    const managerPubKey = randomBytes(32);

    const assetId = 1n;
    const userId = 'user123';
    const amount = 10;
    const lease = randomBytes(32).toString('base64');
    const note = 'Note to self: notes are recorded for all';
    const vaultToken = 'vault_token';
    const userPublicAddress = new Address(userPubKey).toString();
    const managerPublicAddress = new Address(managerPubKey).toString();
    const suggestedParams = {
      minFee: 1000,
      lastRound: 1n,
    } as TruncatedSuggestedParamsResponse;

    const dummySignedManagerTx1 = new Uint8Array([4]);
    const dummySignedUserTx = new Uint8Array([5]);
    const dummySignedManagerTx2 = new Uint8Array([6]);

    beforeEach(async () => {
      chainServiceMock.getSuggestedParams.mockResolvedValueOnce(suggestedParams);
      chainServiceMock.submitTransaction.mockResolvedValueOnce({ txid: 'final_tx_id' } as any);
      vaultServiceMock.getUserPublicKey.mockResolvedValueOnce(userPubKey);
      vaultServiceMock.getManagerPublicKey.mockResolvedValueOnce(managerPubKey);

      // not mock tx creation, and set group id functions
      chainServiceMock.craftAssetTransferTx.mockImplementation((...args) => chainService.craftAssetTransferTx(...args));
      chainServiceMock.craftPaymentTx.mockImplementation((...args) => chainService.craftPaymentTx(...args));
      chainServiceMock.setGroupID.mockImplementation((...args) => chainService.setGroupID(...args));

      // signed tx mocks
      walletService.signTxAsManager = jest
        .fn()
        .mockResolvedValueOnce(dummySignedManagerTx1)
        .mockResolvedValueOnce(dummySignedManagerTx2);
      walletService.signTxAsUser = jest.fn().mockResolvedValueOnce(dummySignedUserTx);
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('transferAsset() -- test if user not exists', async () => {
      chainServiceMock.getAccountAsset.mockResolvedValueOnce(null); // user has not opted in
      chainServiceMock.getAccountDetail.mockResolvedValueOnce({
        amount: 0n,
        minBalance: 100000n,
      } as TruncatedAccountResponse);
      const expectedExtraAlgoNeed = 201000;
      const algoBalance = 0n;

      // Mock the getAccountBalance to return a balance that is not enough
      chainServiceMock.getAccountBalance.mockResolvedValueOnce(algoBalance);

      // Call
      const result = await walletService.transferAsset(vaultToken, assetId, userId, amount);

      // Verify the flow.
      expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledWith(userId, vaultToken);
      expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith(vaultToken);
      expect(chainServiceMock.getSuggestedParams).toHaveBeenCalled();
      expect(chainServiceMock.getAccountAsset).toHaveBeenCalledWith(userPublicAddress, assetId);
      expect(chainServiceMock.getAccountDetail).toHaveBeenCalledWith(userPublicAddress);

      expect(chainServiceMock.craftPaymentTx).toHaveBeenCalledWith(
        managerPublicAddress,
        userPublicAddress,
        expectedExtraAlgoNeed,
        suggestedParams,
      );
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenNthCalledWith(
        1,
        userPublicAddress,
        userPublicAddress,
        assetId,
        0,
        undefined,
        undefined,
        suggestedParams,
      );
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenNthCalledWith(
        2,
        managerPublicAddress,
        userPublicAddress,
        assetId,
        amount,
        undefined,
        undefined,
        suggestedParams,
      );

      expect(walletService.signTxAsManager).toHaveBeenCalledTimes(2);
      expect(walletService.signTxAsUser).toHaveBeenCalledTimes(1);

      expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith([
        dummySignedManagerTx1,
        dummySignedUserTx,
        dummySignedManagerTx2,
      ]);

      expect(result).toBe('final_tx_id');
    });

    it('transferAsset() -- user exists -- not opted in -- not enough algo', async () => {
      chainServiceMock.getAccountAsset.mockResolvedValueOnce(null); // user has not opted in
      chainServiceMock.getAccountDetail.mockResolvedValueOnce({
        amount: 100100n,
        minBalance: 100000n,
      } as TruncatedAccountResponse);
      const expectedExtraAlgoNeed = 100900;
      const algoBalance = 0n;

      // Mock the getAccountBalance to return a balance
      chainServiceMock.getAccountBalance.mockResolvedValueOnce(algoBalance);

      // Call
      const result = await walletService.transferAsset(vaultToken, assetId, userId, amount);

      // Verify the flow.
      expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledWith(userId, vaultToken);
      expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith(vaultToken);
      expect(chainServiceMock.getSuggestedParams).toHaveBeenCalled();
      expect(chainServiceMock.getAccountAsset).toHaveBeenCalledWith(userPublicAddress, assetId);
      expect(chainServiceMock.getAccountDetail).toHaveBeenCalledWith(userPublicAddress);

      expect(chainServiceMock.craftPaymentTx).toHaveBeenCalledWith(
        managerPublicAddress,
        userPublicAddress,
        expectedExtraAlgoNeed,
        suggestedParams,
      );
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenNthCalledWith(
        1,
        userPublicAddress,
        userPublicAddress,
        assetId,
        0,
        undefined,
        undefined,
        suggestedParams,
      );
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenNthCalledWith(
        2,
        managerPublicAddress,
        userPublicAddress,
        assetId,
        amount,
        undefined,
        undefined,
        suggestedParams,
      );

      expect(walletService.signTxAsManager).toHaveBeenCalledTimes(2);
      expect(walletService.signTxAsUser).toHaveBeenCalledTimes(1);

      expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith([
        dummySignedManagerTx1,
        dummySignedUserTx,
        dummySignedManagerTx2,
      ]);

      expect(result).toBe('final_tx_id');
    });

    it('transferAsset() -- user exists -- opted in -- has enough algo', async () => {
      chainServiceMock.getAccountAsset.mockResolvedValueOnce({} as TruncatedAccountAssetResponse); // opted in
      chainServiceMock.getAccountDetail.mockResolvedValueOnce({
        amount: 220000n,
        minBalance: 200000n,
      } as TruncatedAccountResponse);
      const algoBalance = 2200000n;

      // Mock the getAccountBalance to return a balance
      chainServiceMock.getAccountBalance.mockResolvedValueOnce(algoBalance);

      // Call
      const result = await walletService.transferAsset(vaultToken, assetId, userId, amount);

      // Verify the flow.
      expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledWith(userId, vaultToken);
      expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith(vaultToken);
      expect(chainServiceMock.getSuggestedParams).toHaveBeenCalled();
      expect(chainServiceMock.getAccountAsset).toHaveBeenCalledWith(userPublicAddress, assetId);
      expect(chainServiceMock.getAccountDetail).toHaveBeenCalledWith(userPublicAddress);

      expect(chainServiceMock.craftPaymentTx).toHaveBeenCalledTimes(0);
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenCalledTimes(1);
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenNthCalledWith(
        1,
        managerPublicAddress,
        userPublicAddress,
        assetId,
        amount,
        undefined,
        undefined,
        suggestedParams,
      );

      expect(walletService.signTxAsManager).toHaveBeenCalledTimes(1);
      expect(walletService.signTxAsUser).toHaveBeenCalledTimes(0);

      expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith([dummySignedManagerTx1]);

      expect(result).toBe('final_tx_id');
    });

    it('transferAsset() -- user exists -- opted in -- has enough algo -- with lease and note', async () => {
      chainServiceMock.getAccountAsset.mockResolvedValueOnce({} as TruncatedAccountAssetResponse); // opted in
      chainServiceMock.getAccountDetail.mockResolvedValueOnce({
        amount: 220000n,
        minBalance: 200000n,
      } as TruncatedAccountResponse);

      const algoBalance = 2200000n;

      // Mock the getAccountBalance to return a balance
      chainServiceMock.getAccountBalance.mockResolvedValueOnce(algoBalance);

      // Call
      const result = await walletService.transferAsset(vaultToken, assetId, userId, amount, lease, note);

      // Verify the flow.
      expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledWith(userId, vaultToken);
      expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith(vaultToken);
      expect(chainServiceMock.getSuggestedParams).toHaveBeenCalled();
      expect(chainServiceMock.getAccountAsset).toHaveBeenCalledWith(userPublicAddress, assetId);
      expect(chainServiceMock.getAccountDetail).toHaveBeenCalledWith(userPublicAddress);

      expect(chainServiceMock.craftPaymentTx).toHaveBeenCalledTimes(0);
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenCalledTimes(1);
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenNthCalledWith(
        1,
        managerPublicAddress,
        userPublicAddress,
        assetId,
        amount,
        lease,
        note,
        suggestedParams,
      );

      expect(walletService.signTxAsManager).toHaveBeenCalledTimes(1);
      expect(walletService.signTxAsUser).toHaveBeenCalledTimes(0);

      expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith([dummySignedManagerTx1]);

      expect(result).toBe('final_tx_id');
    });

    it('transferAsset() -- user exists -- not opted in -- has enough algo', async () => {
      chainServiceMock.getAccountAsset.mockResolvedValueOnce(null);
      chainServiceMock.getAccountDetail.mockResolvedValueOnce({
        amount: 200000n + BigInt(suggestedParams.minFee),
        minBalance: 100000n,
      } as TruncatedAccountResponse);

      const algoBalance = 2200000n;

      // Mock the getAccountBalance to return a balance
      chainServiceMock.getAccountBalance.mockResolvedValueOnce(algoBalance);

      // Call
      const result = await walletService.transferAsset(vaultToken, assetId, userId, amount);

      // Verify the flow.
      expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledWith(userId, vaultToken);
      expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith(vaultToken);
      expect(chainServiceMock.getSuggestedParams).toHaveBeenCalled();
      expect(chainServiceMock.getAccountAsset).toHaveBeenCalledWith(userPublicAddress, assetId);
      expect(chainServiceMock.getAccountDetail).toHaveBeenCalledWith(userPublicAddress);

      expect(chainServiceMock.craftPaymentTx).toHaveBeenCalledTimes(0);
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenNthCalledWith(
        1,
        userPublicAddress,
        userPublicAddress,
        assetId,
        0,
        undefined,
        undefined,
        suggestedParams,
      );
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenNthCalledWith(
        2,
        managerPublicAddress,
        userPublicAddress,
        assetId,
        amount,
        undefined,
        undefined,
        suggestedParams,
      );

      expect(walletService.signTxAsManager).toHaveBeenCalledTimes(1);
      expect(walletService.signTxAsUser).toHaveBeenCalledTimes(1);

      expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith([dummySignedUserTx, dummySignedManagerTx1]);

      expect(result).toBe('final_tx_id');
    });
  });

  describe('clawbackAsset()', () => {
    const userPubKey = randomBytes(32);
    const managerPubKey = randomBytes(32);

    const assetId = 1n;
    const userId = 'user123';
    const amount = 10;
    const lease = randomBytes(32).toString('base64');
    const note = 'Note to self: notes are recorded for all';
    const vaultToken = 'vault_token';
    const userPublicAddress = new Address(userPubKey).toString();
    const managerPublicAddress = new Address(managerPubKey).toString();
    const suggestedParams = {
      minFee: 1000,
      lastRound: 1n,
    } as TruncatedSuggestedParamsResponse;
    const dummySignedManagerTx1 = new Uint8Array([4]);
    const dummySignedUserTx = new Uint8Array([5]);
    const dummySignedManagerTx2 = new Uint8Array([6]);

    beforeEach(async () => {
      chainServiceMock.getSuggestedParams.mockResolvedValueOnce(suggestedParams);
      chainServiceMock.submitTransaction.mockResolvedValueOnce({
        txid: 'final_tx_id',
      } as any);
      vaultServiceMock.getUserPublicKey.mockResolvedValueOnce(userPubKey);
      vaultServiceMock.getManagerPublicKey.mockResolvedValueOnce(managerPubKey);

      // not mock tx creation, and set group id functions
      chainServiceMock.craftAssetTransferTx.mockImplementation((...args) => chainService.craftAssetTransferTx(...args));
      chainServiceMock.craftPaymentTx.mockImplementation((...args) => chainService.craftPaymentTx(...args));
      chainServiceMock.setGroupID.mockImplementation((...args) => chainService.setGroupID(...args));

      chainServiceMock.getAccountBalance.mockResolvedValueOnce(1000000n); // Mock default balance

      // signed tx mocks
      walletService.signTxAsManager = jest
        .fn()
        .mockResolvedValueOnce(dummySignedManagerTx1)
        .mockResolvedValueOnce(dummySignedManagerTx2);
      walletService.signTxAsUser = jest.fn().mockResolvedValueOnce(dummySignedUserTx);
    });
    afterEach(() => {
      jest.clearAllMocks();
    });
    it('clawbackAsset() -- test clawback', async () => {
      // Call
      const result = await walletService.clawbackAsset(vaultToken, assetId, userId, amount, lease, note);

      // Verify the flow.
      expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledWith(userId, vaultToken);
      expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith(vaultToken);
      expect(chainServiceMock.getSuggestedParams).toHaveBeenCalled();

      expect(chainServiceMock.craftAssetClawbackTx).toHaveBeenNthCalledWith(
        1,
        managerPublicAddress,
        userPublicAddress,
        managerPublicAddress,
        assetId,
        amount,
        lease,
        note,
        suggestedParams,
      );

      expect(walletService.signTxAsManager).toHaveBeenCalledTimes(1);

      expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith(dummySignedManagerTx1);

      expect(result).toBe('final_tx_id');
    });
  });

  describe('appCall()', () => {
    const managerPubKey = randomBytes(32);
    const userPubKey = randomBytes(32);
    const managerPublicAddress = new Address(managerPubKey).toString();
    const userPublicAddress = new Address(userPubKey).toString();
    const vaultToken = 'vault_token';
    const suggestedParams = { minFee: 1000, lastRound: 1n } as TruncatedSuggestedParamsResponse;
    const dummyAppTx = new Uint8Array([10, 11, 12]);
    const dummySignedTx = new Uint8Array([20, 21, 22]);

    beforeEach(() => {
      chainServiceMock.getSuggestedParams.mockResolvedValueOnce(suggestedParams);
      chainServiceMock.craftAppCallTx.mockResolvedValueOnce(dummyAppTx);
      chainServiceMock.submitTransaction.mockResolvedValueOnce({ txid: 'appcall_tx_id' } as any);
      walletService.signTxAsManager = jest.fn().mockResolvedValueOnce(dummySignedTx);
      walletService.signTxAsUser = jest.fn().mockResolvedValueOnce(dummySignedTx);
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('appCall() -- as manager', async () => {
      vaultServiceMock.getManagerPublicKey.mockResolvedValueOnce(managerPubKey);

      const dto = { fromUserId: 'manager', appId: 123, onComplete: 0 } as any;
      const result = await walletService.appCall(vaultToken, dto);

      expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith(vaultToken);
      expect(chainServiceMock.getSuggestedParams).toHaveBeenCalled();
      expect(chainServiceMock.craftAppCallTx).toHaveBeenCalledWith(
        managerPublicAddress,
        dto,
        suggestedParams,
        undefined,
      );
      expect(walletService.signTxAsManager).toHaveBeenCalledWith(dummyAppTx, vaultToken);
      expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith(dummySignedTx);
      expect(result).toBe('appcall_tx_id');
    });

    it('appCall() -- as user', async () => {
      vaultServiceMock.getUserPublicKey.mockResolvedValueOnce(userPubKey);
      chainServiceMock.getAccountBalance.mockResolvedValueOnce(1000000n);

      const userId = 'user123';
      const dto = { fromUserId: userId, appId: 123, onComplete: 0 } as any;
      const result = await walletService.appCall(vaultToken, dto);

      expect(chainServiceMock.craftAppCallTx).toHaveBeenCalledWith(userPublicAddress, dto, suggestedParams, undefined);
      expect(walletService.signTxAsUser).toHaveBeenCalledWith(userId, dummyAppTx, vaultToken);
      expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith(dummySignedTx);
      expect(result).toBe('appcall_tx_id');
    });

    it('appCall() -- with fee override', async () => {
      vaultServiceMock.getManagerPublicKey.mockResolvedValueOnce(managerPubKey);

      const dto = { fromUserId: 'manager', appId: 123, onComplete: 0, fee: 2000 } as any;
      await walletService.appCall(vaultToken, dto);

      expect(chainServiceMock.craftAppCallTx).toHaveBeenCalledWith(managerPublicAddress, dto, suggestedParams, 2000);
    });
  });

  describe('groupTransaction()', () => {
    const managerPubKey = randomBytes(32);
    const userPubKey = randomBytes(32);
    const managerPublicAddress = new Address(managerPubKey).toString();
    const userPublicAddress = new Address(userPubKey).toString();
    const vaultToken = 'vault_token';
    const suggestedParams = { minFee: 1000, lastRound: 1n } as TruncatedSuggestedParamsResponse;
    const dummyTx1 = new Uint8Array([1, 2, 3]);
    const dummyTx2 = new Uint8Array([4, 5, 6]);
    const dummyGroupedTx1 = new Uint8Array([7, 8, 9]);
    const dummyGroupedTx2 = new Uint8Array([10, 11, 12]);
    const dummySignedManagerTx = new Uint8Array([20]);
    const dummySignedUserTx = new Uint8Array([21]);

    beforeEach(() => {
      vaultServiceMock.getManagerPublicKey.mockResolvedValue(managerPubKey);
      chainServiceMock.getSuggestedParams.mockResolvedValue(suggestedParams);
      chainServiceMock.submitTransaction.mockResolvedValue({ txid: 'group_tx_id' } as any);
      walletService.signTxAsManager = jest.fn().mockResolvedValue(dummySignedManagerTx);
      walletService.signTxAsUser = jest.fn().mockResolvedValue(dummySignedUserTx);
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('groupTransaction() -- throws if transactions is empty', async () => {
      await expect(walletService.groupTransaction(vaultToken, { transactions: [] } as any)).rejects.toThrow(
        'transactions is required and must be a non-empty array',
      );
    });

    it('groupTransaction() -- throws on unsupported transaction type', async () => {
      chainServiceMock.setGroupID.mockReturnValueOnce([dummyGroupedTx1]);

      await expect(
        walletService.groupTransaction(vaultToken, {
          transactions: [{ type: 'unknown', payload: {} }],
        } as any),
      ).rejects.toThrow('Unsupported transaction type: unknown');
    });

    it('groupTransaction() -- payment + appCall as manager', async () => {
      chainServiceMock.craftPaymentTx.mockResolvedValueOnce(dummyTx1);
      chainServiceMock.craftAppCallTx.mockResolvedValueOnce(dummyTx2);
      chainServiceMock.setGroupID.mockReturnValueOnce([dummyGroupedTx1, dummyGroupedTx2]);

      // Mock decodeTransaction to return manager sender for both grouped txs
      const managerSndAddress = Address.fromString(managerPublicAddress);
      jest
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        .spyOn(require('@algorandfoundation/algokit-utils/transact'), 'decodeTransaction')
        .mockReturnValue({ sender: managerSndAddress } as any);

      const groupRequestDto = {
        transactions: [
          { type: 'payment', payload: { fromUserId: 'manager', toAddress: userPublicAddress, amount: 1000 } },
          { type: 'appCall', payload: { fromUserId: 'manager', appId: 123, onComplete: 0 } },
        ],
      } as any;

      const result = await walletService.groupTransaction(vaultToken, groupRequestDto);

      expect(chainServiceMock.craftPaymentTx).toHaveBeenCalledWith(
        managerPublicAddress,
        userPublicAddress,
        1000,
        suggestedParams,
      );
      expect(chainServiceMock.craftAppCallTx).toHaveBeenCalledWith(
        managerPublicAddress,
        groupRequestDto.transactions[1].payload,
        suggestedParams,
        undefined,
      );
      expect(result).toBe('group_tx_id');

      jest.restoreAllMocks();
    });

    it('groupTransaction() -- throws if no transactions after processing', async () => {
      await expect(walletService.groupTransaction(vaultToken, { transactions: [] } as any)).rejects.toThrow(
        'transactions is required and must be a non-empty array',
      );
    });
  });

  describe('sponsorTransactionGroup()', () => {
    const sponsorPublicKey = randomBytes(32);
    const userPublicKey = randomBytes(32);
    const sponsorAddress = encodeAddress(sponsorPublicKey);
    const userAddress = encodeAddress(userPublicKey);
    const vaultToken = 'sponsor_vault_token';
    const testGenesisHash = new Uint8Array(32); // 32 zero bytes, valid for tests

    let walletServiceWithRealChain: WalletService;

    const buildPay = (from: string, to: string, amount: number, fee: number): Uint8Array => {
      const txn = new Transaction({
        type: TransactionType.Payment,
        sender: Address.fromString(from),
        fee: BigInt(fee),
        firstValid: 1n,
        lastValid: 1001n,
        genesisId: 'test-genesis-id',
        genesisHash: testGenesisHash,
        payment: { receiver: Address.fromString(to), amount: BigInt(amount) },
      });
      return encodeTransaction(txn);
    };

    const toB64 = (tx: Uint8Array): string => Buffer.from(tx).toString('base64');

    const signUserTxn = (tx: Uint8Array): Uint8Array => {
      // Produce a signed-transaction msgpack envelope `{ txn, sig }` with a dummy non-zero signature.
      const decoded = decodeTransaction(tx);
      return encodeSignedTransaction({ txn: decoded, sig: new Uint8Array(64).fill(1) });
    };

    beforeEach(() => {
      vaultServiceMock.getManagerPublicKey.mockResolvedValue(sponsorPublicKey);
      vaultServiceMock.signAsManager.mockResolvedValue(
        Buffer.from(`vault:v1:${Buffer.from(new Uint8Array(64)).toString('base64')}`),
      );
      walletServiceWithRealChain = new WalletService(
        vaultServiceMock,
        chainService,
        configServiceMock,
        didServiceMock,
        oid4vcAgentProviderMock,
      );
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const buildValidGroup = (sponsorFee = 2000, userFee = 0): { sponsor: Uint8Array; user: Uint8Array } => {
      const sponsorTx = buildPay(sponsorAddress, sponsorAddress, 0, sponsorFee);
      const userTx = buildPay(userAddress, sponsorAddress, 1000, userFee);
      const grouped = chainService.setGroupID([sponsorTx, userTx]);
      return { sponsor: grouped[0], user: signUserTxn(grouped[1]) };
    };

    it('(OK) sponsorTransactionGroup() -- signs sponsor txn, returns user txn unchanged', async () => {
      jest
        .spyOn(chainService, 'getSuggestedParams')
        .mockResolvedValue({ minFee: 1000, lastRound: 1n } as TruncatedSuggestedParamsResponse);

      const { sponsor, user } = buildValidGroup();
      const base64 = [toB64(sponsor), toB64(user)];

      const result = await walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, { transactions: base64 });

      expect(result.transactions).toHaveLength(2);
      expect(result.group_id).toBeDefined();
      expect(vaultServiceMock.signAsManager).toHaveBeenCalledTimes(1);
      // user txn returned as-is
      expect(result.transactions[1]).toBe(base64[1]);
      // sponsor txn replaced with signed bytes
      expect(result.transactions[0]).not.toBe(base64[0]);
    });

    it('throws on empty transactions array', async () => {
      await expect(
        walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, { transactions: [] }),
      ).rejects.toThrow('Transactions array is required and must not be empty');
    });

    it('throws when group is too small', async () => {
      const sponsorTx = buildPay(sponsorAddress, sponsorAddress, 0, 1000);
      await expect(
        walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, { transactions: [toB64(sponsorTx)] }),
      ).rejects.toThrow('Sponsored group must contain at least the sponsor fee txn and one user txn');
    });

    it('throws when transactions have different group ids', async () => {
      const sponsorTx = buildPay(sponsorAddress, sponsorAddress, 0, 2000);
      const userTx = buildPay(userAddress, sponsorAddress, 1000, 0);
      // group them separately so each has a distinct grp
      const g1 = chainService.setGroupID([sponsorTx]);
      const g2 = chainService.setGroupID([userTx]);
      const base64 = [toB64(g1[0]), toB64(signUserTxn(g2[0]))];

      await expect(
        walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, { transactions: base64 }),
      ).rejects.toThrow('All transactions must belong to the same group');
    });

    it('throws when sponsor txn (index 0) is signed', async () => {
      jest
        .spyOn(chainService, 'getSuggestedParams')
        .mockResolvedValue({ minFee: 1000, lastRound: 1n } as TruncatedSuggestedParamsResponse);
      const { sponsor, user } = buildValidGroup();
      const base64 = [toB64(signUserTxn(sponsor)), toB64(user)];

      await expect(
        walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, { transactions: base64 }),
      ).rejects.toThrow('Sponsor fee transaction (index 0) must be unsigned');
    });

    it('throws when sponsor txn sender is not the sponsor', async () => {
      const sponsorTx = buildPay(userAddress, sponsorAddress, 0, 2000);
      const userTx = buildPay(userAddress, sponsorAddress, 1000, 0);
      const grouped = chainService.setGroupID([sponsorTx, userTx]);
      const base64 = [toB64(grouped[0]), toB64(signUserTxn(grouped[1]))];

      await expect(
        walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, { transactions: base64 }),
      ).rejects.toThrow('Sponsor fee transaction sender must be the sponsor address');
    });

    it('throws when sponsor txn receiver is not the sponsor', async () => {
      const sponsorTx = buildPay(sponsorAddress, userAddress, 0, 2000);
      const userTx = buildPay(userAddress, sponsorAddress, 1000, 0);
      const grouped = chainService.setGroupID([sponsorTx, userTx]);
      const base64 = [toB64(grouped[0]), toB64(signUserTxn(grouped[1]))];

      await expect(
        walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, { transactions: base64 }),
      ).rejects.toThrow('Sponsor fee transaction receiver must be the sponsor address');
    });

    it('throws when sponsor txn amount is non-zero', async () => {
      const sponsorTx = buildPay(sponsorAddress, sponsorAddress, 100, 2000);
      const userTx = buildPay(userAddress, sponsorAddress, 1000, 0);
      const grouped = chainService.setGroupID([sponsorTx, userTx]);
      const base64 = [toB64(grouped[0]), toB64(signUserTxn(grouped[1]))];

      await expect(
        walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, { transactions: base64 }),
      ).rejects.toThrow('Sponsor fee transaction amount must be 0');
    });

    it('throws when a user txn is unsigned', async () => {
      jest
        .spyOn(chainService, 'getSuggestedParams')
        .mockResolvedValue({ minFee: 1000, lastRound: 1n } as TruncatedSuggestedParamsResponse);
      const sponsorTx = buildPay(sponsorAddress, sponsorAddress, 0, 2000);
      const userTx = buildPay(userAddress, sponsorAddress, 1000, 0);
      const grouped = chainService.setGroupID([sponsorTx, userTx]);
      // do NOT sign the user txn
      const base64 = [toB64(grouped[0]), toB64(grouped[1])];

      await expect(
        walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, { transactions: base64 }),
      ).rejects.toThrow('User transaction at index 1 must be signed by the user');
    });

    it('throws when a user txn has non-zero fee', async () => {
      jest
        .spyOn(chainService, 'getSuggestedParams')
        .mockResolvedValue({ minFee: 1000, lastRound: 1n } as TruncatedSuggestedParamsResponse);
      const { sponsor } = buildValidGroup();
      // rebuild a fee-bearing user txn in the same group
      const sponsorTx = buildPay(sponsorAddress, sponsorAddress, 0, 2000);
      const userTx = buildPay(userAddress, sponsorAddress, 1000, 500);
      const grouped = chainService.setGroupID([sponsorTx, userTx]);
      const base64 = [toB64(grouped[0]), toB64(signUserTxn(grouped[1]))];
      void sponsor; // silence unused

      await expect(
        walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, { transactions: base64 }),
      ).rejects.toThrow('User transaction at index 1 must have fee = 0');
    });

    it('throws when a user txn is sent from the sponsor address', async () => {
      jest
        .spyOn(chainService, 'getSuggestedParams')
        .mockResolvedValue({ minFee: 1000, lastRound: 1n } as TruncatedSuggestedParamsResponse);
      const sponsorTx = buildPay(sponsorAddress, sponsorAddress, 0, 2000);
      // user txn whose sender is also the sponsor (disallowed)
      const userTx = buildPay(sponsorAddress, userAddress, 1000, 0);
      const grouped = chainService.setGroupID([sponsorTx, userTx]);
      const base64 = [toB64(grouped[0]), toB64(signUserTxn(grouped[1]))];

      await expect(
        walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, { transactions: base64 }),
      ).rejects.toThrow('User transaction at index 1 must not be sent from the sponsor address');
    });

    it('throws when sponsor fee does not cover the group', async () => {
      jest
        .spyOn(chainService, 'getSuggestedParams')
        .mockResolvedValue({ minFee: 1000, lastRound: 1n } as TruncatedSuggestedParamsResponse);
      // requiredFee = 1000 * 2 = 2000; supply only 500
      const { sponsor, user } = buildValidGroup(500, 0);
      const base64 = [toB64(sponsor), toB64(user)];

      await expect(
        walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, { transactions: base64 }),
      ).rejects.toThrow(/Sponsor fee transaction fee \(500\) is below required fee \(2000\)/);
    });

    it('honours feeMultiplier when validating sponsor fee', async () => {
      jest
        .spyOn(chainService, 'getSuggestedParams')
        .mockResolvedValue({ minFee: 1000, lastRound: 1n } as TruncatedSuggestedParamsResponse);
      // requiredFee = 1000 * 2 * 1.5 = 3000; supply 2500 -> should fail
      const { sponsor, user } = buildValidGroup(2500, 0);
      const base64 = [toB64(sponsor), toB64(user)];

      await expect(
        walletServiceWithRealChain.sponsorTransactionGroup(vaultToken, {
          transactions: base64,
          feeMultiplier: 1.5,
        }),
      ).rejects.toThrow(/below required fee \(3000\)/);
    });
  });

  describe('getSponsorInfo()', () => {
    it('returns the sponsor public address', async () => {
      const pubKey = randomBytes(32);
      vaultServiceMock.getManagerPublicKey.mockResolvedValueOnce(pubKey);

      const result = await walletService.getSponsorInfo('vault_token');

      expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith('vault_token');
      expect(result).toStrictEqual({
        public_address: encodeAddress(pubKey),
      });
    });
  });

  describe('deployManagerIdentity()', () => {
    it('maps algod overspend errors to UnprocessableEntityException with a friendly message', async () => {
      const overspendMessage =
        'Error resolving execution info via simulate in transaction 0: ' +
        'transaction CWNRIIDBLS22ZUFNQPM7Y7PFOTLF4B75PUZ4L53T4KCWICJF66HQ: ' +
        'overspend (account 3E6ZXNHDFE4FJCLUKNUOHFUGHHOHA7N2QNFVU2HH7FUSQUAGPITQLCGB5E, ' +
        'tried to spend {1000})';
      didServiceMock.deployStorage.mockRejectedValueOnce(new Error(overspendMessage));

      await expect(walletService.deployManagerIdentity('vault_token')).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining('Manager account is underfunded'),
      });

      expect(didServiceMock.deployStorage).toHaveBeenCalledWith('vault_token', { force: undefined });
      expect(oid4vcAgentProviderMock.resetCachedIssuerDid).not.toHaveBeenCalled();
      expect(oid4vcAgentProviderMock.ensureIssuerDid).not.toHaveBeenCalled();
    });

    it('rethrows non-overspend errors unchanged', async () => {
      const other = new Error('something else exploded');
      didServiceMock.deployStorage.mockRejectedValueOnce(other);

      await expect(walletService.deployManagerIdentity('vault_token')).rejects.toBe(other);
    });
  });
});

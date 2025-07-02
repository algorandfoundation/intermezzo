import createMockInstance from 'jest-create-mock-instance';
import { VaultService } from '../vault/vault.service';
import { WalletService } from './wallet.service';
import { ChainService } from '../chain/chain.service';
import { CreateAssetDto } from './create-asset.dto';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { ManagerDetailDto } from './manager-detail.dto';
import { plainToClass } from 'class-transformer';
import { randomBytes } from 'crypto';
import { AlgorandEncoder } from '@algorandfoundation/algo-models';

describe('WalletService', () => {
  let walletService: WalletService;
  let vaultServiceMock: jest.Mocked<VaultService>;
  let chainServiceMock: jest.Mocked<ChainService>;
  let configServiceMock: jest.Mocked<ConfigService>;

  let chainService: ChainService;
  let httpService: HttpService;

  beforeEach(async () => {
    vaultServiceMock = createMockInstance(VaultService);
    chainServiceMock = createMockInstance(ChainService);
    configServiceMock = createMockInstance(ConfigService);
    walletService = new WalletService(vaultServiceMock, chainServiceMock, configServiceMock);

    httpService = createMockInstance(HttpService);
    chainService = new ChainService(configServiceMock, httpService);

    configServiceMock.get.mockImplementation((key: string) => {
      const config = {
        GENESIS_ID: 'test-genesis-id',
        GENESIS_HASH: 'test-genesis-hash',
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

    // expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledWith(userId, 'vault_token');
    // expect(chainServiceMock.getAccountBalance).toHaveBeenCalledWith(new AlgorandEncoder().encodeAddress(pubKey));
    expect(result).toStrictEqual({
      public_address: new AlgorandEncoder().encodeAddress(pubKey),
      user_id: userId,
      algoBalance: '0',
    });
  })

  it('\(OK) getKeys()', async () => {
    const pubKey = randomBytes(32);
    const userId = '123581253191824129481240513501928401928';

    vaultServiceMock.getUserPublicKey.mockResolvedValueOnce(pubKey);
    vaultServiceMock.getKeys.mockResolvedValueOnce([{
      user_id: userId,
      public_address: Buffer.from(pubKey).toString('base64'), // public_address here is actually publicKey from the vault
    }]);

    chainServiceMock.getAccountBalance.mockResolvedValueOnce(0n);

    const result = await walletService.getKeys('vault_token');
    expect(result).toStrictEqual([{
      public_address: new AlgorandEncoder().encodeAddress(pubKey),
      user_id: userId
    }]);
  })

  it('getUserInfo() test', async () => {
    const pubKey = randomBytes(32)
    const algoBalanceMock = 10n

    chainServiceMock.getAccountBalance.mockResolvedValueOnce(algoBalanceMock);
    vaultServiceMock.getUserPublicKey.mockResolvedValueOnce(pubKey);

    const result = await walletService.getUserInfo('123581253191824129481240513501928401928', 'vault_token');

    expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledWith(
      '123581253191824129481240513501928401928',
      'vault_token',
    );
    expect(result).toStrictEqual({
      public_address: new AlgorandEncoder().encodeAddress(pubKey),
      user_id: '123581253191824129481240513501928401928',
      algoBalance: algoBalanceMock.toString(),
    });
  });

  it('getManagerInfo() test', async () => {
    const pubKey = randomBytes(32)
    const algoBalanceMock = 10n

    chainServiceMock.getAccountBalance.mockResolvedValueOnce(algoBalanceMock);
    chainServiceMock.getAccountAssetHoldings.mockResolvedValueOnce([]);

    vaultServiceMock.getManagerPublicKey.mockResolvedValueOnce(pubKey);

    const result = await walletService.getManagerInfo('vault_token');

    expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith('vault_token');

    expect(result).toStrictEqual(plainToClass(ManagerDetailDto, {
      public_address: new AlgorandEncoder().encodeAddress(pubKey),
      algoBalance: algoBalanceMock.toString(),
      assets: [],
    }))
  });


  it('\(OK) createAsset()', async () => {
    const pubKey = randomBytes(32)

    const address = new AlgorandEncoder().encodeAddress(pubKey);

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
    const userPubKey = randomBytes(32)
    const managerPubKey = randomBytes(32)

    const assetId = 1n;
    const userId = 'user123';
    const amount = 10;
    const lease = randomBytes(32).toString('base64');
    const note = "Note to self: notes are recorded for all";
    const vaultToken = 'vault_token';
    const userPublicAddress = new AlgorandEncoder().encodeAddress(userPubKey);
    const managerPublicAddress = new AlgorandEncoder().encodeAddress(managerPubKey);
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
      const algoBalance = 2200000n

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
      
      const algoBalance = 2200000n

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

      const algoBalance = 2200000n

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
    const vaultToken = 'vault_token';
    const userPublicAddress = new AlgorandEncoder().encodeAddress(userPubKey);
    const managerPublicAddress = new AlgorandEncoder().encodeAddress(
      managerPubKey,
    );
    const suggestedParams = {
      minFee: 1000,
      lastRound: 1n,
    } as TruncatedSuggestedParamsResponse;
    const dummySignedManagerTx1 = new Uint8Array([4]);
    const dummySignedUserTx = new Uint8Array([5]);
    const dummySignedManagerTx2 = new Uint8Array([6]);

    beforeEach(async () => {
      chainServiceMock.getSuggestedParams.mockResolvedValueOnce(
        suggestedParams,
      );
      chainServiceMock.submitTransaction.mockResolvedValueOnce({
        txid: 'final_tx_id',
      } as any);
      vaultServiceMock.getUserPublicKey.mockResolvedValueOnce(userPubKey);
      vaultServiceMock.getManagerPublicKey.mockResolvedValueOnce(managerPubKey);

      // not mock tx creation, and set group id functions
      chainServiceMock.craftAssetTransferTx.mockImplementation((...args) =>
        chainService.craftAssetTransferTx(...args),
      );
      chainServiceMock.craftPaymentTx.mockImplementation((...args) =>
        chainService.craftPaymentTx(...args),
      );
      chainServiceMock.setGroupID.mockImplementation((...args) =>
        chainService.setGroupID(...args),
      );

      chainServiceMock.getAccountBalance.mockResolvedValueOnce(1000000n); // Mock default balance

      // signed tx mocks
      walletService.signTxAsManager = jest
        .fn()
        .mockResolvedValueOnce(dummySignedManagerTx1)
        .mockResolvedValueOnce(dummySignedManagerTx2);
      walletService.signTxAsUser = jest
        .fn()
        .mockResolvedValueOnce(dummySignedUserTx);
    });
    afterEach(() => {
      jest.clearAllMocks();
    });
    it('clawbackAsset() -- test clawback', async () => {
      // Call
      const result = await walletService.clawbackAsset(
        vaultToken,
        assetId,
        userId,
        amount,
      );

      // Verify the flow.
      expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledWith(
        userId,
        vaultToken,
      );
      expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith(
        vaultToken,
      );
      expect(chainServiceMock.getSuggestedParams).toHaveBeenCalled();

      expect(chainServiceMock.craftAssetClawbackTx).toHaveBeenNthCalledWith(
        1,
        managerPublicAddress,
        userPublicAddress,
        managerPublicAddress,
        assetId,
        amount,
        undefined,
        suggestedParams,
      );

      expect(walletService.signTxAsManager).toHaveBeenCalledTimes(1);

      expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith(
        dummySignedManagerTx1,
      );

      expect(result).toBe('final_tx_id');
    });
  });
});

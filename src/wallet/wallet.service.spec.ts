import createMockInstance from 'jest-create-mock-instance';
import { VaultService } from '../vault/vault.service';
import { WalletService } from './wallet.service';
import { ChainService } from '../chain/chain.service';
import { CreateAssetDto } from './create-asset.dto';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { ManagerDetailDto } from './manager-detail.dto';
import { plainToClass } from 'class-transformer';

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

  it('getUserInfo() test', async () => {
    vaultServiceMock.getUserPublicAddress.mockResolvedValueOnce(
      'FVP5QNTHFME5BFBAX3LCQZUTWNKY4HLCXY2HL5JNCMXYINQ3ILT7VUEF6A',
    );

    const result = await walletService.getUserInfo('123581253191824129481240513501928401928', 'vault_token');

    expect(vaultServiceMock.getUserPublicAddress).toHaveBeenCalledWith(
      '123581253191824129481240513501928401928',
      'vault_token',
    );
    expect(result).toStrictEqual({
      public_address: 'FVP5QNTHFME5BFBAX3LCQZUTWNKY4HLCXY2HL5JNCMXYINQ3ILT7VUEF6A',
      user_id: '123581253191824129481240513501928401928',
    });
  });

  it('getManagerInfo() test', async () => {
    vaultServiceMock.getManagerPublicAddress.mockResolvedValueOnce(
      'FVP5QNTHFME5BFBAX3LCQZUTWNKY4HLCXY2HL5JNCMXYINQ3ILT7VUEF6A',
    );

    const result = await walletService.getMangerInfo('vault_token');

    expect(vaultServiceMock.getManagerPublicAddress).toHaveBeenCalledWith('vault_token');

    expect(result).toStrictEqual(plainToClass(ManagerDetailDto, {
      public_address: 'FVP5QNTHFME5BFBAX3LCQZUTWNKY4HLCXY2HL5JNCMXYINQ3ILT7VUEF6A',
    }))
  });


  it('createAsset() test', async () => {
    const createAssetDto: CreateAssetDto = {
      total: 5,
      decimals: BigInt(2),
      defaultFrozen: false,
      unitName: 'Tasst',
      assetName: 'Test Asset',
      url: 'https://example.com',
      managerAddress: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
      reserveAddress: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
      freezeAddress: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
      clawbackAddress: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
    };

    const vaultToken = 'vault_token';
    const publicAddress = 'FVP5QNTHFME5BFBAX3LCQZUTWNKY4HLCXY2HL5JNCMXYINQ3ILT7VUEF6A';
    const tx = new Uint8Array(5); // Initialize with an empty Uint8Array
    const signature = new Uint8Array(10); // Initialize with an empty Uint8Array
    const signedTx = new Uint8Array(15); // Initialize with an empty Uint8Array
    const transactionId = 'transactionId';

    vaultServiceMock.getManagerPublicAddress.mockResolvedValueOnce(publicAddress);
    chainServiceMock.craftAssetCreateTx.mockResolvedValueOnce(tx);
    vaultServiceMock.signAsManager.mockResolvedValueOnce(signature);
    chainServiceMock.addSignatureToTxn.mockReturnValueOnce(signedTx);
    chainServiceMock.submitTransaction.mockResolvedValueOnce({ txid: transactionId } as any);

    const result = await walletService.createAsset(createAssetDto, vaultToken);

    expect(vaultServiceMock.getManagerPublicAddress).toHaveBeenCalledWith(vaultToken);
    expect(chainServiceMock.craftAssetCreateTx).toHaveBeenCalledWith(publicAddress, createAssetDto);
    expect(vaultServiceMock.signAsManager).toHaveBeenCalledWith(tx, vaultToken);
    expect(chainServiceMock.addSignatureToTxn).toHaveBeenCalledWith(tx, signature);
    expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith(signedTx);
    expect(result).toBe(transactionId);
  });

  describe('transferAsset()', () => {
    const assetId = 1n;
    const userId = 'user123';
    const amount = 10;
    const vaultToken = 'vault_token';
    const userPublicAddress = 'KADIR2X4ALLOHNOCXEP6NPG5QI6ACLDJM4NFKB3GCJ23WR5ATTQJXKG4ZY';
    const managerPublicAddress = 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU';
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
      vaultServiceMock.getUserPublicAddress.mockResolvedValueOnce(userPublicAddress);
      vaultServiceMock.getManagerPublicAddress.mockResolvedValueOnce(managerPublicAddress);

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

      // Call
      const result = await walletService.transferAsset(assetId, userId, amount, vaultToken);

      // Verify the flow.
      expect(vaultServiceMock.getUserPublicAddress).toHaveBeenCalledWith(userId, vaultToken);
      expect(vaultServiceMock.getManagerPublicAddress).toHaveBeenCalledWith(vaultToken);
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
        suggestedParams,
      );
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenNthCalledWith(
        2,
        managerPublicAddress,
        userPublicAddress,
        assetId,
        amount,
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

      // Call
      const result = await walletService.transferAsset(assetId, userId, amount, vaultToken);

      // Verify the flow.
      expect(vaultServiceMock.getUserPublicAddress).toHaveBeenCalledWith(userId, vaultToken);
      expect(vaultServiceMock.getManagerPublicAddress).toHaveBeenCalledWith(vaultToken);
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
        suggestedParams,
      );
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenNthCalledWith(
        2,
        managerPublicAddress,
        userPublicAddress,
        assetId,
        amount,
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

      // Call
      const result = await walletService.transferAsset(assetId, userId, amount, vaultToken);

      // Verify the flow.
      expect(vaultServiceMock.getUserPublicAddress).toHaveBeenCalledWith(userId, vaultToken);
      expect(vaultServiceMock.getManagerPublicAddress).toHaveBeenCalledWith(vaultToken);
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

      // Call
      const result = await walletService.transferAsset(assetId, userId, amount, vaultToken);

      // Verify the flow.
      expect(vaultServiceMock.getUserPublicAddress).toHaveBeenCalledWith(userId, vaultToken);
      expect(vaultServiceMock.getManagerPublicAddress).toHaveBeenCalledWith(vaultToken);
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
        suggestedParams,
      );
      expect(chainServiceMock.craftAssetTransferTx).toHaveBeenNthCalledWith(
        2,
        managerPublicAddress,
        userPublicAddress,
        assetId,
        amount,
        suggestedParams,
      );

      expect(walletService.signTxAsManager).toHaveBeenCalledTimes(1);
      expect(walletService.signTxAsUser).toHaveBeenCalledTimes(1);

      expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith([dummySignedUserTx, dummySignedManagerTx1]);

      expect(result).toBe('final_tx_id');
    });
  });
});

import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import createMockInstance from 'jest-create-mock-instance';
import { VaultService } from '../vault/vault.service';
import { UserAccount, WalletService } from './wallet.service';
import { ChainService } from '../chain/chain.service';
import { DidService } from '../did/did.service';
import { Oid4vcAgentProvider } from '../oid4vc/agent/oid4vc-agent.provider';
import { CreateAssetDto } from './create-asset.dto';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { ManagerDetailDto } from './manager-detail.dto';
import { plainToClass } from 'class-transformer';
import { randomBytes } from 'crypto';
import { Address } from '@algorandfoundation/algokit-utils';
import { decodeTransaction, encodeSignedTransaction } from '@algorandfoundation/algokit-utils/transact';
import * as algosdk from 'algosdk';
import { ManagerVaultTokenProvider } from '../auth/manager-vault-token.provider';
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
  let managerTokenProviderMock: jest.Mocked<ManagerVaultTokenProvider>;

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
    managerTokenProviderMock = createMockInstance(ManagerVaultTokenProvider);
    managerTokenProviderMock.getToken.mockResolvedValue('service_vault_token');
    walletService = new WalletService(
      vaultServiceMock,
      chainServiceMock,
      configServiceMock,
      didServiceMock,
      oid4vcAgentProviderMock,
      managerTokenProviderMock,
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

    expect(vaultServiceMock.pqGetKey).toHaveBeenCalledWith(userId, 'service_vault_token');
    expect(vaultServiceMock.transitCreateKey).toHaveBeenCalledWith(userId, undefined, 'vault_token');
    expect(result).toStrictEqual({
      public_address: new Address(pubKey).toString(),
      user_id: userId,
      algoBalance: '0',
      account_type: 'ed25519',
    });
  });

  it('\(OK) getKeys()', async () => {
    const pubKey = randomBytes(32);
    const userId = '123581253191824129481240513501928401928';

    vaultServiceMock.getKeys.mockResolvedValueOnce([
      {
        user_id: userId,
        public_address: pubKey.toString('base64'),
      },
    ]);
    vaultServiceMock.getPqUsers.mockResolvedValueOnce([]);

    const result = await walletService.getKeys('vault_token');
    expect(result).toStrictEqual([
      {
        public_address: new Address(pubKey).toString(),
        user_id: userId,
        account_type: 'ed25519',
      },
    ]);
    expect(vaultServiceMock.getKeys).toHaveBeenCalledWith('vault_token');
    expect(vaultServiceMock.getPqUsers).toHaveBeenCalledWith('service_vault_token');
  });

  it('keeps the original transit LIST as the authorization gate', async () => {
    vaultServiceMock.getKeys.mockRejectedValueOnce(new ForbiddenException());

    await expect(walletService.getKeys('transit_only_token')).rejects.toThrow(ForbiddenException);

    expect(managerTokenProviderMock.getToken).not.toHaveBeenCalled();
    expect(vaultServiceMock.getPqUsers).not.toHaveBeenCalled();
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
      account_type: 'ed25519',
    });
  });

  describe('PQ accounts', () => {
    const userId = 'pq-user';
    const pqAddress = 'ZEJ4BLG3XWAUUZQGCEDJLYIC6D2NCWHRSX5DJMDPE54PXXR7G3PCQTARXU';
    const pqKey = {
      scheme: 'f1',
      salt: 3,
      publicKey: Buffer.from('falcon-public-key'),
      address: pqAddress,
    };

    /** How `VaultService.getUserPublicKey` reports a missing transit key. */
    const transitMiss = () => vaultServiceMock.getUserPublicKey.mockRejectedValueOnce(new NotFoundException());

    describe('userCreate', () => {
      it('(OK) should create a PQ key and return the address the plugin derived', async () => {
        vaultServiceMock.pqGetKey.mockResolvedValueOnce(undefined); // no conflict check needed...
        transitMiss(); // ...for falcon1024 the guard probes transit
        vaultServiceMock.pqCreateKey.mockResolvedValueOnce(pqKey);

        const result = await walletService.userCreate(userId, 'vault_token', 'falcon1024');

        expect(vaultServiceMock.pqCreateKey).toHaveBeenCalledWith(userId, 'vault_token');
        expect(vaultServiceMock.transitCreateKey).not.toHaveBeenCalled();
        expect(result).toStrictEqual({
          user_id: userId,
          public_address: pqAddress,
          algoBalance: '0',
          account_type: 'falcon1024',
        });
      });

      it('(OK) should default to ed25519 when no account_type is given', async () => {
        const pubKey = randomBytes(32);
        vaultServiceMock.pqGetKey.mockResolvedValueOnce(undefined);
        vaultServiceMock.transitCreateKey.mockResolvedValueOnce(pubKey);

        const result = await walletService.userCreate(userId, 'vault_token');

        expect(vaultServiceMock.pqGetKey).toHaveBeenCalledWith(userId, 'service_vault_token');
        expect(vaultServiceMock.pqCreateKey).not.toHaveBeenCalled();
        expect(result.account_type).toEqual('ed25519');
        expect(result.public_address).toEqual(new Address(pubKey).toString());
      });

      it('(FAIL) should 409 when the user_id already exists as ed25519', async () => {
        // The guard is the difference between a clear error and a
        // user_id that resolves to two addresses depending on probe order.
        vaultServiceMock.getUserPublicKey.mockResolvedValueOnce(randomBytes(32));

        await expect(walletService.userCreate(userId, 'vault_token', 'falcon1024')).rejects.toThrow(ConflictException);
        expect(vaultServiceMock.pqCreateKey).not.toHaveBeenCalled();
      });

      it('(FAIL) should 409 when the user_id already exists as falcon1024', async () => {
        vaultServiceMock.pqGetKey.mockResolvedValueOnce(pqKey);

        await expect(walletService.userCreate(userId, 'vault_token', 'ed25519')).rejects.toThrow(ConflictException);
        expect(vaultServiceMock.transitCreateKey).not.toHaveBeenCalled();
      });
    });

    describe('resolveUserAccount', () => {
      it('(OK) should resolve an ed25519 account without touching the PQ mount', async () => {
        const pubKey = randomBytes(32);
        vaultServiceMock.getUserPublicKey.mockResolvedValueOnce(pubKey);

        const account = await walletService.resolveUserAccount('ed-user', 'vault_token');

        expect(account).toStrictEqual({
          type: 'ed25519',
          userId: 'ed-user',
          address: new Address(pubKey).toString(),
          publicKey: pubKey,
        });
        // Existing accounts must not pay for the new code path.
        expect(vaultServiceMock.pqGetKey).not.toHaveBeenCalled();
      });

      it('(OK) should fall through to the PQ mount on a transit miss', async () => {
        transitMiss();
        vaultServiceMock.pqGetKey.mockResolvedValueOnce(pqKey);

        const account = await walletService.resolveUserAccount(userId, 'vault_token');

        expect(vaultServiceMock.pqGetKey).toHaveBeenCalledWith(userId, 'service_vault_token');
        expect(account).toStrictEqual({
          type: 'falcon1024',
          userId,
          address: pqAddress,
          publicKey: pqKey.publicKey,
          salt: 3,
          scheme: 'f1',
        });
      });

      it('(FAIL) should 404 when neither mount holds the user', async () => {
        transitMiss();
        vaultServiceMock.pqGetKey.mockResolvedValueOnce(undefined);

        await expect(walletService.resolveUserAccount('ghost', 'vault_token')).rejects.toThrow(NotFoundException);
        expect(vaultServiceMock.pqGetKey).toHaveBeenCalledWith('ghost', 'service_vault_token');
      });

      it('(FAIL) should propagate a non-404 transit error rather than probing PQ', async () => {
        // A 403 means "cannot tell", not "not an ed25519 account" —
        // falling through would silently create the wrong answer.
        vaultServiceMock.getUserPublicKey.mockRejectedValueOnce(new ForbiddenException());

        await expect(walletService.resolveUserAccount(userId, 'vault_token')).rejects.toThrow(ForbiddenException);
        expect(vaultServiceMock.pqGetKey).not.toHaveBeenCalled();
        expect(managerTokenProviderMock.getToken).not.toHaveBeenCalled();
      });
    });

    describe('signTxAsUser compatibility', () => {
      it('accepts the legacy user-id signature and resolves before signing', async () => {
        const publicKey = randomBytes(32);
        const unsigned = new Uint8Array([1, 2, 3]);
        const signed = new Uint8Array([4, 5, 6]);
        const rawSignature = Buffer.alloc(64, 9);
        vaultServiceMock.getUserPublicKey.mockResolvedValueOnce(publicKey);
        vaultServiceMock.signAsUser.mockResolvedValueOnce(Buffer.from(`vault:v1:${rawSignature.toString('base64')}`));
        chainServiceMock.addSignatureToTxn.mockReturnValueOnce(signed);

        await expect(walletService.signTxAsUser(userId, unsigned, 'transit_only_token')).resolves.toBe(signed);

        expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledWith(userId, 'transit_only_token');
        expect(vaultServiceMock.signAsUser).toHaveBeenCalledWith(userId, unsigned, 'transit_only_token');
        expect(vaultServiceMock.pqGetKey).not.toHaveBeenCalled();
        expect(managerTokenProviderMock.getToken).not.toHaveBeenCalled();
      });
    });

    describe('getUserInfo', () => {
      it('(OK) should report a PQ account with its plugin-derived address', async () => {
        transitMiss();
        vaultServiceMock.pqGetKey.mockResolvedValueOnce(pqKey);
        chainServiceMock.getAccountBalance.mockResolvedValueOnce(42n);

        const result = await walletService.getUserInfo(userId, 'vault_token');

        expect(chainServiceMock.getAccountBalance).toHaveBeenCalledWith(pqAddress);
        expect(result).toStrictEqual({
          user_id: userId,
          public_address: pqAddress,
          algoBalance: '42',
          account_type: 'falcon1024',
        });
      });
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
      chainServiceMock.craftAssetClawbackTx.mockImplementation((...args) => chainService.craftAssetClawbackTx(...args));
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
    let dummyAppTx: Uint8Array;
    const dummySignedTx = new Uint8Array([20, 21, 22]);

    beforeEach(() => {
      chainServiceMock.getSuggestedParams.mockResolvedValueOnce(suggestedParams);
      chainServiceMock.craftAppCallTx.mockImplementation(async (...args) => {
        dummyAppTx = await chainService.craftAppCallTx(...args);
        return dummyAppTx;
      });
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
      expect(walletService.signTxAsUser).toHaveBeenCalledWith(
        { type: 'ed25519', userId, address: userPublicAddress, publicKey: userPubKey },
        dummyAppTx,
        vaultToken,
      );
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

  describe('PQ signing and submission', () => {
    const token = 'vault_token';
    const managerKey = Buffer.alloc(32, 1);
    const managerAddress = new Address(managerKey).toString();
    const edKey = Buffer.alloc(32, 2);
    const edAccount: UserAccount = {
      type: 'ed25519',
      userId: 'ed-user',
      address: new Address(edKey).toString(),
      publicKey: edKey,
    };
    const pqPublicKey = Buffer.alloc(1793, 7);
    const pqAddress = algosdk.addressFromPQKey(Buffer.from('f1'), pqPublicKey);
    const pqAccount: UserAccount = {
      type: 'falcon1024',
      userId: 'pq-user',
      address: pqAddress.address.toString(),
      publicKey: pqPublicKey,
      scheme: 'f1',
      salt: pqAddress.salt,
    };
    const edSignature = Buffer.alloc(64, 8);
    const pqSignature = Buffer.alloc(1226, 9);
    const params = { minFee: 1000, lastRound: 1n };

    beforeEach(() => {
      vaultServiceMock.getManagerPublicKey.mockResolvedValue(managerKey);
      vaultServiceMock.getUserPublicKey.mockImplementation(async (userId) => {
        if (userId === edAccount.userId) return edKey;
        throw new NotFoundException();
      });
      vaultServiceMock.pqGetKey.mockResolvedValue(pqAccount);
      vaultServiceMock.signAsUser.mockResolvedValue(Buffer.from(`vault:v1:${edSignature.toString('base64')}`));
      vaultServiceMock.signAsManager.mockResolvedValue(Buffer.from(`vault:v1:${edSignature.toString('base64')}`));
      vaultServiceMock.pqSign.mockResolvedValue(pqSignature);
      chainServiceMock.getSuggestedParams.mockResolvedValue(params);
      chainServiceMock.craftPaymentTx.mockImplementation((...args) => chainService.craftPaymentTx(...args));
      chainServiceMock.craftAppCallTx.mockImplementation((...args) => chainService.craftAppCallTx(...args));
      chainServiceMock.craftAssetTransferTx.mockImplementation((...args) => chainService.craftAssetTransferTx(...args));
      chainServiceMock.addSignatureToTxn.mockImplementation((...args) => chainService.addSignatureToTxn(...args));
      chainServiceMock.addPqSignatureToTxn.mockImplementation((...args) => chainService.addPqSignatureToTxn(...args));
      chainServiceMock.addPqFeeSurcharge.mockImplementation((...args) => chainService.addPqFeeSurcharge(...args));
      chainServiceMock.setGroupID.mockImplementation((...args) => chainService.setGroupID(...args));
      chainServiceMock.submitTransaction.mockResolvedValue({ txid: 'tx-id' });
    });

    const submitted = () => chainServiceMock.submitTransaction.mock.calls[0][0];

    it('signs a PQ payment once, with the surcharge already included', async () => {
      expect(await walletService.transferAlgoToAddress(token, pqAccount.userId, managerAddress, 5)).toBe('tx-id');
      const signed = algosdk.decodeSignedTransaction(submitted() as Uint8Array);
      expect(signed.txn.fee).toBe(3000n);
      expect(signed.txn.group).toBeUndefined();
      expect(algosdk.addressFromPQSig(signed.pqsig!).toString()).toBe(pqAccount.address);
      expect(vaultServiceMock.pqSign).toHaveBeenCalledWith(pqAccount.userId, signed.txn.bytesToSign(), token);
      expect(vaultServiceMock.pqSign).toHaveBeenCalledTimes(1);
      expect(vaultServiceMock.pqGetKey).toHaveBeenCalledTimes(1);
      expect(vaultServiceMock.signAsUser).not.toHaveBeenCalled();
      expect(chainServiceMock.setGroupID).not.toHaveBeenCalled();
    });

    it.each(['ed-user', 'manager'])('preserves legacy single-payment bytes for %s', async (userId) => {
      const address = userId === 'manager' ? managerAddress : edAccount.address;
      const original = await chainService.craftPaymentTx(address, managerAddress, 5, params);
      const expected = encodeSignedTransaction({ txn: decodeTransaction(original), sig: edSignature });
      await walletService.transferAlgoToAddress(token, userId, managerAddress, 5);
      expect(submitted()).toEqual(expected);
      expect(chainServiceMock.addPqFeeSurcharge).not.toHaveBeenCalled();
      expect(vaultServiceMock.pqSign).not.toHaveBeenCalled();
    });

    it('preserves legacy ed25519 group bytes', async () => {
      const original = await Promise.all(
        [5, 6].map((amount) => chainService.craftPaymentTx(edAccount.address, managerAddress, amount, params)),
      );
      const expected = chainService
        .setGroupID(original)
        .map((tx) => encodeSignedTransaction({ txn: decodeTransaction(tx), sig: edSignature }));
      await walletService.groupTransaction(token, {
        transactions: [5, 6].map((amount) => ({
          type: 'payment',
          payload: { fromUserId: edAccount.userId, toAddress: managerAddress, amount },
        })),
      });
      expect(submitted()).toEqual(expected);
      expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledTimes(1);
    });

    it('surcharges only PQ senders before grouping and reuses account resolution', async () => {
      await walletService.groupTransaction(token, {
        transactions: [pqAccount, edAccount, pqAccount].map((account, index) => ({
          type: 'payment',
          payload: { fromUserId: account.userId, toAddress: managerAddress, amount: index + 1 },
        })),
      });
      const signed = (submitted() as Uint8Array[]).map(algosdk.decodeSignedTransaction);
      expect(signed.map((entry) => entry.txn.fee)).toEqual([3000n, 1000n, 3000n]);
      expect(signed[0].pqsig).toBeDefined();
      expect(signed[1].pqsig).toBeUndefined();
      expect(Buffer.from(signed[1].sig!)).toEqual(edSignature);
      const adjusted = chainServiceMock.setGroupID.mock.calls[0][0];
      expect(adjusted.map((tx) => decodeTransaction(tx).fee)).toEqual([3000n, 1000n, 3000n]);
      const expectedGroup = decodeTransaction(chainService.setGroupID(adjusted)[0]).group;
      for (const entry of signed) expect(entry.txn.group).toEqual(expectedGroup);
      expect(vaultServiceMock.pqGetKey).toHaveBeenCalledTimes(1);
      expect(vaultServiceMock.getUserPublicKey).toHaveBeenCalledTimes(2);
    });

    it('adds to an explicit pooled app-call fee', async () => {
      await walletService.appCall(token, { fromUserId: pqAccount.userId, appId: 123, fee: 5000 } as any);
      expect(algosdk.decodeSignedTransaction(submitted() as Uint8Array).txn.fee).toBe(7000n);
      expect(vaultServiceMock.pqSign).toHaveBeenCalledTimes(1);
    });

    it.each([edAccount, pqAccount])('prefunds an underfunded $type asset opt-in', async (account) => {
      chainServiceMock.getAccountAsset.mockResolvedValue(null);
      chainServiceMock.getAccountDetail.mockResolvedValue({ amount: 0n, minBalance: 100000n, assets: [] });
      await walletService.transferAsset(token, 1n, account.userId, 10);
      const fee = account.type === 'falcon1024' ? 3000 : 1000;
      expect(chainServiceMock.craftPaymentTx).toHaveBeenCalledWith(
        managerAddress,
        account.address,
        200000 + fee,
        params,
      );
      const signed = (submitted() as Uint8Array[]).map(algosdk.decodeSignedTransaction);
      expect(signed.map((entry) => entry.txn.fee)).toEqual([1000n, BigInt(fee), 1000n]);
      expect(signed[1].txn.sender.toString()).toBe(account.address);
    });

    it('does not submit when PQ signing fails', async () => {
      vaultServiceMock.pqSign.mockRejectedValue(new ForbiddenException());
      await expect(walletService.transferAlgoToAddress(token, pqAccount.userId, managerAddress, 5)).rejects.toThrow();
      expect(chainServiceMock.submitTransaction).not.toHaveBeenCalled();
      expect(vaultServiceMock.signAsUser).not.toHaveBeenCalled();
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

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
import { readFileSync } from 'fs';
import { join } from 'path';
import { Address } from '@algorandfoundation/algokit-utils';
import { decodeTransaction, encodeSignedTransaction } from '@algorandfoundation/algokit-utils/transact';
import * as algosdk from 'algosdk';
import { ManagerVaultTokenProvider } from '../auth/manager-vault-token.provider';
import { validate } from 'class-validator';
import { CreateUserDto } from './create-user.dto';
import {
  TruncatedAccountAssetResponse,
  TruncatedAccountResponse,
  TruncatedSuggestedParamsResponse,
} from 'src/chain/algo-node-responses';

describe('WalletService', () => {
  const pqVector = JSON.parse(readFileSync(join(__dirname, '../../vault/plugin/testdata/falcon1024.json'), 'utf8'));
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
    vaultServiceMock.canCreateUserKey.mockResolvedValue(true);
    vaultServiceMock.kvCreate.mockResolvedValue(true);
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

  it('rejects user IDs that can alias a Vault path', async () => {
    const dto = Object.assign(new CreateUserDto(), { user_id: 'x/../foo' });
    await expect(validate(dto)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'user_id' })]),
    );
  });

  it('\(OK) getKeys()', async () => {
    const pubKey = randomBytes(32);
    const pqPublicKey = Buffer.from(pqVector.publicKey, 'base64');
    const pqAddress = pqVector.address;
    const userId = '123581253191824129481240513501928401928';

    vaultServiceMock.getKeys.mockResolvedValueOnce([
      {
        user_id: userId,
        public_address: pubKey.toString('base64'),
      },
    ]);
    vaultServiceMock.pqListKeys.mockResolvedValueOnce(['pq-user']);
    vaultServiceMock.pqGetKey.mockResolvedValueOnce(pqPublicKey);

    const result = await walletService.getKeys('vault_token');
    expect(result).toStrictEqual([
      {
        public_address: new Address(pubKey).toString(),
        user_id: userId,
        account_type: 'ed25519',
      },
      {
        public_address: pqAddress,
        user_id: 'pq-user',
        account_type: 'falcon1024',
      },
    ]);
    expect(vaultServiceMock.getKeys).toHaveBeenCalledWith('vault_token');
    expect(vaultServiceMock.pqListKeys).toHaveBeenCalledWith('service_vault_token');
    expect(vaultServiceMock.pqGetKey).toHaveBeenCalledWith('pq-user', 'service_vault_token');
  });

  it('keeps the original transit LIST as the authorization gate', async () => {
    vaultServiceMock.getKeys.mockRejectedValueOnce(new ForbiddenException());

    await expect(walletService.getKeys('transit_only_token')).rejects.toThrow(ForbiddenException);

    expect(managerTokenProviderMock.getToken).not.toHaveBeenCalled();
    expect(vaultServiceMock.pqListKeys).not.toHaveBeenCalled();
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
    const pqKey = Buffer.from(pqVector.publicKey, 'base64');
    const pqAddress = { address: algosdk.Address.fromString(pqVector.address), salt: pqVector.salt };

    /** How `VaultService.getUserPublicKey` reports a missing transit key. */
    const transitMiss = () => vaultServiceMock.getUserPublicKey.mockRejectedValueOnce(new NotFoundException());

    describe('userCreate', () => {
      it('(OK) should create a PQ key and derive its address in Intermezzo', async () => {
        vaultServiceMock.pqGetKey.mockResolvedValueOnce(undefined); // no conflict check needed...
        transitMiss(); // ...for falcon1024 the guard probes transit
        vaultServiceMock.pqCreateKey.mockResolvedValueOnce(pqKey);

        const result = await walletService.userCreate(userId, 'vault_token', 'falcon1024');

        expect(vaultServiceMock.pqCreateKey).toHaveBeenCalledWith(userId, 'vault_token');
        expect(vaultServiceMock.transitCreateKey).not.toHaveBeenCalled();
        expect(result).toStrictEqual({
          user_id: userId,
          public_address: pqAddress.address.toString(),
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

      it('does not reserve an ID when the caller cannot create the target key', async () => {
        vaultServiceMock.canCreateUserKey.mockResolvedValueOnce(false);

        await expect(walletService.userCreate(userId, 'denied-token', 'falcon1024')).rejects.toThrow(
          ForbiddenException,
        );
        expect(managerTokenProviderMock.getToken).not.toHaveBeenCalled();
        expect(vaultServiceMock.kvCreate).not.toHaveBeenCalled();
        expect(vaultServiceMock.pqCreateKey).not.toHaveBeenCalled();
      });

      it('atomically admits one type across service instances', async () => {
        const other = new WalletService(
          vaultServiceMock,
          chainServiceMock,
          configServiceMock,
          didServiceMock,
          oid4vcAgentProviderMock,
          managerTokenProviderMock,
        );
        let claim: Record<string, unknown> | undefined;
        vaultServiceMock.getUserPublicKey.mockRejectedValue(new NotFoundException());
        vaultServiceMock.pqGetKey.mockResolvedValue(undefined);
        vaultServiceMock.kvCreate.mockImplementation(async (_path, data) => {
          if (claim) return false;
          claim = data;
          return true;
        });
        vaultServiceMock.kvRead.mockImplementation(async () => claim);
        vaultServiceMock.transitCreateKey.mockResolvedValue(randomBytes(32));
        vaultServiceMock.pqCreateKey.mockResolvedValue(pqKey);

        const results = await Promise.allSettled([
          walletService.userCreate(userId, 'vault_token', 'ed25519'),
          other.userCreate(userId, 'vault_token', 'falcon1024'),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toEqual([
          expect.objectContaining({ reason: expect.any(ConflictException) }),
        ]);
        expect(
          vaultServiceMock.transitCreateKey.mock.calls.length + vaultServiceMock.pqCreateKey.mock.calls.length,
        ).toBe(1);
      });

      it('retries the same type after key provisioning fails', async () => {
        const claim = { schemaVersion: 1, userId, accountType: 'ed25519' } as const;
        vaultServiceMock.pqGetKey.mockResolvedValue(undefined);
        vaultServiceMock.kvCreate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        vaultServiceMock.kvRead.mockResolvedValue(claim);
        vaultServiceMock.transitCreateKey.mockRejectedValueOnce(new Error('provisioning failed'));

        await expect(walletService.userCreate(userId, 'vault_token')).rejects.toThrow('provisioning failed');

        const publicKey = randomBytes(32);
        vaultServiceMock.transitCreateKey.mockResolvedValueOnce(publicKey);
        await expect(walletService.userCreate(userId, 'vault_token')).resolves.toMatchObject({
          user_id: userId,
          account_type: 'ed25519',
          public_address: new Address(publicKey).toString(),
        });
      });

      it('rejects case variants that share a normalized claim key', async () => {
        vaultServiceMock.pqGetKey.mockResolvedValue(undefined);
        vaultServiceMock.kvCreate.mockResolvedValueOnce(false);
        vaultServiceMock.kvRead.mockResolvedValueOnce({ schemaVersion: 1, userId: 'PQ-User', accountType: 'ed25519' });

        await expect(walletService.userCreate('pq-user', 'vault_token')).rejects.toThrow(ConflictException);
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
          address: pqAddress.address.toString(),
          publicKey: pqKey,
          salt: pqAddress.salt,
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
      it('preserves signing for tokens without key-read permission', async () => {
        const unsigned = new Uint8Array([1, 2, 3]);
        const signed = new Uint8Array([4, 5, 6]);
        const rawSignature = Buffer.alloc(64, 9);
        vaultServiceMock.getUserPublicKey.mockRejectedValueOnce(new ForbiddenException());
        vaultServiceMock.signAsUser.mockResolvedValueOnce(Buffer.from(`vault:v1:${rawSignature.toString('base64')}`));
        chainServiceMock.addSignatureToTxn.mockReturnValueOnce(signed);

        await expect(walletService.signTxAsUser(userId, unsigned, 'transit_only_token')).resolves.toBe(signed);

        expect(vaultServiceMock.getUserPublicKey).not.toHaveBeenCalled();
        expect(vaultServiceMock.signAsUser).toHaveBeenCalledWith(userId, unsigned, 'transit_only_token');
        expect(vaultServiceMock.pqGetKey).not.toHaveBeenCalled();
        expect(managerTokenProviderMock.getToken).not.toHaveBeenCalled();
      });
    });

    describe('getUserInfo', () => {
      it('(OK) should report a PQ account with its Intermezzo-derived address', async () => {
        transitMiss();
        vaultServiceMock.pqGetKey.mockResolvedValueOnce(pqKey);
        chainServiceMock.getAccountBalance.mockResolvedValueOnce(42n);

        const result = await walletService.getUserInfo(userId, 'vault_token');

        expect(chainServiceMock.getAccountBalance).toHaveBeenCalledWith(pqAddress.address.toString());
        expect(result).toStrictEqual({
          user_id: userId,
          public_address: pqAddress.address.toString(),
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
    const suggestedParams = { minFee: 1000, lastRound: 1n } as TruncatedSuggestedParamsResponse;
    const signedTx = new Uint8Array(64); // Initialize with an empty Uint8Array
    const signature = Buffer.from(`vault:1:${Buffer.from(signedTx).toString('base64')}`, 'utf-8');
    const transactionId = 'transactionId';

    vaultServiceMock.getManagerPublicKey.mockResolvedValueOnce(pubKey);
    chainServiceMock.getSuggestedParams.mockResolvedValue(suggestedParams);
    // Real builder: standalone creation now goes through `signAndSubmit`,
    // which decodes the transaction to find its sender.
    chainServiceMock.craftAssetCreateTx.mockImplementation((...args) => chainService.craftAssetCreateTx(...args));
    vaultServiceMock.signAsManager.mockResolvedValueOnce(signature);
    chainServiceMock.addSignatureToTxn.mockReturnValueOnce(signedTx);
    chainServiceMock.submitTransaction.mockResolvedValueOnce({ txid: transactionId } as any);

    const result = await walletService.createAsset(createAssetDto, vaultToken);

    const tx = await chainServiceMock.craftAssetCreateTx.mock.results[0].value;
    expect(vaultServiceMock.getManagerPublicKey).toHaveBeenCalledWith(vaultToken);
    // Params are fetched once and handed to the builder, so the base fee a
    // PQ surcharge would be added to comes from that same snapshot.
    expect(chainServiceMock.craftAssetCreateTx).toHaveBeenCalledWith(address, createAssetDto, suggestedParams);
    expect(chainServiceMock.getSuggestedParams).toHaveBeenCalledTimes(1);
    expect(vaultServiceMock.signAsManager).toHaveBeenCalledWith(tx, vaultToken);
    expect(chainServiceMock.addSignatureToTxn).toHaveBeenCalledWith(tx, signedTx);
    expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith(signedTx);
    expect(chainServiceMock.addPqFeeSurcharge).not.toHaveBeenCalled();
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
      expect(walletService.signTxAsManager).toHaveBeenCalledWith(dummyAppTx, vaultToken, {
        type: 'ed25519',
        userId: 'manager',
        address: managerPublicAddress,
        publicKey: managerPubKey,
      });
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
    const pqPublicKey = Buffer.from(pqVector.publicKey, 'base64');
    const pqAddress = { address: algosdk.Address.fromString(pqVector.address), salt: pqVector.salt };
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
      vaultServiceMock.pqGetKey.mockResolvedValue(pqPublicKey);
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
      expect(signed.pqsig!.slt).toBe(pqVector.salt);
      expect(Buffer.from(signed.pqsig!.pk)).toEqual(pqPublicKey);
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

  describe('Falcon manager account', () => {
    const token = 'caller_vault_token';
    const managersMount = 'pawn/pq-managers';
    const usersMount = 'pawn/pq-users';
    // A distinct 1793-byte key: the manager and the PQ user must derive
    // different addresses, or a wrong-mount read would pass unnoticed.
    const managerPqKey = Buffer.alloc(1793, 7);
    const managerPqAddress = algosdk.addressFromPQKey(Buffer.from('f1'), managerPqKey);
    const userPqKey = Buffer.from(pqVector.publicKey, 'base64');
    const userPqAddress = algosdk.Address.fromString(pqVector.address);
    const edKey = Buffer.alloc(32, 2);
    const edAddress = new Address(edKey).toString();
    const transitManagerKey = Buffer.alloc(32, 1);
    const params = { minFee: 1000, lastRound: 1n } as TruncatedSuggestedParamsResponse;
    const pqSignature = Buffer.alloc(1226, 9);
    const edSignature = Buffer.alloc(64, 8);

    const configure = (overrides: Record<string, string | undefined> = {}) => {
      const config: Record<string, string | undefined> = {
        GENESIS_ID: 'test-genesis-id',
        GENESIS_HASH: 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
        NODE_HTTP_SCHEME: 'http',
        NODE_HOST: 'localhost',
        NODE_PORT: '4001',
        NODE_TOKEN: 'test-token',
        VAULT_MANAGER_KEY: 'manager',
        VAULT_PQ_USERS_PATH: usersMount,
        VAULT_PQ_MANAGERS_PATH: managersMount,
        VAULT_MANAGER_ACCOUNT_TYPE: 'falcon1024',
        ...overrides,
      };
      configServiceMock.get.mockImplementation((key: string) => config[key]);
    };

    beforeEach(() => {
      configure();
      vaultServiceMock.getManagerPublicKey.mockResolvedValue(transitManagerKey);
      vaultServiceMock.getUserPublicKey.mockImplementation(async (userId) => {
        if (userId === 'ed-user') return edKey;
        throw new NotFoundException();
      });
      // Mount decides which key comes back; a read from the wrong mount
      // would surface as the wrong address rather than as a failure.
      vaultServiceMock.pqGetKey.mockImplementation(async (keyName, _token, mount) =>
        mount === managersMount ? managerPqKey : keyName === 'pq-user' ? userPqKey : undefined,
      );
      vaultServiceMock.pqSign.mockResolvedValue(pqSignature);
      vaultServiceMock.signAsManager.mockResolvedValue(Buffer.from(`vault:v1:${edSignature.toString('base64')}`));
      vaultServiceMock.signAsUser.mockResolvedValue(Buffer.from(`vault:v1:${edSignature.toString('base64')}`));
      chainServiceMock.getSuggestedParams.mockResolvedValue(params);
      chainServiceMock.craftPaymentTx.mockImplementation((...args) => chainService.craftPaymentTx(...args));
      chainServiceMock.craftAppCallTx.mockImplementation((...args) => chainService.craftAppCallTx(...args));
      chainServiceMock.craftAssetCreateTx.mockImplementation((...args) => chainService.craftAssetCreateTx(...args));
      chainServiceMock.craftAssetTransferTx.mockImplementation((...args) => chainService.craftAssetTransferTx(...args));
      chainServiceMock.craftAssetClawbackTx.mockImplementation((...args) => chainService.craftAssetClawbackTx(...args));
      chainServiceMock.addSignatureToTxn.mockImplementation((...args) => chainService.addSignatureToTxn(...args));
      chainServiceMock.addPqSignatureToTxn.mockImplementation((...args) => chainService.addPqSignatureToTxn(...args));
      chainServiceMock.addPqFeeSurcharge.mockImplementation((...args) => chainService.addPqFeeSurcharge(...args));
      chainServiceMock.setGroupID.mockImplementation((...args) => chainService.setGroupID(...args));
      chainServiceMock.submitTransaction.mockResolvedValue({ txid: 'tx-id' });
    });

    const submitted = () => chainServiceMock.submitTransaction.mock.calls[0][0];

    describe('resolution and configuration', () => {
      it('reads the manager key from the manager mount, never the user mount', async () => {
        const account = await walletService.resolveManagerAccount(token);

        expect(account).toEqual({
          type: 'falcon1024',
          userId: 'manager',
          address: managerPqAddress.address.toString(),
          publicKey: managerPqKey,
          salt: managerPqAddress.salt,
          scheme: 'f1',
        });
        // Independently derived, and distinct from both the PQ user and
        // the transit identity.
        expect(account.address).not.toBe(userPqAddress.toString());
        expect(account.address).not.toBe(new Address(transitManagerKey).toString());
        expect(vaultServiceMock.pqGetKey).toHaveBeenCalledWith('manager', token, managersMount);
        expect(vaultServiceMock.getManagerPublicKey).not.toHaveBeenCalled();
      });

      it('resolves the transit key when the scheme is unset or ed25519', async () => {
        for (const value of [undefined, 'ed25519']) {
          configure({ VAULT_MANAGER_ACCOUNT_TYPE: value });
          await expect(walletService.resolveManagerAccount(token)).resolves.toEqual({
            type: 'ed25519',
            userId: 'manager',
            address: new Address(transitManagerKey).toString(),
            publicKey: transitManagerKey,
          });
        }
        expect(vaultServiceMock.pqGetKey).not.toHaveBeenCalled();
      });

      it.each(['falcon', 'FALCON1024', '', 'ed25519 '])('refuses the unknown scheme %p', async (value) => {
        configure({ VAULT_MANAGER_ACCOUNT_TYPE: value });
        // Never silently fall back to a different signing identity.
        await expect(walletService.resolveManagerAccount(token)).rejects.toThrow(/VAULT_MANAGER_ACCOUNT_TYPE/);
        expect(vaultServiceMock.getManagerPublicKey).not.toHaveBeenCalled();
        expect(vaultServiceMock.pqGetKey).not.toHaveBeenCalled();
      });

      it('refuses a manager mount aliased onto the user mount', async () => {
        configure({ VAULT_PQ_MANAGERS_PATH: usersMount });
        await expect(walletService.resolveManagerAccount(token)).rejects.toThrow(/must not equal VAULT_PQ_USERS_PATH/);
        expect(vaultServiceMock.pqGetKey).not.toHaveBeenCalled();
      });

      it('fails loudly when the manager key is missing', async () => {
        vaultServiceMock.pqGetKey.mockResolvedValue(undefined);
        await expect(walletService.resolveManagerAccount(token)).rejects.toThrow(/No falcon1024 manager key/);
      });

      it('validates at startup and reports an unusable key with context', async () => {
        await expect(walletService.onModuleInit()).resolves.toBeUndefined();
        expect(managerTokenProviderMock.getToken).toHaveBeenCalled();

        vaultServiceMock.pqGetKey.mockResolvedValue(undefined);
        await expect(walletService.onModuleInit()).rejects.toThrow(/is unusable/);
      });

      it('adds no PQ dependency or Vault login for an ed25519 manager', async () => {
        configure({ VAULT_MANAGER_ACCOUNT_TYPE: undefined });
        await expect(walletService.onModuleInit()).resolves.toBeUndefined();
        expect(managerTokenProviderMock.getToken).not.toHaveBeenCalled();
        expect(vaultServiceMock.pqGetKey).not.toHaveBeenCalled();
        expect(vaultServiceMock.getManagerPublicKey).not.toHaveBeenCalled();
      });
    });

    describe('signing and fees', () => {
      it('signs a manager payment with the manager mount and the caller token', async () => {
        await walletService.transferAlgoToAddress(token, 'manager', edAddress, 5);

        const signed = algosdk.decodeSignedTransaction(submitted() as Uint8Array);
        expect(signed.txn.sender.toString()).toBe(managerPqAddress.address.toString());
        expect(signed.txn.fee).toBe(3000n);
        expect(signed.sig).toBeUndefined();
        expect(Buffer.from(signed.pqsig!.pk)).toEqual(managerPqKey);
        expect(signed.pqsig!.slt).toBe(managerPqAddress.salt);
        expect(Buffer.from(signed.pqsig!.sch)).toEqual(Buffer.from('f1'));
        expect(Buffer.from(signed.pqsig!.sig)).toEqual(pqSignature);
        expect(algosdk.addressFromPQSig(signed.pqsig!).toString()).toBe(managerPqAddress.address.toString());
        // Exact bytes, to the manager mount, with the caller's token.
        expect(vaultServiceMock.pqSign).toHaveBeenCalledWith('manager', signed.txn.bytesToSign(), token, managersMount);
        expect(vaultServiceMock.signAsManager).not.toHaveBeenCalled();
      });

      it('creates a standalone asset through the shared submission path', async () => {
        const dto = {
          total: 5,
          decimals: 2n,
          defaultFrozen: false,
          unitName: 'Tasst',
          assetName: 'Test Asset',
          url: 'https://example.com',
          clawbackAddress: managerPqAddress.address.toString(),
        } as CreateAssetDto;

        await walletService.createAsset(dto, token);

        const signed = algosdk.decodeSignedTransaction(submitted() as Uint8Array);
        expect(signed.txn.sender.toString()).toBe(managerPqAddress.address.toString());
        expect(signed.txn.assetConfig!.clawback!.toString()).toBe(managerPqAddress.address.toString());
        expect(signed.txn.fee).toBe(3000n);
        expect(signed.pqsig).toBeDefined();
        expect(chainServiceMock.addPqFeeSurcharge).toHaveBeenCalledTimes(1);
        expect(chainServiceMock.getSuggestedParams).toHaveBeenCalledTimes(1);
      });

      it('claws back to the Falcon manager', async () => {
        vaultServiceMock.getUserPublicKey.mockResolvedValueOnce(edKey);
        chainServiceMock.getAccountBalance.mockResolvedValue(1000000n);

        await walletService.clawbackAsset(token, 1n, 'ed-user', 4, undefined, 'note');

        const signed = algosdk.decodeSignedTransaction(submitted() as Uint8Array);
        expect(signed.txn.sender.toString()).toBe(managerPqAddress.address.toString());
        expect(signed.txn.assetTransfer!.assetSender!.toString()).toBe(edAddress);
        expect(signed.txn.assetTransfer!.receiver.toString()).toBe(managerPqAddress.address.toString());
        expect(signed.txn.fee).toBe(3000n);
        expect(signed.pqsig).toBeDefined();
      });

      it('adds the surcharge to an explicit app-call fee', async () => {
        await walletService.appCall(token, { fromUserId: 'manager', appId: 123, fee: 5000 } as any);

        const signed = algosdk.decodeSignedTransaction(submitted() as Uint8Array);
        expect(signed.txn.fee).toBe(7000n);
        expect(signed.txn.sender.toString()).toBe(managerPqAddress.address.toString());
        expect(signed.pqsig).toBeDefined();
      });

      it('surcharges each manager entry once and resolves the manager once per group', async () => {
        await walletService.groupTransaction(token, {
          transactions: [1, 2, 3].map((amount) => ({
            type: 'payment',
            payload: { fromUserId: 'manager', toAddress: edAddress, amount },
          })),
        } as any);

        const signed = (submitted() as Uint8Array[]).map(algosdk.decodeSignedTransaction);
        expect(signed.map((entry) => entry.txn.fee)).toEqual([3000n, 3000n, 3000n]);
        expect(chainServiceMock.addPqFeeSurcharge).toHaveBeenCalledTimes(3);
        // One resolution for the whole operation, one signature each.
        expect(vaultServiceMock.pqGetKey).toHaveBeenCalledTimes(1);
        expect(vaultServiceMock.pqSign).toHaveBeenCalledTimes(3);

        // Fees were settled before grouping: every member carries the
        // group ID recomputed from the surcharged transactions, and each
        // signature covers those final bytes.
        const adjusted = chainServiceMock.setGroupID.mock.calls[0][0];
        expect(adjusted.map((tx) => decodeTransaction(tx).fee)).toEqual([3000n, 3000n, 3000n]);
        const expectedGroup = decodeTransaction(chainService.setGroupID(adjusted)[0]).group;
        for (const [index, entry] of signed.entries()) {
          expect(entry.txn.group).toEqual(expectedGroup);
          expect(vaultServiceMock.pqSign).toHaveBeenNthCalledWith(
            index + 1,
            'manager',
            entry.txn.bytesToSign(),
            token,
            managersMount,
          );
        }
      });

      it('mixes a Falcon manager with PQ and ed25519 users in one group', async () => {
        await walletService.groupTransaction(token, {
          transactions: [
            { type: 'payment', payload: { fromUserId: 'manager', toAddress: edAddress, amount: 1 } },
            { type: 'payment', payload: { fromUserId: 'pq-user', toAddress: edAddress, amount: 2 } },
            { type: 'payment', payload: { fromUserId: 'ed-user', toAddress: edAddress, amount: 3 } },
          ],
        } as any);

        const signed = (submitted() as Uint8Array[]).map(algosdk.decodeSignedTransaction);
        expect(signed.map((entry) => entry.txn.sender.toString())).toEqual([
          managerPqAddress.address.toString(),
          userPqAddress.toString(),
          edAddress,
        ]);
        expect(signed.map((entry) => entry.txn.fee)).toEqual([3000n, 3000n, 1000n]);
        expect(signed[2].pqsig).toBeUndefined();
        expect(Buffer.from(signed[2].sig!)).toEqual(edSignature);
        // Each Falcon signature went to its own mount with the same token.
        expect(vaultServiceMock.pqSign).toHaveBeenNthCalledWith(
          1,
          'manager',
          signed[0].txn.bytesToSign(),
          token,
          managersMount,
        );
        expect(vaultServiceMock.pqSign).toHaveBeenNthCalledWith(2, 'pq-user', signed[1].txn.bytesToSign(), token);
      });

      it('prefunds a user opt-in and transfers, surcharging only the manager legs', async () => {
        chainServiceMock.getAccountAsset.mockResolvedValue(null);
        chainServiceMock.getAccountDetail.mockResolvedValue({ amount: 0n, minBalance: 100000n, assets: [] });

        await walletService.transferAsset(token, 1n, 'ed-user', 10);

        const signed = (submitted() as Uint8Array[]).map(algosdk.decodeSignedTransaction);
        // manager payment, user opt-in, manager transfer
        expect(signed.map((entry) => entry.txn.sender.toString())).toEqual([
          managerPqAddress.address.toString(),
          edAddress,
          managerPqAddress.address.toString(),
        ]);
        expect(signed.map((entry) => entry.txn.fee)).toEqual([3000n, 1000n, 3000n]);
        expect(signed[1].pqsig).toBeUndefined();
        expect(vaultServiceMock.pqSign).toHaveBeenCalledTimes(2);
        expect(vaultServiceMock.pqGetKey).toHaveBeenCalledTimes(1);
      });

      it('covers every group step type with one manager resolution', async () => {
        await walletService.groupTransaction(token, {
          transactions: [
            { type: 'payment', payload: { fromUserId: 'manager', toAddress: edAddress, amount: 1 } },
            {
              type: 'assetConfig',
              payload: {
                total: 5,
                decimals: 0n,
                defaultFrozen: false,
                unitName: 'G',
                assetName: 'Group asset',
                url: 'https://example.com',
              },
            },
            { type: 'assetTransfer', payload: { userId: 'ed-user', assetId: 1n, amount: 2 } },
            { type: 'assetClawback', payload: { userId: 'ed-user', assetId: 1n, amount: 1 } },
            { type: 'appCall', payload: { fromUserId: 'manager', appId: 123 } },
            { type: 'payment', payload: { fromUserId: 'ed-user', toAddress: edAddress, amount: 3 } },
          ],
        } as any);

        const signed = (submitted() as Uint8Array[]).map(algosdk.decodeSignedTransaction);
        expect(signed.map((entry) => entry.txn.fee)).toEqual([3000n, 3000n, 3000n, 3000n, 3000n, 1000n]);
        // Five manager members, one resolution, one signature each — and
        // the ed25519 user is untouched by the surcharge.
        expect(chainServiceMock.addPqFeeSurcharge).toHaveBeenCalledTimes(5);
        expect(vaultServiceMock.pqGetKey).toHaveBeenCalledTimes(1);
        expect(vaultServiceMock.pqSign).toHaveBeenCalledTimes(5);
        expect(signed[5].pqsig).toBeUndefined();
        // Grouped asset creation shares the operation's params snapshot.
        expect(chainServiceMock.craftAssetCreateTx).toHaveBeenCalledWith(
          managerPqAddress.address.toString(),
          expect.objectContaining({ unitName: 'G' }),
          params,
        );
      });

      it('does not submit when the manager signature is denied', async () => {
        vaultServiceMock.pqSign.mockRejectedValue(new ForbiddenException());

        await expect(walletService.transferAlgoToAddress(token, 'manager', edAddress, 5)).rejects.toThrow();
        expect(chainServiceMock.submitTransaction).not.toHaveBeenCalled();
        // No fallback to the transit key or to the startup service token.
        expect(vaultServiceMock.signAsManager).not.toHaveBeenCalled();
        expect(managerTokenProviderMock.getToken).not.toHaveBeenCalled();
      });

      it('does not submit a group when a later signature fails', async () => {
        vaultServiceMock.pqSign.mockResolvedValueOnce(pqSignature).mockRejectedValueOnce(new ForbiddenException());

        await expect(
          walletService.groupTransaction(token, {
            transactions: [1, 2].map((amount) => ({
              type: 'payment',
              payload: { fromUserId: 'manager', toAddress: edAddress, amount },
            })),
          } as any),
        ).rejects.toThrow();
        expect(chainServiceMock.submitTransaction).not.toHaveBeenCalled();
      });
    });

    describe('getManagerInfo()', () => {
      beforeEach(() => {
        chainServiceMock.getAccountAssetHoldings.mockResolvedValue([]);
        chainServiceMock.getAccountBalance.mockResolvedValue(42n);
      });

      it('reports the Falcon address, its balances, and the account type', async () => {
        const result = await walletService.getManagerInfo(token);

        expect(result).toEqual(
          plainToClass(ManagerDetailDto, {
            public_address: managerPqAddress.address.toString(),
            assets: [],
            algoBalance: '42',
            account_type: 'falcon1024',
          }),
        );
        // Holdings and balance are queried for that same address.
        expect(chainServiceMock.getAccountAssetHoldings).toHaveBeenCalledWith(managerPqAddress.address.toString());
        expect(chainServiceMock.getAccountBalance).toHaveBeenCalledWith(managerPqAddress.address.toString());
      });

      it('leaves the ed25519 response shape unchanged', async () => {
        configure({ VAULT_MANAGER_ACCOUNT_TYPE: undefined });

        const result = await walletService.getManagerInfo(token);

        expect(result).toEqual(
          plainToClass(ManagerDetailDto, {
            public_address: new Address(transitManagerKey).toString(),
            assets: [],
            algoBalance: '42',
          }),
        );
        expect('account_type' in result).toBe(false);
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

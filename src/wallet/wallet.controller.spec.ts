import { Test, TestingModule } from '@nestjs/testing';
import { Wallet } from './wallet.controller';
import { WalletService } from './wallet.service';
import { CreateAssetDto } from './create-asset.dto';
import { UserInfoResponseDto } from './user-info-response.dto';
import createMockInstance from 'jest-create-mock-instance';
import { AssetTransferRequestDto } from './asset-transfer-request.dto';
import { AssetTransferResponseDto } from './asset-transfer-response.dto';
import { plainToClass } from 'class-transformer';

describe('Wallet Controller', () => {
  let walletController: Wallet;
  let mockWalletService: jest.Mocked<WalletService>;

  beforeAll(async () => {
    mockWalletService = createMockInstance(WalletService);

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [Wallet],
      providers: [
        {
          provide: WalletService,
          useValue: mockWalletService,
        },
      ],
    }).compile();

    walletController = moduleRef.get<Wallet>(Wallet);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('userDetail', () => {
    it('should return a public address for a user', async () => {
      const userId = 'user123';
      const vaultToken = 'vault-token-abc';
      const expectedPublicAddress = 'PUBLIC_ADDRESS_XYZ';

      // Set up the WalletService mock for getUserPublicAddress.
      mockWalletService.getUserInfo.mockResolvedValueOnce({ user_id: userId, public_address: expectedPublicAddress });

      const requestMock = { vault_token: vaultToken };

      const result = await walletController.userDetail(requestMock, userId);

      expect(mockWalletService.getUserInfo).toHaveBeenCalledWith(userId, vaultToken);
      expect(result).toEqual({ user_id: userId, public_address: expectedPublicAddress });
    });

    it('\(OK) create user', async () => {
      const userId = 'user123';
      const vaultToken = 'vault-token-abc';
      const expectedPublicAddress = 'PUBLIC_ADDRESS_XYZ';

      mockWalletService.userCreate.mockResolvedValueOnce({ user_id: userId, public_address: expectedPublicAddress });

      const result: UserInfoResponseDto = await walletController.userCreate(
        { vault_token: vaultToken },
        { user_id: userId },
      );

      expect(result.user_id).toEqual(userId);
      expect(result.public_address).toEqual(expectedPublicAddress);
    });
  });

  describe('assetsBalances', () => {
    it('should return asset balances for a user', async () => {
      const userId = 'user123';
      const vaultToken = 'vault-token-abc';
      const expectedPublicAddress = 'PUBLIC_ADDRESS_XYZ';
      const expectedAssets: AssetHolding[] = [
        { amount: BigInt(100), 'asset-id': 123, 'is-frozen': false },
        { amount: BigInt(200), 'asset-id': 456, 'is-frozen': true },
      ];
      const expectedAccountAssetsDto = {
        address: expectedPublicAddress,
        assets: expectedAssets,
      };
      const requestMock = { vault_token: vaultToken };
      mockWalletService.getAssetHoldings.mockResolvedValueOnce(expectedAssets);
      mockWalletService.getUserInfo.mockResolvedValueOnce({ user_id: userId, public_address: expectedPublicAddress });
      const result = await walletController.assetsBalances(requestMock, userId);
      expect(mockWalletService.getAssetHoldings).toHaveBeenCalledWith(userId, vaultToken);
      expect(mockWalletService.getUserInfo).toHaveBeenCalledWith(userId, vaultToken);
      expect(result).toEqual(expectedAccountAssetsDto);
    });
  })

  describe('createAsset', () => {
    it('should create an asset transaction and return the transaction id', async () => {
      const vaultToken = 'vault-token-def';
      const createAssetParams: CreateAssetDto = {
        total: 1000,
        decimals: BigInt(2),
        defaultFrozen: false,
        unitName: 'UNIT',
        assetName: 'Test Asset',
        url: 'http://example.com/asset',
        // optional properties like managerAddress, reserveAddress etc. can be added as needed
      };
      const expectedTransactionId = 'tx123456789';

      // Set up the WalletService mock for createAsset.
      mockWalletService.createAsset.mockResolvedValueOnce(expectedTransactionId);

      const requestMock = { vault_token: vaultToken };

      const result = await walletController.createAsset(requestMock, createAssetParams);

      expect(mockWalletService.createAsset).toHaveBeenCalledWith(createAssetParams, vaultToken);
      expect(result).toEqual({ transaction_id: expectedTransactionId });
    });
  });

  describe('assetTransferTx', () => {
    it('should transfer an asset and return the transaction id', async () => {
      const vaultToken = 'vault-token-ghi';
      const assetTransferRequest: AssetTransferRequestDto = {
        assetId: 123n,
        userId: 'user456',
        amount: 10,
      };
      const expectedTransactionId = 'tx987654321';

      mockWalletService.transferAsset.mockResolvedValueOnce(expectedTransactionId);

      const requestMock = { vault_token: vaultToken };

      const result: AssetTransferResponseDto = await walletController.assetTransferTx(
        requestMock,
        assetTransferRequest,
      );

      expect(mockWalletService.transferAsset).toHaveBeenCalledWith(
        assetTransferRequest.assetId,
        assetTransferRequest.userId,
        assetTransferRequest.amount,
        vaultToken,
      );
      expect(result).toEqual(plainToClass(AssetTransferResponseDto, { transaction_id: expectedTransactionId }));
    });
  });
});

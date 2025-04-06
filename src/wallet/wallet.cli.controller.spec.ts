import { Test, TestingModule } from '@nestjs/testing';
import { WalletCLI } from './wallet.cli.controller';
import { AuthService } from '../auth/auth.service';
import { VaultService } from '../vault/vault.service';
import { ChainService } from '../chain/chain.service';
import { ConfigService } from '@nestjs/config';
import { create } from 'domain';
import createMockInstance from 'jest-create-mock-instance';
import { randomBytes } from 'crypto';
import { AlgorandEncoder } from '@algorandfoundation/algo-models';

describe('WalletCLI', () => {
    let walletCLI: WalletCLI;
    let authServiceMock: jest.Mocked<AuthService>;
    let vaultServiceMock: jest.Mocked<VaultService>;
    let chainServiceMock: jest.Mocked<ChainService>;
    let configServiceMock: jest.Mocked<ConfigService>;

    let authService: AuthService;
    let vaultService: VaultService;
    let chainService: ChainService;

    beforeEach(async () => {
        authServiceMock = createMockInstance(AuthService);
        vaultServiceMock = createMockInstance(VaultService);
        chainServiceMock = createMockInstance(ChainService);
        configServiceMock = createMockInstance(ConfigService);

        const module: TestingModule = await Test.createTestingModule({
            controllers: [WalletCLI],
            providers: [
                {
                    provide: AuthService,
                    useValue: authServiceMock,
                },
                {
                    provide: VaultService,
                    useValue: vaultServiceMock,
                },
                {
                    provide: ChainService,
                    useValue: chainServiceMock,
                },
                ConfigService,
            ],
        }).compile();

        walletCLI = module.get<WalletCLI>(WalletCLI);
        authService = module.get<AuthService>(AuthService);
        vaultService = module.get<VaultService>(VaultService);
        chainService = module.get<ChainService>(ChainService);
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should be defined', () => {
        expect(walletCLI).toBeDefined();
    });

    describe('login', () => {
        it('\(OK) should login successfully', async () => {
            const roleId = 'role-id';
            const secretId = 'secretId';

            authServiceMock.signInWithRole.mockResolvedValueOnce('vault-token');
            const result = await walletCLI.login(roleId, secretId);
            expect(result).toBe(true);
            expect(authServiceMock.signInWithRole).toHaveBeenCalledWith(roleId, secretId);
        })

        it('\(FAIL) should fail to login', async () => {
            const roleId = 'role-id';
            const secretId = 'secretId';
            authServiceMock.signInWithRole.mockRejectedValueOnce(new Error('Login failed'));
            const result = await walletCLI.login(roleId, secretId);
            expect(result).toBe(false);
            expect(authServiceMock.signInWithRole).toHaveBeenCalledWith(roleId, secretId);
        })
    })

    describe('getAddress', () => {
        it('\(OK) should return the address', async () => {
            const keyPath = 'key-path';
            const keyName = 'key-name';
            const pubKey: Buffer = randomBytes(32);

            vaultServiceMock.getKey.mockResolvedValueOnce(pubKey);

            const result = await walletCLI.getAddress(keyPath, keyName);
            expect(result).toEqual(new AlgorandEncoder().encodeAddress(pubKey));
            expect(vaultServiceMock.getKey).toHaveBeenCalledWith(keyName, keyPath, undefined);

        });
    })

    describe('sign', () => {
        it('\(OK) should sign data', async () => {
            const data = randomBytes(32);
            const keyPath = 'key-path';
            const keyName = 'key-name';
            const pubKey: Buffer = randomBytes(32);
            const signature: Buffer = Buffer.from(`vault:v1:${data.toString('base64')}`, 'utf-8');

            vaultServiceMock.sign.mockResolvedValueOnce(signature);

            const result = await walletCLI.sign(data, keyPath, keyName);
            expect(result).toEqual(new Uint8Array(data));
            expect(vaultServiceMock.sign).toHaveBeenCalledWith(keyName, keyPath, expect.any(Buffer), undefined);
        });
    });

    describe('submitTransaction', () => {
        it('\(OK) should submit a transaction', async () => {
            const txn = randomBytes(32);
            const response: TruncatedPostTransactionsResponse = {
                txid: 'transaction-id',
            }

            chainServiceMock.submitTransaction.mockResolvedValueOnce(response);

            const result = await walletCLI.submitTransaction(txn);
            expect(result).toEqual(response);
            expect(chainServiceMock.submitTransaction).toHaveBeenCalledWith(txn);
        });
    });
});


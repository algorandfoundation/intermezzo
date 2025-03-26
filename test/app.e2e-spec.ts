import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as fs from 'fs';
import { AppModule } from './../src/app.module';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { ChainService } from '../src/chain/chain.service';
import { HttpService } from '@nestjs/axios';

const APP_BASE_URL = 'http://localhost:3000/v1';
const VAULT_BASE_URL = 'http://localhost:8200';
const VAULT_TRANSIT_USERS_PATH = 'pawn/users';
const VAULT_TRANSIT_MANAGERS_PATH = 'pawn/managers';
const VAULT_MANAGER_KEY = 'manager';

// Load role and secret information from JSON files
const MANAGER_ROLE_AND_SECRET = JSON.parse(fs.readFileSync('manager-role-and-secrets.json').toString());
const USER_ROLE_AND_SECRET = JSON.parse(fs.readFileSync('user-role-and-secrets.json').toString());

/**
 * Current endpoints:
 *
 * - AUTH ENDPOINTS
 *      - POST /auth/sign-in/
 *
 * - WALLET ENDPOINTS
 *   - Users
 *       - GET /wallet/users/:user_id/
 *       - POST /wallet/users/
 *       - GET /wallet/users/
 *   - Managers
 *       - GET /wallet/manager/
 *   - Transactions
 *       - POST /wallet/transactions/create-asset/
 *
 */

describe('App E2E', () => {
  let app: INestApplication;

  // Initialize the NestJS application before each test
  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  // Function to login to Vault and retrieve a token
  const loginToVault = async (roleAndSecret: any) => {
    const response = await axios.post(`${VAULT_BASE_URL}/v1/auth/approle/login`, roleAndSecret);
    return response.data.auth.client_token;
  };

  // Function to sign in to the application using the Vault token
  const signInToPawn = async (vaultToken: string) => {
    const response = await axios.post(`${APP_BASE_URL}/auth/sign-in/`, { vault_token: vaultToken });
    return response.data.access_token;
  };

  // Function to get manager address
  const getManagerAddress = async () => {
    const vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
    const accessToken = await signInToPawn(vaultToken);

    const manager_detail_response = await axios.get(`${APP_BASE_URL}/wallet/manager/`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return manager_detail_response.data.public_address;
  };

  // Function to get account detail
  const getAccountDetail = async (address: string) => {
    let chainService = new ChainService(new ConfigService(), new HttpService());
    return await chainService.getAccountDetail(address);
  };

  describe('AUTH', () => {
    // Test to verify that a user can sign in to the application
    it('(OK) Can sign in', async () => {
      const vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      const response = await axios.post(`${APP_BASE_URL}/auth/sign-in/`, { vault_token: vaultToken });

      expect(response.data).toHaveProperty('access_token');
      expect(response.status).toBe(201); // HTTP 201 Created
    });

    // Test to verify that a user cannot sign in to the application with invalid credentials
    it('(FAIL) Cannot sign in with invalid credentials', async () => {
      await expect(signInToPawn('invalid-vault-token')).rejects.toMatchObject({ response: { status: 403 } });
    });
  });

  describe('User detail', () => {
    // Test to verify that a user with the user role can fetch wallet details
    it('(OK) Create and fetch with manager role', async () => {
      const vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      const accessToken = await signInToPawn(vaultToken);

      // random user id
      const user_uid = randomBytes(32).toString('hex');

      const create_user_response = await axios.post(
        `${APP_BASE_URL}/wallet/user/`,
        { user_id: user_uid },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      );
      expect(create_user_response.status).toBe(201); // HTTP 201 Created
      expect(create_user_response.data.user_id).toEqual(user_uid);
      expect(typeof create_user_response.data.public_address).toBe('string');

      const user_detail_response = await axios.get(`${APP_BASE_URL}/wallet/users/${user_uid}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(user_detail_response.status).toBe(200); // HTTP 200 OK
      expect(user_detail_response.data).toStrictEqual({
        user_id: user_uid,
        public_address: create_user_response.data.public_address,
      });
    });
  });

  describe('Manager detail', () => {
    // Test to verify that a user with the user role can fetch wallet details
    it('(OK) Get manager detail with manager role', async () => {
      const vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      const accessToken = await signInToPawn(vaultToken);

      const response = await axios.get(`${APP_BASE_URL}/wallet/manager/`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(response.status).toBe(200); // HTTP 200 OK
      expect(typeof response.data.public_address).toBe('string');
    });

    it('(FAIL) User fails to fetch manager role due to permissions', async () => {
      const vaultToken = await loginToVault(USER_ROLE_AND_SECRET);
      const accessToken = await signInToPawn(vaultToken);

      await expect(
        axios.get(`${APP_BASE_URL}/wallet/users/manager`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      ).rejects.toMatchObject({ response: { status: 404 } }); // HTTP 404 Not Found
    });
  });

  describe('Users List', () => {
    it('(OK) Can fetch ALL users with the manager role', async () => {
      const vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      const accessToken = await signInToPawn(vaultToken);

      const response = await axios.get(`${APP_BASE_URL}/wallet/users`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      expect(response.status).toBe(200); // HTTP 200 OK
      expect(Array.isArray(response.data)).toBe(true);
    });

    it('(FAIL) Cannot fetch ALL users with the users role', async () => {
      const vaultToken = await loginToVault(USER_ROLE_AND_SECRET);
      const accessToken = await signInToPawn(vaultToken);

      await expect(
        axios.get(`${APP_BASE_URL}/wallet/users`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      ).rejects.toMatchObject({ response: { status: 403 } }); // HTTP 403 Forbidden
    });
  });

  describe('Vault', () => {
    it('(FAIL) User fails to fetch manager role due to permissions', async () => {
      const vaultToken = await loginToVault(USER_ROLE_AND_SECRET);
      const accessToken = await signInToPawn(vaultToken);

      await expect(
        axios.get(`${APP_BASE_URL}/wallet/users/manager`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      ).rejects.toMatchObject({ response: { status: 404 } }); // HTTP 404 Not Found
    });

    it('(FAIL) Cannot config user and manager keys', async () => {
      const managerVaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      const userVaultToken = await loginToVault(USER_ROLE_AND_SECRET);
      const accessToken = await signInToPawn(managerVaultToken);

      // random user id
      const user_uid = randomBytes(32).toString('hex');

      const create_user_response = await axios.post(
        `${APP_BASE_URL}/wallet/user/`,
        { user_id: user_uid },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      );
      expect(create_user_response.status).toBe(201);

      // can not use `config` on users key
      let vaultKeys = [userVaultToken, managerVaultToken];

      for (let vaultKey of vaultKeys) {
        // can not config user
        await expect(
          axios.post(
            `${VAULT_BASE_URL}/v1/${VAULT_TRANSIT_USERS_PATH}/keys/${user_uid}/config`,
            { deletion_allowed: true },
            {
              headers: {
                'X-Vault-Token': `${vaultKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
            },
          ),
        ).rejects.toMatchObject({ response: { status: 403 } });

        // can not config manager
        await expect(
          axios.post(
            `${VAULT_BASE_URL}/v1/${VAULT_TRANSIT_MANAGERS_PATH}/keys/${VAULT_MANAGER_KEY}/config`,
            { deletion_allowed: true },
            {
              headers: {
                'X-Vault-Token': `${vaultKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
            },
          ),
        ).rejects.toMatchObject({ response: { status: 403 } });
      }
    });
  });

  describe('Asset creation', () => {
    /**
     * Represents the data structure for an asset.
     *
     * @property {number} total - The total amount of the asset.
     * @property {number} decimals - The number of decimal places for the asset.
     * @property {boolean} defaultFrozen - Indicates if the asset is frozen by default.
     * @property {string} unitName - The unit name of the asset.
     * @property {string} assetName - The name of the asset.
     * @property {string} url - The URL associated with the asset.
     * @property {string} managerAddress - The address of the asset manager.
     * @property {string} reserveAddress - The address of the asset reserve.
     * @property {string} freezeAddress - The address of the asset freeze.
     * @property {string} clawbackAddress - The address of the asset clawback.
     */
    const assetData = {
      total: 100000,
      decimals: 0,
      defaultFrozen: false,
      unitName: 'Tas',
      assetName: 'Tennnnnnnnnnnnnnnnnn',
      url: 'https://example.com',
      managerAddress: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
      reserveAddress: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
      freezeAddress: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
      clawbackAddress: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
    };

    // Test to verify that a user with the manager role can create an asset
    it('(OK) Can create with manager role', async () => {
      const vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      const accessToken = await signInToPawn(vaultToken);

      try {
        const response = await axios.post(`${APP_BASE_URL}/wallet/transactions/create-asset`, assetData, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        expect(response.status).toBe(201); // HTTP 201 Created
        expect(typeof response.data.transaction_id).toEqual('string');
      } catch (error) {
        throw new Error(
          `Unexpected Error.\nYou have to add some algo to manager addrees: ${await getManagerAddress()}\nYou can use https://bank.testnet.algorand.network/`,
        );
      }
    }, 60000);

    // Test to verify that a user with the user role cannot create an asset
    it('(FAIL) Can not create with user role', async () => {
      const vaultToken = await loginToVault(USER_ROLE_AND_SECRET);
      const accessToken = await signInToPawn(vaultToken);

      await expect(
        axios.post(`${APP_BASE_URL}/wallet/transactions/create-asset`, assetData, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      ).rejects.toMatchObject({ response: { status: 403 } }); // HTTP 403 Forbidden
    }, 60000);
  });

  describe('Transfer Asset', () => {
    /**
     * Represents the data structure for an asset transfer.
     *
     * @property {bigint} assetId - The ID of the asset to be transferred.
     * @property {string} userId - The ID of the user receiving the asset.
     * @property {number} amount - The amount of the asset to be transferred
     */
    const assetTransferRequestData = {
      assetId: 1,
      userId: 'test-user-id',
      amount: 1,
    };

    let assetId: bigint | number;

    beforeAll(async () => {
      // before all tests, create an asset and set assetId
      const vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      const managerAccessToken = await signInToPawn(vaultToken);

      const assetData = {
        total: 100000,
        decimals: 0,
        defaultFrozen: false,
        unitName: 'Tas',
        assetName: 'Tennnnnnnnnnnnnnnnnn',
        url: 'https://example.com',
      };
      const createAssetResponse = await axios.post(`${APP_BASE_URL}/wallet/transactions/create-asset`, assetData, {
        headers: { Authorization: `Bearer ${managerAccessToken}` },
      });
      expect(createAssetResponse.status).toBe(201); // HTTP 201 Created

      const managerAddress = await getManagerAddress();
      const managerDetail = await getAccountDetail(managerAddress);
      assetId = managerDetail.assets.reduce((max, current) => (current.assetId > max.assetId ? current : max), {
        assetId: 0,
      }).assetId;
      if (assetId == 0) {
        throw new Error('Manager does not asset to testing transfer.');
      }
    }, 60000);

    it('(OK) transfer asset', async () => {
      const vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      const managerAccessToken = await signInToPawn(vaultToken);

      // Create new user

      const userId = randomBytes(32).toString('hex');
      const createUserResponse = await axios.post(
        `${APP_BASE_URL}/wallet/user/`,
        { user_id: userId },
        {
          headers: {
            Authorization: `Bearer ${managerAccessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      );
      expect(createUserResponse.status).toBe(201);

      assetTransferRequestData.assetId = Number(assetId);
      assetTransferRequestData.userId = userId;

      // Transfer the asset

      const response1 = await axios.post(
        `${APP_BASE_URL}/wallet/transactions/transfer-asset`,
        assetTransferRequestData,
        {
          headers: { Authorization: `Bearer ${managerAccessToken}` },
        },
      );
      expect(response1.status).toBe(201); // HTTP 201 Created
      expect(typeof response1.data.transaction_id).toEqual('string');

      // transfer it again

      const response2 = await axios.post(
        `${APP_BASE_URL}/wallet/transactions/transfer-asset`,
        assetTransferRequestData,
        {
          headers: { Authorization: `Bearer ${managerAccessToken}` },
        },
      );
      expect(response2.status).toBe(201); // HTTP 201 Created
      expect(typeof response2.data.transaction_id).toEqual('string');
    }, 60000);

    it('(FAIL) can transfer asset if user permission', async () => {
      const userVaultToken = await loginToVault(USER_ROLE_AND_SECRET);
      const userAccessToken = await signInToPawn(userVaultToken);

      const managerVaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      const managerAccessToken = await signInToPawn(managerVaultToken);

      // Create new user

      const userId = randomBytes(32).toString('hex');
      const createUserResponse = await axios.post(
        `${APP_BASE_URL}/wallet/user/`,
        { user_id: userId },
        {
          headers: {
            Authorization: `Bearer ${managerAccessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      );
      expect(createUserResponse.status).toBe(201);

      assetTransferRequestData.assetId = Number(assetId);
      assetTransferRequestData.userId = userId;

      // Transfer the asset

      await expect(
        axios.post(`${APP_BASE_URL}/wallet/transactions/transfer-asset`, assetTransferRequestData, {
          headers: { Authorization: `Bearer ${userAccessToken}` },
        }),
      ).rejects.toMatchObject({ response: { status: 403 } });
    }, 60000);
  });
});

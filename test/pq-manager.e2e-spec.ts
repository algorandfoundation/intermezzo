import * as fs from 'fs';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ChainService } from '../src/chain/chain.service';
import { HttpService } from '@nestjs/axios';
import * as algosdk from 'algosdk';

const APP_BASE_URL = 'http://localhost:3000/v1';
const VAULT_BASE_URL = 'http://localhost:8200';
const VAULT_TRANSIT_MANAGERS_PATH = process.env.VAULT_TRANSIT_MANAGERS_PATH ?? 'pawn/managers';
const VAULT_PQ_USERS_PATH = process.env.VAULT_PQ_USERS_PATH ?? 'pawn/pq-users';
const VAULT_PQ_MANAGERS_PATH = process.env.VAULT_PQ_MANAGERS_PATH ?? 'pawn/pq-managers';
const VAULT_MANAGER_KEY = process.env.VAULT_MANAGER_KEY ?? 'manager';

const MANAGER_ROLE_AND_SECRET = JSON.parse(fs.readFileSync('manager-role-and-secrets.json').toString());
const USER_ROLE_AND_SECRET = JSON.parse(fs.readFileSync('user-role-and-secrets.json').toString());

/**
 * Wallet manager account E2E.
 *
 * Runs against the manager scheme configured in `.env`, and fails if the
 * running service reports a different one. It is not a matrix inside one
 * process — switching the manager account requires provisioning and a
 * restart, so CI runs this file once per configuration. Operations the
 * manager performs are covered by the existing suites, which CI runs in
 * both configurations.
 */
describe('Wallet manager account E2E', () => {
  let managerVaultToken: string;
  let managerAccessToken: string;
  let userVaultToken: string;
  let managerAddress: string;
  let accountType: 'ed25519' | 'falcon1024';
  let transitAddress: string;
  let chain: ChainService;
  let algod: algosdk.Algodv2;

  const loginToVault = async (roleAndSecret: any) => {
    const response = await axios.post(`${VAULT_BASE_URL}/v1/auth/approle/login`, roleAndSecret);
    return response.data.auth.client_token;
  };

  const signInToPawn = async (vaultToken: string) => {
    const response = await axios.post(`${APP_BASE_URL}/auth/sign-in/`, { vault_token: vaultToken });
    return response.data.access_token;
  };

  const post = async (path: string, body: any) => {
    const response = await axios.post(`${APP_BASE_URL}/${path}`, body, {
      headers: { Authorization: `Bearer ${managerAccessToken}` },
    });
    return response.data;
  };

  const vaultGet = (mount: string, path: string, token: string) =>
    axios.get(`${VAULT_BASE_URL}/v1/${mount}/${path}`, { headers: { 'X-Vault-Token': token } });

  const vaultPost = (mount: string, path: string, token: string, body: any = {}) =>
    axios.post(`${VAULT_BASE_URL}/v1/${mount}/${path}`, body, { headers: { 'X-Vault-Token': token } });

  beforeAll(async () => {
    ConfigModule.forRoot();
    managerVaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
    userVaultToken = await loginToVault(USER_ROLE_AND_SECRET);
    managerAccessToken = await signInToPawn(managerVaultToken);

    const detail = await axios.get(`${APP_BASE_URL}/wallet/manager/`, {
      headers: { Authorization: `Bearer ${managerAccessToken}` },
    });
    managerAddress = detail.data.public_address;
    accountType = detail.data.account_type ?? 'ed25519';

    // The transit identity is always provisioned: DID/OID4VC signs with
    // it whichever scheme the wallet uses.
    const transitKey = await vaultGet(VAULT_TRANSIT_MANAGERS_PATH, `keys/${VAULT_MANAGER_KEY}`, managerVaultToken);
    transitAddress = new algosdk.Address(Buffer.from(transitKey.data.data.keys['1'].public_key, 'base64')).toString();

    const config = new ConfigService();
    // Pin the configured scheme, so a Falcon run cannot pass as ed25519.
    expect(accountType).toBe(config.get<string>('VAULT_MANAGER_ACCOUNT_TYPE') || 'ed25519');
    chain = new ChainService(config, new HttpService());
    algod = new algosdk.Algodv2(
      config.get<string>('NODE_TOKEN'),
      `${config.get<string>('NODE_HTTP_SCHEME')}://${config.get<string>('NODE_HOST')}`,
      config.get<string>('NODE_PORT'),
    );
  }, 60000);

  describe('resolution and response shape', () => {
    it('reports an address derived from the configured key', async () => {
      if (accountType === 'falcon1024') {
        const key = await vaultGet(VAULT_PQ_MANAGERS_PATH, `keys/${VAULT_MANAGER_KEY}`, managerVaultToken);
        const publicKey = Buffer.from(key.data.data.public_key, 'base64');
        expect(publicKey).toHaveLength(1793);
        // Derived here from the Vault key, not copied from the response.
        expect(algosdk.addressFromPQKey(Buffer.from('f1'), publicKey).address.toString()).toBe(managerAddress);
        // A Falcon wallet manager is a different account from the transit
        // identity — funding or using one does not affect the other.
        expect(managerAddress).not.toBe(transitAddress);
        expect(fs.readFileSync('pq-manager-address.txt', 'utf8').trim()).toBe(managerAddress);
      } else {
        expect(managerAddress).toBe(transitAddress);
        // The historical response shape carries no discriminator.
        const detail = await axios.get(`${APP_BASE_URL}/wallet/manager/`, {
          headers: { Authorization: `Bearer ${managerAccessToken}` },
        });
        expect(detail.data.account_type).toBeUndefined();
        expect(Object.keys(detail.data).sort()).toEqual(['algoBalance', 'assets', 'public_address']);
      }
      expect(fs.readFileSync('manager-address.txt', 'utf8').trim()).toBe(transitAddress);
    });
  });

  describe('mount isolation', () => {
    // Only meaningful once the manager mount exists.
    const whenFalcon = (name: string, fn: () => Promise<void>) =>
      it(
        name,
        async () => {
          if (accountType !== 'falcon1024') return;
          await fn();
        },
        60000,
      );

    whenFalcon('denies the user AppRole every operation on the manager mount', async () => {
      const denied = (promise: Promise<unknown>) =>
        expect(promise).rejects.toMatchObject({ response: { status: 403 } });

      await denied(vaultGet(VAULT_PQ_MANAGERS_PATH, `keys/${VAULT_MANAGER_KEY}`, userVaultToken));
      await denied(vaultPost(VAULT_PQ_MANAGERS_PATH, `keys/${randomBytes(8).toString('hex')}`, userVaultToken));
      await denied(
        vaultPost(VAULT_PQ_MANAGERS_PATH, `sign/${VAULT_MANAGER_KEY}`, userVaultToken, {
          input: Buffer.from('TX-denied').toString('base64'),
        }),
      );
      await denied(
        axios.request({
          url: `${VAULT_BASE_URL}/v1/${VAULT_PQ_MANAGERS_PATH}/keys`,
          method: 'LIST',
          headers: { 'X-Vault-Token': userVaultToken },
        }),
      );
    });

    whenFalcon('lets the manager AppRole use its key and still serve PQ users', async () => {
      const signature = await vaultPost(VAULT_PQ_MANAGERS_PATH, `sign/${VAULT_MANAGER_KEY}`, managerVaultToken, {
        input: Buffer.from('TX-manager').toString('base64'),
      });
      expect(Buffer.from(signature.data.data.signature, 'base64').length).toBeGreaterThan(1000);

      // The same AppRole still creates and signs for PQ users, and still
      // writes account-type claims.
      const userId = randomBytes(16).toString('hex');
      const created = await vaultPost(VAULT_PQ_USERS_PATH, `keys/${userId}`, managerVaultToken);
      expect(Buffer.from(created.data.data.public_key, 'base64')).toHaveLength(1793);
      const userSignature = await vaultPost(VAULT_PQ_USERS_PATH, `sign/${userId}`, managerVaultToken, {
        input: Buffer.from('TX-user').toString('base64'),
      });
      expect(Buffer.from(userSignature.data.data.signature, 'base64').length).toBeGreaterThan(1000);
      await expect(
        post('wallet/user/', { user_id: randomBytes(16).toString('hex'), account_type: 'falcon1024' }),
      ).resolves.toMatchObject({ account_type: 'falcon1024' });
    });

    whenFalcon('keeps the manager key unreachable through the user mount', async () => {
      // Same key name, different mounts, different key spaces. This is
      // read-only on purpose: the plugin has no delete operation, so
      // creating a PQ user actually named `manager` here would leave a
      // permanent account that makes `/wallet/users/manager` resolve for
      // every later caller.
      const managerKey = (await vaultGet(VAULT_PQ_MANAGERS_PATH, `keys/${VAULT_MANAGER_KEY}`, managerVaultToken)).data
        .data.public_key;
      expect(Buffer.from(managerKey, 'base64')).toHaveLength(1793);

      await expect(vaultGet(VAULT_PQ_USERS_PATH, `keys/${VAULT_MANAGER_KEY}`, managerVaultToken)).rejects.toMatchObject(
        { response: { status: 404 } },
      );

      // The user listing reads the user mount only, so the manager key
      // never appears in it.
      const listed = await axios.request({
        url: `${VAULT_BASE_URL}/v1/${VAULT_PQ_USERS_PATH}/keys`,
        method: 'LIST',
        headers: { 'X-Vault-Token': managerVaultToken },
      });
      expect(listed.data.data.keys ?? []).not.toContain(VAULT_MANAGER_KEY);

      // And the application agrees: the manager account is not a user.
      await expect(
        axios.get(`${APP_BASE_URL}/wallet/users/${VAULT_MANAGER_KEY}`, {
          headers: { Authorization: `Bearer ${managerAccessToken}` },
        }),
      ).rejects.toMatchObject({ response: { status: 404 } });
    });
  });

  describe('chain proof', () => {
    it('confirms a mixed manager, PQ user and ed25519 user group', async () => {
      const users = await Promise.all(
        (['falcon1024', 'ed25519'] as const).map((account_type) =>
          post('wallet/user/', { user_id: randomBytes(16).toString('hex'), account_type }),
        ),
      );
      // Fund the users so they can pay their own (surcharged) fees.
      for (const user of users) {
        await post('wallet/transactions/transfer-algo/', {
          fromUserId: 'manager',
          toAddress: user.public_address,
          amount: 1000000,
        });
      }

      const result = await post('wallet/transactions/group-transaction/', {
        transactions: [
          { type: 'payment', payload: { fromUserId: 'manager', toAddress: users[0].public_address, amount: 1 } },
          ...users.map((user) => ({
            type: 'payment',
            payload: { fromUserId: user.user_id, toAddress: managerAddress, amount: 2 },
          })),
        ],
      });

      const pending = await algod.pendingTransactionInformation(result.group_id).do();
      expect(pending.confirmedRound).toBeGreaterThan(0n);
      expect(pending.txn.txn.group).toBeDefined();
      expect(pending.txn.txn.sender.toString()).toBe(managerAddress);
      // The manager member carries its own scheme's envelope and fee.
      if (accountType === 'falcon1024') {
        expect(pending.txn.sig).toBeUndefined();
        expect(algosdk.addressFromPQSig(pending.txn.pqsig!).toString()).toBe(managerAddress);
        expect(pending.txn.txn.fee).toBe(3000n);
      } else {
        expect(pending.txn.pqsig).toBeUndefined();
        expect(pending.txn.sig).toHaveLength(64);
        expect(pending.txn.txn.fee).toBe(1000n);
      }
      // The user members confirmed in the same group, each paying its own
      // scheme's fee.
      expect(await chain.getAccountBalance(users[0].public_address)).toBe(1000000n + 1n - 3000n - 2n);
      expect(await chain.getAccountBalance(users[1].public_address)).toBe(1000000n - 1000n - 2n);
    }, 120000);
  });

  describe('identity regression', () => {
    it('keeps the DID identity on the transit key', async () => {
      let identity = await axios
        .get(`${APP_BASE_URL}/wallet/manager/identity`, {
          headers: { Authorization: `Bearer ${managerAccessToken}` },
        })
        .catch((error) => {
          if (error?.response?.status !== 404) throw error;
          return undefined;
        });

      if (!identity) {
        await axios.post(
          `${APP_BASE_URL}/wallet/manager/identity`,
          {},
          { headers: { Authorization: `Bearer ${managerAccessToken}` } },
        );
        identity = await axios.get(`${APP_BASE_URL}/wallet/manager/identity`, {
          headers: { Authorization: `Bearer ${managerAccessToken}` },
        });
      }

      expect(identity!.data.did).toMatch(/^did:algo:/);
      // The DIDAlgoStorage contract is deployed and signed by the transit
      // identity even when the wallet manager is Falcon.
      const app = await algod.getApplicationByID(BigInt(identity!.data.appId)).do();
      expect(String(app.params.creator)).toBe(transitAddress);
      if (accountType === 'falcon1024') expect(String(app.params.creator)).not.toBe(managerAddress);
    }, 180000);

    // Credential issuance under each manager scheme is covered by the full
    // OID4VCI flow in app.e2e-spec.ts, which CI runs in both configurations.
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as fs from 'fs';
import { AppModule } from './../src/app.module';
import axios from 'axios';
import * as crypto from 'crypto';
import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { ChainService } from '../src/chain/chain.service';
import { Address } from '@algorandfoundation/algokit-utils';
import { HttpService } from '@nestjs/axios';
import * as algosdk from 'algosdk';

const APP_BASE_URL = 'http://localhost:3000/v1';
const VAULT_BASE_URL = 'http://localhost:8200';
const VAULT_PQ_USERS_PATH = 'pawn/pq-users';

// Load role and secret information from JSON files
const MANAGER_ROLE_AND_SECRET = JSON.parse(fs.readFileSync('manager-role-and-secrets.json').toString());
const USER_ROLE_AND_SECRET = JSON.parse(fs.readFileSync('user-role-and-secrets.json').toString());

describe('PQ accounts E2E', () => {
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

  // The `algorand-pq` secrets engine is a custom plugin (vault/plugin/), so
  // these talk to Vault directly — no service endpoints expose PQ accounts yet.
  describe('PQ accounts (algorand-pq plugin)', () => {
    const pqKey = (token: string, name: string) =>
      axios.get(`${VAULT_BASE_URL}/v1/${VAULT_PQ_USERS_PATH}/keys/${name}`, {
        headers: { 'X-Vault-Token': token },
      });

    it('(OK) Creates an account whose address matches an independent derivation', async () => {
      const vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      const name = randomBytes(16).toString('hex');

      const created = await axios.post(
        `${VAULT_BASE_URL}/v1/${VAULT_PQ_USERS_PATH}/keys/${name}`,
        {},
        { headers: { 'X-Vault-Token': vaultToken } },
      );
      expect(created.status).toBe(200);

      const { scheme, salt, public_key, address } = created.data.data;
      expect(scheme).toBe('f1');
      expect(salt).toBeGreaterThanOrEqual(0);
      expect(salt).toBeLessThanOrEqual(255);
      // Falcon-1024 public key.
      expect(Buffer.from(public_key, 'base64')).toHaveLength(1793);

      // Re-derive the address here rather than trusting the plugin's copy:
      // SHA512-256("PQA" || scheme || salt || pk), rendered with Algorand's
      // usual base32+checksum encoding.
      const preimage = Buffer.concat([
        Buffer.from('PQA'),
        Buffer.from(scheme),
        Buffer.from([salt]),
        Buffer.from(public_key, 'base64'),
      ]);
      const digest = crypto.createHash('sha512-256').update(preimage).digest();
      expect(new Address(new Uint8Array(digest)).toString()).toBe(address);

      // Reading returns exactly what creating reported, and creating again is
      // idempotent rather than silently re-keying the account.
      const read = await pqKey(vaultToken, name);
      expect(read.data.data).toStrictEqual(created.data.data);
      const recreated = await axios.post(
        `${VAULT_BASE_URL}/v1/${VAULT_PQ_USERS_PATH}/keys/${name}`,
        {},
        { headers: { 'X-Vault-Token': vaultToken } },
      );
      expect(recreated.data.data.address).toBe(address);
    });

    it('(OK) Signs with the manager role', async () => {
      const vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      const name = randomBytes(16).toString('hex');
      await axios.post(
        `${VAULT_BASE_URL}/v1/${VAULT_PQ_USERS_PATH}/keys/${name}`,
        {},
        { headers: { 'X-Vault-Token': vaultToken } },
      );

      const response = await axios.post(
        `${VAULT_BASE_URL}/v1/${VAULT_PQ_USERS_PATH}/sign/${name}`,
        { input: Buffer.from('TX-e2e').toString('base64') },
        { headers: { 'X-Vault-Token': vaultToken } },
      );

      // Compressed Falcon-1024 signatures are variable length but always far
      // larger than the 64-byte ed25519 ones the transit engine returns.
      const signature = Buffer.from(response.data.data.signature, 'base64');
      expect(signature.length).toBeGreaterThan(1000);
      expect(signature.length).toBeLessThanOrEqual(1538);
    });

    it('(FAIL) User role can create but cannot sign', async () => {
      const vaultToken = await loginToVault(USER_ROLE_AND_SECRET);
      const name = randomBytes(16).toString('hex');

      const created = await axios.post(
        `${VAULT_BASE_URL}/v1/${VAULT_PQ_USERS_PATH}/keys/${name}`,
        {},
        { headers: { 'X-Vault-Token': vaultToken } },
      );
      expect(created.status).toBe(200);

      await expect(
        axios.post(
          `${VAULT_BASE_URL}/v1/${VAULT_PQ_USERS_PATH}/sign/${name}`,
          { input: Buffer.from('TX-e2e').toString('base64') },
          { headers: { 'X-Vault-Token': vaultToken } },
        ),
      ).rejects.toMatchObject({ response: { status: 403 } });
    });

    it('(FAIL) Rejects unknown keys and undecodable input', async () => {
      const vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      const name = randomBytes(16).toString('hex');
      await axios.post(
        `${VAULT_BASE_URL}/v1/${VAULT_PQ_USERS_PATH}/keys/${name}`,
        {},
        { headers: { 'X-Vault-Token': vaultToken } },
      );

      await expect(pqKey(vaultToken, 'no-such-key')).rejects.toMatchObject({ response: { status: 404 } });
      await expect(
        axios.post(
          `${VAULT_BASE_URL}/v1/${VAULT_PQ_USERS_PATH}/sign/${name}`,
          { input: 'not-base64!!' },
          { headers: { 'X-Vault-Token': vaultToken } },
        ),
      ).rejects.toMatchObject({ response: { status: 400 } });
    });
  });

  // The same accounts, now through the service endpoints rather than
  // straight to Vault. Nothing here needs to know which mount a user
  // lives in — that is the point.
  describe('PQ accounts (service layer)', () => {
    const createUser = (accessToken: string, body: Record<string, unknown>) =>
      axios.post(`${APP_BASE_URL}/wallet/user/`, body, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });

    const managerTokens = async () => {
      const vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      return { vaultToken, accessToken: await signInToPawn(vaultToken) };
    };

    it('(OK) Creates a falcon1024 user whose address matches the PQ mount', async () => {
      const { vaultToken, accessToken } = await managerTokens();
      const userId = randomBytes(16).toString('hex');

      const created = await createUser(accessToken, { user_id: userId, account_type: 'falcon1024' });
      expect(created.status).toBe(201);
      expect(created.data.account_type).toBe('falcon1024');
      expect(created.data.algoBalance).toBe('0');

      // The service must report exactly the address the plugin derived —
      // not a second, client-side derivation that could drift from it.
      const fromVault = await axios.get(`${VAULT_BASE_URL}/v1/${VAULT_PQ_USERS_PATH}/keys/${userId}`, {
        headers: { 'X-Vault-Token': vaultToken },
      });
      expect(created.data.public_address).toBe(fromVault.data.data.address);

      // ...and reading the user back resolves to the same account with no
      // hint from the caller about which mount to look in.
      const detail = await axios.get(`${APP_BASE_URL}/wallet/users/${userId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(detail.data.public_address).toBe(created.data.public_address);
      expect(detail.data.account_type).toBe('falcon1024');
    });

    it('(OK) A default create is still ed25519 and unchanged in shape', async () => {
      const { accessToken } = await managerTokens();
      const userId = randomBytes(16).toString('hex');

      const created = await createUser(accessToken, { user_id: userId });
      expect(created.status).toBe(201);
      expect(created.data.account_type).toBe('ed25519');
      expect(created.data.public_address).toHaveLength(58);

      const detail = await axios.get(`${APP_BASE_URL}/wallet/users/${userId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(detail.data.public_address).toBe(created.data.public_address);
      expect(detail.data.account_type).toBe('ed25519');
    });

    it('(OK) Both account types appear in the user listing', async () => {
      const { accessToken } = await managerTokens();
      const edUser = randomBytes(16).toString('hex');
      const pqUser = randomBytes(16).toString('hex');

      const ed = await createUser(accessToken, { user_id: edUser });
      const pq = await createUser(accessToken, { user_id: pqUser, account_type: 'falcon1024' });

      const list = await axios.get(`${APP_BASE_URL}/wallet/users`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      expect(list.data).toEqual(
        expect.arrayContaining([
          { user_id: edUser, public_address: ed.data.public_address, account_type: 'ed25519' },
          { user_id: pqUser, public_address: pq.data.public_address, account_type: 'falcon1024' },
        ]),
      );
      // Every listed address is a real Algorand address, not a base64 key.
      for (const entry of list.data) {
        expect(entry.public_address).toHaveLength(58);
      }
    });

    it('(FAIL) Refuses a user_id that already exists in the other mount', async () => {
      const { accessToken } = await managerTokens();
      const edUser = randomBytes(16).toString('hex');
      const pqUser = randomBytes(16).toString('hex');

      await createUser(accessToken, { user_id: edUser });
      await createUser(accessToken, { user_id: pqUser, account_type: 'falcon1024' });

      // Allowing either of these would leave one user_id resolving to two
      // different addresses depending on probe order.
      await expect(createUser(accessToken, { user_id: edUser, account_type: 'falcon1024' })).rejects.toMatchObject({
        response: { status: 409 },
      });
      await expect(createUser(accessToken, { user_id: pqUser, account_type: 'ed25519' })).rejects.toMatchObject({
        response: { status: 409 },
      });
    });

    it('(FAIL) Rejects an unknown account_type', async () => {
      const { accessToken } = await managerTokens();

      await expect(
        createUser(accessToken, { user_id: randomBytes(16).toString('hex'), account_type: 'dilithium' }),
      ).rejects.toMatchObject({ response: { status: 400 } });
    });
  });

  describe('PQ accounts (on-chain)', () => {
    let vaultToken: string;
    let accessToken: string;
    let managerAddress: string;
    let chain: ChainService;
    let algod: algosdk.Algodv2;

    const post = async (path: string, body: unknown) => {
      try {
        return (
          await axios.post(`${APP_BASE_URL}/${path}`, body, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
        ).data;
      } catch (error) {
        const detail = axios.isAxiosError(error) ? (error.response?.data ?? error.message) : String(error);
        throw new Error(`${path}: ${JSON.stringify(detail)}`);
      }
    };

    const fundedUser = async (accountType: 'ed25519' | 'falcon1024') => {
      const user = await post('wallet/user/', {
        user_id: randomBytes(16).toString('hex'),
        account_type: accountType,
      });
      await post('wallet/transactions/transfer-algo/', {
        fromUserId: 'manager',
        toAddress: user.public_address,
        amount: 1000000,
      });
      return user;
    };

    beforeEach(async () => {
      vaultToken = await loginToVault(MANAGER_ROLE_AND_SECRET);
      accessToken = await signInToPawn(vaultToken);
      managerAddress = await getManagerAddress();
      const config = new ConfigService();
      chain = new ChainService(config, new HttpService());
      algod = new algosdk.Algodv2(
        config.get<string>('NODE_TOKEN'),
        `${config.get<string>('NODE_HTTP_SCHEME')}://${config.get<string>('NODE_HOST')}`,
        config.get<string>('NODE_PORT'),
      );
    });

    it.each(['ed25519', 'falcon1024'] as const)(
      'confirms a %s user payment',
      async (accountType) => {
        const user = await fundedUser(accountType);
        const result = await post('wallet/transactions/transfer-algo/', {
          fromUserId: user.user_id,
          toAddress: managerAddress,
          amount: 10000,
        });
        const pending = await algod.pendingTransactionInformation(result.transaction_id).do();
        expect(pending.confirmedRound).toBeGreaterThan(0n);
        expect(pending.txn.txn.fee).toBe(accountType === 'falcon1024' ? 3000n : 1000n);
        if (accountType === 'falcon1024') {
          expect(algosdk.addressFromPQSig(pending.txn.pqsig!).toString()).toBe(user.public_address);
          expect(pending.txn.pqsig!.sig.length).toBeGreaterThan(1000);
        } else {
          expect(pending.txn.pqsig).toBeUndefined();
          expect(pending.txn.sig).toHaveLength(64);
        }
        expect(await chain.getAccountBalance(user.public_address)).toBe(
          accountType === 'falcon1024' ? 987000n : 989000n,
        );
      },
      60000,
    );

    it('confirms a mixed PQ and ed25519 group', async () => {
      const pq = await fundedUser('falcon1024');
      const ed = await fundedUser('ed25519');
      const result = await post('wallet/transactions/group-transaction/', {
        transactions: [pq, ed].map((user) => ({
          type: 'payment',
          payload: { fromUserId: user.user_id, toAddress: managerAddress, amount: 10000 },
        })),
      });
      const pending = await algod.pendingTransactionInformation(result.group_id).do();
      expect(pending.confirmedRound).toBeGreaterThan(0n);
      expect(pending.txn.txn.group).toBeDefined();
      expect(pending.txn.pqsig).toBeDefined();
      expect(await chain.getAccountBalance(pq.public_address)).toBe(987000n);
      expect(await chain.getAccountBalance(ed.public_address)).toBe(989000n);
    }, 60000);

    it('confirms a PQ-signed payment and app-call group', async () => {
      const user = await fundedUser('falcon1024');
      const program = await algod.compile('#pragma version 8\nint 1').do();
      const created = await post('wallet/transactions/app-call/', {
        fromUserId: 'manager',
        approvalProgram: program.result,
        clearProgram: program.result,
      });
      const application = await algod.pendingTransactionInformation(created.transaction_id).do();

      const result = await post('wallet/transactions/group-transaction/', {
        transactions: [
          {
            type: 'payment',
            payload: { fromUserId: user.user_id, toAddress: managerAddress, amount: 10000 },
          },
          {
            type: 'appCall',
            payload: {
              fromUserId: user.user_id,
              appId: Number(application.applicationIndex),
              fee: 5000,
            },
          },
        ],
      });

      const pending = await algod.pendingTransactionInformation(result.group_id).do();
      expect(pending.confirmedRound).toBeGreaterThan(0n);
      expect(pending.txn.txn.group).toBeDefined();
      expect(pending.txn.txn.payment!.amount).toBe(10000n);
      expect(pending.txn.txn.fee).toBe(3000n);
      expect(algosdk.addressFromPQSig(pending.txn.pqsig!).toString()).toBe(user.public_address);
      expect(await chain.getAccountBalance(user.public_address)).toBe(980000n);
    }, 60000);

    it('verifies the PQ minimum fee with empty-signature simulation', async () => {
      const user = await fundedUser('falcon1024');
      const key = (
        await axios.get(`${VAULT_BASE_URL}/v1/${VAULT_PQ_USERS_PATH}/keys/${user.user_id}`, {
          headers: { 'X-Vault-Token': vaultToken },
        })
      ).data.data;
      const pqSigner = jest.fn(async () => {
        throw new Error('Simulation must not sign');
      });
      const signer = algosdk.addressWithSignersFromRawPQSigner({
        pqScheme: Buffer.from(key.scheme),
        pqPublicKey: Buffer.from(key.public_key, 'base64'),
        pqSigner,
      });
      const unsigned = await chain.craftPaymentTx(user.public_address, managerAddress, 0);
      const simulate = async (fee: bigint) => {
        const txn = algosdk.decodeUnsignedTransaction(unsigned.slice(2));
        txn.fee = fee;
        const [empty] = await signer.emptyTxnSigner([txn], [0]);
        try {
          const response = await algod
            .simulateTransactions(
              new algosdk.modelsv2.SimulateRequest({
                allowEmptySignatures: true,
                txnGroups: [
                  new algosdk.modelsv2.SimulateRequestTransactionGroup({
                    txns: [algosdk.decodeSignedTransaction(empty)],
                  }),
                ],
              }),
            )
            .do();
          return response.txnGroups[0].failureMessage ?? '';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      expect(await simulate(2999n)).toMatch(/fee/i);
      expect(await simulate(3000n)).toBe('');
      expect(pqSigner).not.toHaveBeenCalled();
    }, 60000);

    it('prefunds and confirms an asset opt-in for an unfunded PQ user', async () => {
      const user = await post('wallet/user/', {
        user_id: randomBytes(16).toString('hex'),
        account_type: 'falcon1024',
      });
      const created = await post('wallet/transactions/create-asset/', {
        total: 100,
        decimals: 0,
        defaultFrozen: false,
        unitName: 'PQ',
        assetName: 'PQ opt-in test',
        url: 'https://example.com',
      });
      const asset = await algod.pendingTransactionInformation(created.transaction_id).do();
      const result = await post('wallet/transactions/transfer-asset/', {
        assetId: Number(asset.assetIndex),
        userId: user.user_id,
        amount: 10,
      });
      const funding = await algod.pendingTransactionInformation(result.transaction_id).do();
      expect(funding.txn.txn.payment!.amount).toBe(203000n);
      const account = await algod.accountInformation(user.public_address).do();
      expect(account.amount).toBe(200000n);
      expect(account.assets).toEqual(
        expect.arrayContaining([expect.objectContaining({ assetId: asset.assetIndex, amount: 10n })]),
      );
    }, 60000);

    it('returns asset holdings for a PQ user through the public route', async () => {
      const user = await post('wallet/user/', {
        user_id: randomBytes(16).toString('hex'),
        account_type: 'falcon1024',
      });
      const created = await post('wallet/transactions/create-asset/', {
        total: 100,
        decimals: 0,
        defaultFrozen: false,
        unitName: 'PQH',
        assetName: 'PQ holdings test',
        url: 'https://example.com',
      });
      const asset = await algod.pendingTransactionInformation(created.transaction_id).do();
      await post('wallet/transactions/transfer-asset/', {
        assetId: Number(asset.assetIndex),
        userId: user.user_id,
        amount: 7,
      });

      const holdings = await axios.get(`${APP_BASE_URL}/wallet/assets/${user.user_id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(holdings.status).toBe(200);
      expect(holdings.data.address).toBe(user.public_address);
      expect(holdings.data.assets).toEqual(
        expect.arrayContaining([expect.objectContaining({ 'asset-id': Number(asset.assetIndex), amount: 7 })]),
      );
    }, 60000);

    it('claws back an asset from a PQ user and returns the updated holdings', async () => {
      const user = await post('wallet/user/', {
        user_id: randomBytes(16).toString('hex'),
        account_type: 'falcon1024',
      });
      const created = await post('wallet/transactions/create-asset/', {
        total: 100,
        decimals: 0,
        defaultFrozen: false,
        unitName: 'PQC',
        assetName: 'PQ clawback test',
        url: 'https://example.com',
        clawbackAddress: managerAddress,
      });
      const asset = await algod.pendingTransactionInformation(created.transaction_id).do();

      await post('wallet/transactions/transfer-asset/', {
        assetId: Number(asset.assetIndex),
        userId: user.user_id,
        amount: 10,
      });
      const result = await post('wallet/transactions/clawback-asset/', {
        assetId: Number(asset.assetIndex),
        userId: user.user_id,
        amount: 4,
      });

      const pending = await algod.pendingTransactionInformation(result.transaction_id).do();
      expect(pending.confirmedRound).toBeGreaterThan(0n);
      expect(pending.txn.txn.sender.toString()).toBe(managerAddress);
      expect(pending.txn.txn.assetTransfer!.assetSender!.toString()).toBe(user.public_address);
      expect(pending.txn.txn.assetTransfer!.receiver.toString()).toBe(managerAddress);
      expect(pending.txn.txn.assetTransfer!.amount).toBe(4n);
      expect(pending.txn.pqsig).toBeUndefined();

      const holdings = await axios.get(`${APP_BASE_URL}/wallet/assets/${user.user_id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(holdings.status).toBe(200);
      expect(holdings.data.address).toBe(user.public_address);
      expect(holdings.data.assets).toEqual(
        expect.arrayContaining([expect.objectContaining({ 'asset-id': Number(asset.assetIndex), amount: 6 })]),
      );
    }, 60000);

    it('confirms a PQ app call with an explicit fee', async () => {
      const user = await fundedUser('falcon1024');
      const program = await algod.compile('#pragma version 8\nint 1').do();
      const created = await post('wallet/transactions/app-call/', {
        fromUserId: 'manager',
        approvalProgram: program.result,
        clearProgram: program.result,
      });
      const application = await algod.pendingTransactionInformation(created.transaction_id).do();
      const result = await post('wallet/transactions/app-call/', {
        fromUserId: user.user_id,
        appId: Number(application.applicationIndex),
        fee: 5000,
      });
      const pending = await algod.pendingTransactionInformation(result.transaction_id).do();
      expect(pending.confirmedRound).toBeGreaterThan(0n);
      expect(pending.txn.txn.fee).toBe(7000n);
      expect(algosdk.addressFromPQSig(pending.txn.pqsig!).toString()).toBe(user.public_address);
    }, 60000);

    it('confirms a PQ app call with ABI arguments', async () => {
      const user = await fundedUser('falcon1024');
      const program = await algod.compile('#pragma version 8\nint 1').do();
      const created = await post('wallet/transactions/app-call/', {
        fromUserId: 'manager',
        approvalProgram: program.result,
        clearProgram: program.result,
      });
      const application = await algod.pendingTransactionInformation(created.transaction_id).do();

      const result = await post('wallet/transactions/app-call/', {
        fromUserId: user.user_id,
        appId: Number(application.applicationIndex),
        args: {
          name: 'pq_args',
          args: [
            { type: 'string', value: 'falcon' },
            { type: 'uint64', value: 42 },
          ],
          returns: { type: 'void' },
        },
      });

      const pending = await algod.pendingTransactionInformation(result.transaction_id).do();
      const appArgs = pending.txn.txn.applicationCall!.appArgs;
      expect(pending.confirmedRound).toBeGreaterThan(0n);
      expect(appArgs).toHaveLength(3);
      expect(Buffer.from(appArgs[1]).subarray(2).toString()).toBe('falcon');
      expect(Buffer.from(appArgs[2]).readBigUInt64BE()).toBe(42n);
      expect(algosdk.addressFromPQSig(pending.txn.pqsig!).toString()).toBe(user.public_address);
    }, 60000);

    it('confirms the maximum 16-payment PQ group', async () => {
      const user = await fundedUser('falcon1024');
      const transactions = Array.from({ length: 16 }, (_, index) => ({
        type: 'payment',
        payload: { fromUserId: user.user_id, toAddress: managerAddress, amount: index + 1 },
      }));
      const result = await post('wallet/transactions/group-transaction/', { transactions });
      const pending = await algod.pendingTransactionInformation(result.group_id).do();
      expect(pending.confirmedRound).toBeGreaterThan(0n);
      expect(pending.txn.pqsig).toBeDefined();
      expect(algosdk.encodeMsgpack(pending.txn).length).toBeGreaterThan(3000);
      expect(await chain.getAccountBalance(user.public_address)).toBe(1000000n - 48000n - 136n);
    }, 60000);
  });
});

import { ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { VaultService } from '../vault/vault.service';
import { AccountType } from '../vault/user-info.dto';
import { ChainService } from '../chain/chain.service';
import { DidService } from '../did/did.service';
import { CreateAssetDto } from './create-asset.dto';
import { UserInfoResponseDto } from './user-info-response.dto';
import { ConfigService } from '@nestjs/config';
import { ManagerDetailDto } from './manager-detail.dto';
import { ManagerIdentityDto, DeployManagerIdentityResponseDto } from './manager-identity.dto';
import { Oid4vcAgentProvider } from '../oid4vc/agent/oid4vc-agent.provider';
import { plainToClass } from 'class-transformer';
import { AssetHolding } from 'src/chain/algo-node-responses';
import { Address } from '@algorandfoundation/algokit-utils';
import { decodeTransaction } from '@algorandfoundation/algokit-utils/transact';
import { AppCallRequestDto } from './app-call-request.dto';
import { GroupRequestDto } from './group-request.dto';

/**
 * A user's account as resolved from Vault: which scheme backs it, its
 * address, and the key material a signer needs.
 *
 * The PQ variant carries `salt` and `scheme` because the `pqsig`
 * envelope has to reproduce them — they are not recoverable from the
 * address alone.
 */
export type UserAccount =
  | { type: 'ed25519'; userId: string; address: string; publicKey: Buffer }
  | { type: 'falcon1024'; userId: string; address: string; publicKey: Buffer; salt: number; scheme: string };

@Injectable()
export class WalletService {
  constructor(
    private readonly vaultService: VaultService,
    private readonly chainService: ChainService,
    private readonly configService: ConfigService,
    private readonly didService: DidService,
    private readonly oid4vcAgentProvider: Oid4vcAgentProvider,
  ) {}

  async getManagerIdentity(): Promise<ManagerIdentityDto> {
    await this.didService.ensureAppIdLoaded();
    if (!this.didService.hasAppId()) {
      throw new NotFoundException(
        'Manager identity is not deployed. Call `POST /v1/wallet/manager/identity` ' +
          'with the manager Vault JWT to deploy a `DIDAlgoStorage` contract and ' +
          'provision the issuer `did:algo`.',
      );
    }
    const issuer = await this.oid4vcAgentProvider.ensureIssuerDid();
    const agent = await this.oid4vcAgentProvider.getAgent();
    const resolved = await agent.dids.resolve(issuer.did);
    if (!resolved.didDocument) {
      throw new Error(
        `WalletService.getManagerIdentity: did:algo "${issuer.did}" resolved with no DID Document ` +
          `(error=${resolved.didResolutionMetadata?.error ?? 'unknown'}).`,
      );
    }
    const appId = this.didService.getAppIdIfDeployed()!;
    const appAddress = this.didService.getAppAddress();
    const appBalance = await this.chainService.getAccountBalance(appAddress);
    return plainToClass(ManagerIdentityDto, {
      deployed: true,
      did: issuer.did,
      verificationMethodId: issuer.verificationMethodId,
      didDocument: resolved.didDocument.toJSON() as Record<string, unknown>,
      appId: appId.toString(),
      appAddress,
      appBalance: appBalance.toString(),
    });
  }

  async deployManagerIdentity(
    vaultToken: string,
    options: { force?: boolean } = {},
  ): Promise<DeployManagerIdentityResponseDto> {
    let deployment: Awaited<ReturnType<DidService['deployStorage']>>;
    try {
      deployment = await this.didService.deployStorage(vaultToken, { force: options.force });
    } catch (error) {
      // `algokit-utils` surfaces an unfunded-sender failure as a
      // generic `Error` whose message embeds algod's simulate output,
      // e.g. `... overspend (account ABC..., tried to spend {1000})`.
      // Surface it as a clear 422 so the operator knows the next
      // action is to fund the manager account rather than retry or
      // file a bug.
      const message = (error as Error)?.message ?? '';
      if (/overspend/i.test(message)) {
        Logger.warn(`deployManagerIdentity: manager account is underfunded — ${message}`);
        throw new UnprocessableEntityException(
          'Manager account is underfunded and cannot pay for the DIDAlgoStorage contract deployment. ' +
            'Fund the manager Algorand account and retry `POST /v1/wallet/manager/identity`.',
        );
      }
      throw error;
    }
    // Reset the cached issuer DID so `ensureIssuerDid` re-provisions
    // against the new contract on the next call.
    this.oid4vcAgentProvider.resetCachedIssuerDid();
    const issuer = await this.oid4vcAgentProvider.ensureIssuerDid();
    const agent = await this.oid4vcAgentProvider.getAgent();
    const resolved = await agent.dids.resolve(issuer.did);
    if (!resolved.didDocument) {
      throw new Error(
        `WalletService.deployManagerIdentity: did:algo "${issuer.did}" resolved with no DID Document ` +
          `(error=${resolved.didResolutionMetadata?.error ?? 'unknown'}).`,
      );
    }
    const appBalance = await this.chainService.getAccountBalance(deployment.appAddress);
    return plainToClass(DeployManagerIdentityResponseDto, {
      deployed: true,
      did: issuer.did,
      verificationMethodId: issuer.verificationMethodId,
      didDocument: resolved.didDocument.toJSON() as Record<string, unknown>,
      appId: deployment.appId.toString(),
      appAddress: deployment.appAddress,
      appBalance: appBalance.toString(),
      operation: deployment.operation,
      deleteTxIds: deployment.deleteTxIds,
      uploadTxIds: deployment.uploadTxIds,
      skipped: deployment.skipped,
      oldMbrMicroAlgos: deployment.oldMbrMicroAlgos,
      newMbrMicroAlgos: deployment.newMbrMicroAlgos,
    });
  }

  /**
   * Read a user's ed25519 account from the transit mount, or
   * `undefined` when the mount does not hold that `user_id`.
   *
   * A miss is a normal answer here — it is how both the account-type
   * probe and the cross-mount conflict check learn that a `user_id`
   * is not an ed25519 account.
   */
  private async getTransitAccount(user_id: string, vault_token: string): Promise<UserAccount | undefined> {
    try {
      const publicKey: Buffer = await this.vaultService.getUserPublicKey(user_id, vault_token);
      return { type: 'ed25519', userId: user_id, address: new Address(publicKey).toString(), publicKey };
    } catch (error) {
      if (error?.getStatus?.() === 404) return undefined;
      throw error;
    }
  }

  /**
   * Resolve which kind of account a `user_id` has, and its address.
   *
   * The two Vault mounts are the source of truth: a `user_id` exists
   * in exactly one of them, so nothing records the account type
   * separately and nothing can drift. Transit is probed first, which
   * means every account that exists today resolves in exactly the
   * request it takes now — only PQ accounts pay for the miss.
   */
  async resolveUserAccount(user_id: string, vault_token: string): Promise<UserAccount> {
    const ed25519 = await this.getTransitAccount(user_id, vault_token);
    if (ed25519) return ed25519;

    const pq = await this.vaultService.pqGetKey(user_id, vault_token);
    if (!pq) throw new NotFoundException(`No account found for user ${user_id}`);

    return {
      type: 'falcon1024',
      userId: user_id,
      address: pq.address,
      publicKey: pq.publicKey,
      salt: pq.salt,
      scheme: pq.scheme,
    };
  }

  async getUserInfo(user_id: string, vault_token: string): Promise<UserInfoResponseDto> {
    const account: UserAccount = await this.resolveUserAccount(user_id, vault_token);

    // get algo balance
    const algoBalance: bigint = await this.chainService.getAccountBalance(account.address);
    Logger.debug(`User ${user_id} Algo Balance: ${algoBalance}`);

    return {
      user_id,
      public_address: account.address,
      algoBalance: algoBalance.toString(),
      account_type: account.type,
    };
  }

  async getManagerInfo(vault_token: string): Promise<ManagerDetailDto> {
    const public_address = await this.vaultService.getManagerPublicKey(vault_token);
    // asset holdings
    const account: AssetHolding[] = await this.chainService.getAccountAssetHoldings(
      new Address(public_address).toString(),
    );

    // Log debug with stringify
    Logger.debug(`Manager account details: ${JSON.stringify(account)}`);

    // Get Algo Balance
    const algoBalance: bigint = await this.chainService.getAccountBalance(new Address(public_address).toString());
    Logger.debug(`Manager Algo Balance: ${algoBalance}`);

    return plainToClass(ManagerDetailDto, {
      public_address: new Address(public_address).toString(),
      assets: account,
      algoBalance: algoBalance.toString(),
    });
  }

  // Create new user and key
  async userCreate(
    user_id: string,
    vault_token: string,
    account_type: AccountType = 'ed25519',
  ): Promise<UserInfoResponseDto> {
    // A `user_id` present in both mounts would resolve to a different
    // address depending on probe order — i.e. funds sent to whichever
    // account the resolver happened to find. Refuse to create the
    // collision rather than pick a winner.
    const existing =
      account_type === 'falcon1024'
        ? await this.getTransitAccount(user_id, vault_token)
        : await this.vaultService.pqGetKey(user_id, vault_token);
    if (existing) {
      throw new ConflictException(
        `User ${user_id} already exists as a ${account_type === 'falcon1024' ? 'ed25519' : 'falcon1024'} account. ` +
          'Account type is fixed at creation time — the two schemes derive different addresses.',
      );
    }

    if (account_type === 'falcon1024') {
      // The plugin is the authority on the address: it owns the salt
      // scan the digest depends on, so re-deriving it here would only
      // create a second implementation to keep in step.
      const key = await this.vaultService.pqCreateKey(user_id, vault_token);
      return { user_id, public_address: key.address, algoBalance: '0', account_type };
    }

    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');

    const public_key: Buffer = await this.vaultService.transitCreateKey(user_id, transitKeyPath, vault_token);
    const public_address: string = new Address(public_key).toString();
    return { user_id, public_address, algoBalance: '0', account_type: 'ed25519' }; // Initial balance is set to 0
  }

  // Get all users
  async getKeys(vault_token: string): Promise<UserInfoResponseDto[]> {
    // `VaultService.getKeys` merges both mounts and already returns
    // real addresses, so there is nothing left to convert here.
    return (await this.vaultService.getKeys(vault_token)) as UserInfoResponseDto[];
  }
  /**
   *
   * Fetches the asset balance for a user by their user ID and vault token.
   * @param user_id - The ID of the user whose asset balance is to be fetched.
   * @param vault_token - The token used to authenticate with the vault.
   * @returns An array of AssetHolding objects representing the user's asset balance.
   * @throws Will throw an error if the user is not found or if there is an issue with the vault token.
   */
  async getAssetHoldings(user_id: string, vault_token: string): Promise<AssetHolding[]> {
    const userPublicAddress: string = (await this.getUserInfo(user_id, vault_token)).public_address;

    // log
    Logger.debug(`Fetching asset balance for user: ${user_id} with address: ${userPublicAddress}`);

    const account: AssetHolding[] = await this.chainService.getAccountAssetHoldings(userPublicAddress);
    return account;
  }

  /**
   * Signs a transaction as a user and adds the signature to the transaction.
   *
   * @param user_id The ID of the user signing the transaction.
   * @param tx The transaction to be signed, as a Uint8Array.
   * @param vault_token The token used to authenticate with the vault.
   * @returns The signed transaction, as a Uint8Array.
   */
  async signTxAsUser(
    user_id: string,
    tx: Uint8Array<ArrayBufferLike>,
    vault_token: string,
  ): Promise<Uint8Array<ArrayBufferLike>> {
    const vaultRawSig: Buffer = await this.vaultService.signAsUser(user_id, tx, vault_token);
    // split vault specific prefixes vault:${version}:signature
    const signature = vaultRawSig.toString().split(':')[2];
    // vault default base64 decode
    const decoded: Buffer = Buffer.from(signature, 'base64');
    // return as Uint8Array
    const sig: Uint8Array = new Uint8Array(decoded);

    const signedTx: Uint8Array<ArrayBufferLike> = this.chainService.addSignatureToTxn(tx, sig);
    return signedTx;
  }

  /**
   * Signs a transaction as a manager and adds the signature to the transaction.
   *
   * @param tx The transaction to be signed, as a Uint8Array.
   * @param vault_token The token used to authenticate with the vault.
   * @returns The signed transaction, as a Uint8Array.
   */
  async signTxAsManager(tx: Uint8Array<ArrayBufferLike>, vault_token: string): Promise<Uint8Array<ArrayBufferLike>> {
    const vaultRawSig: Buffer = await this.vaultService.signAsManager(tx, vault_token);
    // split vault specific prefixes vault:${version}:signature
    const signature = vaultRawSig.toString().split(':')[2];
    // vault default base64 decode
    const decoded: Buffer = Buffer.from(signature, 'base64');
    // return as Uint8Array
    const sig: Uint8Array = new Uint8Array(decoded);
    const signedTx: Uint8Array<ArrayBufferLike> = this.chainService.addSignatureToTxn(tx, sig);
    return signedTx;
  }

  async createAsset(options: CreateAssetDto, vault_token: string) {
    const managerPublicKey: Buffer = await this.vaultService.getManagerPublicKey(vault_token);
    const managerPublicAddress: string = new Address(managerPublicKey).toString();
    const tx: Uint8Array<ArrayBufferLike> = await this.chainService.craftAssetCreateTx(managerPublicAddress, options);
    const signedTx: Uint8Array<ArrayBufferLike> = await this.signTxAsManager(tx, vault_token);
    const transactionId: string = (await this.chainService.submitTransaction(signedTx)).txid;

    return transactionId;
  }

  /**
   *
   * Transfers Algos from one user to another.
   *
   * @param vault_token The token used to authenticate with the vault.
   * @param fromUserId The ID of the user sending the asset.
   * @param toAddress The address of the user receiving the asset.
   * @param amount The amount of the asset to be transferred.
   */
  async transferAlgoToAddress(
    vault_token: string,
    fromUserId: string,
    toAddress: string,
    amount: number,
  ): Promise<string> {
    let signedTx: Uint8Array;
    let fromAddress: string;

    try {
      if (fromUserId === 'manager') {
        const managerPublicKey: Buffer = await this.vaultService.getManagerPublicKey(vault_token);
        fromAddress = new Address(managerPublicKey).toString();
      } else {
        fromAddress = (await this.getUserInfo(fromUserId, vault_token)).public_address;
      }
    } catch (error) {
      throw new Error(`Failed to get from address for user ${fromUserId}: ${error.message}`);
    }

    Logger.debug(`Transferring ${amount} Algos from ${fromUserId} (${fromAddress}) to ${toAddress}`);
    // craft algorand pay transaction
    const payTx: Uint8Array = await this.chainService.craftPaymentTx(
      fromAddress,
      toAddress,
      amount,
      await this.chainService.getSuggestedParams(),
    );

    try {
      if (fromUserId === 'manager') {
        Logger.debug(`Signing transaction as manager: ${payTx.toString()}`);
        // sign as manager
        signedTx = await this.signTxAsManager(payTx, vault_token);
      } else {
        // sign as user
        signedTx = await this.signTxAsUser(fromUserId, payTx, vault_token);
      }

      // submit transaction
      return (await this.chainService.submitTransaction(signedTx)).txid;
    } catch (error) {
      throw new Error(`Failed to sign transaction as user ${fromUserId}: ${error.message}`);
    }
  }

  /**
   * Transfers an asset from the manager to a user.
   *
   * The function first checks if the user has opted in for the asset. If not, an opt-in transaction is created.
   * It then checks if the user has enough Algo balance to cover the minimum balance after the transactions.
   * If not, a payment transaction is created to cover the difference.
   * The function then crafts the necessary transactions, groups them, signs them, and submits them to the blockchain.
   *
   * @param assetId The ID of the asset to be transferred.
   * @param userId The ID of the user receiving the asset.
   * @param amount The amount of the asset to be transferred.
   * @param lease An optional 32 byte lease encoded as base64.
   * @param note An optional transaction note.
   * @param vault_token The token used to authenticate with the vault.
   * @returns The transaction ID of the submitted transaction.
   */
  async transferAsset(
    vault_token: string,
    assetId: bigint,
    userId: string,
    amount: number,
    lease?: string,
    note?: string,
  ) {
    const userPublicAddress: string = (await this.getUserInfo(userId, vault_token)).public_address;
    const managerPublicKey: Buffer = await this.vaultService.getManagerPublicKey(vault_token);
    const managerPublicAddress: string = new Address(managerPublicKey).toString();

    const suggested_params = await this.chainService.getSuggestedParams();

    // check if user opted in for the asset

    let willOptInTx: boolean = false;
    const account_asset = await this.chainService.getAccountAsset(userPublicAddress, assetId);
    if (account_asset == null) {
      willOptInTx = true;
    }

    // check if user has enough algo balance to cover min balance after transactions

    let willPaymentTx: boolean = false;
    let userExtraAlgoNeed: number = 0;
    if (willOptInTx) {
      userExtraAlgoNeed += 100000; // opt-in min balance
      userExtraAlgoNeed += Number(suggested_params.minFee); // opt-in tx fee
    }
    // owned amount can be negative if user has no algo at all
    const userAccountDetail = await this.chainService.getAccountDetail(userPublicAddress);
    const userOwnedExtraAlgo: bigint = userAccountDetail.amount - userAccountDetail.minBalance;
    if (userOwnedExtraAlgo < userExtraAlgoNeed) {
      willPaymentTx = true;
      userExtraAlgoNeed -= Number(userOwnedExtraAlgo);
    }

    // build unsigned txs

    const unSignedTxs: Uint8Array[] = [];
    if (willPaymentTx) {
      unSignedTxs.push(
        await this.chainService.craftPaymentTx(
          managerPublicAddress,
          userPublicAddress,
          userExtraAlgoNeed,
          suggested_params,
        ),
      );
    }
    if (willOptInTx) {
      unSignedTxs.push(
        await this.chainService.craftAssetTransferTx(
          userPublicAddress,
          userPublicAddress,
          assetId,
          0,
          lease,
          undefined,
          suggested_params,
        ),
      );
    }
    unSignedTxs.push(
      await this.chainService.craftAssetTransferTx(
        managerPublicAddress,
        userPublicAddress,
        assetId,
        amount,
        lease,
        note,
        suggested_params,
      ),
    );

    // group them

    const unSignedGroupedTxns: Uint8Array<ArrayBufferLike>[] = this.chainService.setGroupID(unSignedTxs);

    // sign txs by sender

    const signedTxs: Uint8Array[] = [];
    for (const tx of unSignedGroupedTxns) {
      const senderAddress: string = decodeTransaction(tx).sender.toString();
      const isUserTx: boolean = senderAddress == userPublicAddress;
      const isManagerTx: boolean = senderAddress == managerPublicAddress;

      if (isUserTx) {
        signedTxs.push(await this.signTxAsUser(userId, tx, vault_token));
      } else if (isManagerTx) {
        signedTxs.push(await this.signTxAsManager(tx, vault_token));
      } else {
        throw new Error('Invalid sender');
      }
    }

    return (await this.chainService.submitTransaction(signedTxs)).txid;
  }

  /**
   * Claws back an asset from a user to the manager account.
   *
   * The function crafts the necessary transaction, signs it, and submits it to the blockchain.
   *
   * @param assetId The ID of the asset to be clawed back.
   * @param userId The ID of the user to claw back from.
   * @param amount The amount of the asset to be clawed back.
   * @param lease An optional 32 byte lease encoded as base64.
   * @param note An optional transaction note.
   * @param vault_token The token used to authenticate with the vault.
   *
   * @returns The transaction ID of the submitted transaction.
   */

  async clawbackAsset(
    vault_token: string,
    assetId: bigint,
    userId: string,
    amount: number,
    lease?: string,
    note?: string,
  ) {
    const userPublicAddress: string = (await this.getUserInfo(userId, vault_token)).public_address;
    const managerPublicKey: Buffer = await this.vaultService.getManagerPublicKey(vault_token);
    const managerPublicAddress: string = new Address(managerPublicKey).toString();

    const suggested_params = await this.chainService.getSuggestedParams();

    // build unsigned tx
    const tx: Uint8Array<ArrayBufferLike> = await this.chainService.craftAssetClawbackTx(
      managerPublicAddress,
      userPublicAddress,
      managerPublicAddress,
      assetId,
      amount,
      lease,
      note,
      suggested_params,
    );

    // sign tx by manager

    const signedTx: Uint8Array<ArrayBufferLike> = await this.signTxAsManager(tx, vault_token);
    const transactionId: string = (await this.chainService.submitTransaction(signedTx)).txid;

    return transactionId;
  }

  /**
   * Crafts and submits an application call transaction.
   *
   * @param vault_token The token used to authenticate with the vault.
   * @param appCallRequestDto The request object containing the application call details.
   *
   * @returns The transaction ID of the submitted transaction.
   */

  async appCall(vault_token: string, appCallRequestDto: AppCallRequestDto) {
    let signedTx: Uint8Array;
    let fromAddress: string;

    try {
      if (appCallRequestDto.fromUserId === 'manager') {
        const managerPublicKey: Buffer = await this.vaultService.getManagerPublicKey(vault_token);
        fromAddress = new Address(managerPublicKey).toString();
      } else {
        fromAddress = (await this.getUserInfo(appCallRequestDto.fromUserId, vault_token)).public_address;
      }
    } catch (error) {
      throw new Error(`Failed to get from address for user ${appCallRequestDto.fromUserId}: ${error.message}`);
    }

    const suggested_params = await this.chainService.getSuggestedParams();

    const appTx: Uint8Array<ArrayBufferLike> = await this.chainService.craftAppCallTx(
      fromAddress,
      appCallRequestDto,
      suggested_params,
      appCallRequestDto.fee,
    );

    try {
      if (appCallRequestDto.fromUserId === 'manager') {
        Logger.debug(`Signing transaction as manager: ${appTx.toString()}`);
        // sign as manager
        signedTx = await this.signTxAsManager(appTx, vault_token);
      } else {
        // sign as user
        signedTx = await this.signTxAsUser(appCallRequestDto.fromUserId, appTx, vault_token);
      }

      // submit transaction
      return (await this.chainService.submitTransaction(signedTx)).txid;
    } catch (error) {
      throw new Error(`Failed to sign transaction as user ${appCallRequestDto.fromUserId}: ${error.message}`);
    }
  }

  /**
   * Crafts and submits a group transaction.
   *
   * @param vault_token The token used to authenticate with the vault.
   * @param groupRequestDto The request object containing the group transaction details.
   *
   * @returns The group transaction ID (the txid of the first transaction in the submitted group).
   */
  async groupTransaction(vault_token: string, groupRequestDto: GroupRequestDto) {
    const managerPublicKey: Buffer = await this.vaultService.getManagerPublicKey(vault_token);
    const managerPublicAddress: string = new Address(managerPublicKey).toString();

    const suggested_params = await this.chainService.getSuggestedParams();

    Logger.debug(`Group Request DTO: ${groupRequestDto}`);

    if (!Array.isArray((groupRequestDto as any).transactions) || groupRequestDto.transactions.length === 0) {
      throw new Error('transactions is required and must be a non-empty array');
    }

    const unSignedTxs: Uint8Array[] = [];
    const addressToUserId: Record<string, string> = {};

    for (const step of groupRequestDto.transactions) {
      const key = (step as any).type as string;
      const value = (step as any).payload;
      if (!key || !value) {
        throw new Error('Invalid transaction step');
      }

      switch (key) {
        case 'appCall': {
          let fromAddress: string;
          if (value.fromUserId === 'manager') {
            fromAddress = managerPublicAddress;
          } else {
            fromAddress = (await this.getUserInfo(value.fromUserId, vault_token)).public_address;
            addressToUserId[fromAddress] = value.fromUserId;
          }

          const tx = await this.chainService.craftAppCallTx(fromAddress, value, suggested_params, value.fee);
          unSignedTxs.push(tx);
          break;
        }
        case 'assetConfig': {
          const tx = await this.chainService.craftAssetCreateTx(managerPublicAddress, value);
          unSignedTxs.push(tx);
          break;
        }
        case 'assetTransfer': {
          const userPublicAddress: string = (await this.getUserInfo(value.userId, vault_token)).public_address;
          const tx = await this.chainService.craftAssetTransferTx(
            managerPublicAddress,
            userPublicAddress,
            value.assetId,
            value.amount,
            value.lease,
            value.note,
            suggested_params,
          );
          unSignedTxs.push(tx);
          break;
        }
        case 'payment': {
          let fromAddress: string;
          if (value.fromUserId === 'manager') {
            fromAddress = managerPublicAddress;
          } else {
            fromAddress = (await this.getUserInfo(value.fromUserId, vault_token)).public_address;
            addressToUserId[fromAddress] = value.fromUserId;
          }

          const tx = await this.chainService.craftPaymentTx(
            fromAddress,
            value.toAddress,
            value.amount,
            suggested_params,
          );
          unSignedTxs.push(tx);
          break;
        }
        case 'assetClawback': {
          const userPublicAddress: string = (await this.getUserInfo(value.userId, vault_token)).public_address;
          const tx = await this.chainService.craftAssetClawbackTx(
            managerPublicAddress,
            userPublicAddress,
            managerPublicAddress,
            value.assetId,
            value.amount,
            value.lease,
            value.note,
            suggested_params,
          );
          unSignedTxs.push(tx);
          break;
        }
        default:
          throw new Error(`Unsupported transaction type: ${key}`);
      }
    }

    if (unSignedTxs.length === 0) {
      throw new Error('No transactions to group');
    }

    const groupedTxns: Uint8Array[] = this.chainService.setGroupID(unSignedTxs);

    const signedTxs: Uint8Array[] = [];
    for (const tx of groupedTxns) {
      const sender = decodeTransaction(tx).sender.toString();
      if (sender === managerPublicAddress) {
        signedTxs.push(await this.signTxAsManager(tx, vault_token));
      } else if (addressToUserId[sender]) {
        signedTxs.push(await this.signTxAsUser(addressToUserId[sender], tx, vault_token));
      } else {
        throw new Error('Invalid sender');
      }
    }

    const txid = (await this.chainService.submitTransaction(signedTxs)).txid;

    return txid;
  }
}

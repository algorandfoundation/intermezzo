import { Injectable } from '@nestjs/common';
import { VaultService } from '../vault/vault.service';
import { ChainService } from '../chain/chain.service';
import { CreateAssetDto } from './create-asset.dto';
import { UserInfoResponseDto } from './user-info-response.dto';
import { ConfigService } from '@nestjs/config';
import { AlgorandEncoder } from '@algorandfoundation/algo-models';
import { ManagerDetailDto } from './manager-detail.dto';
import { plainToClass } from 'class-transformer';

@Injectable()
export class WalletService {
  constructor(
    private readonly vaultService: VaultService,
    private readonly chainService: ChainService,
    private readonly configService: ConfigService,
  ) {}

  async getUserInfo(user_id: string, vault_token: string): Promise<UserInfoResponseDto> {
    const public_address = await this.vaultService.getUserPublicAddress(user_id, vault_token);
    return { user_id, public_address };
  }

  async getMangerInfo(vault_token: string): Promise<ManagerDetailDto> {
    const public_address = await this.vaultService.getManagerPublicAddress(vault_token);
    return plainToClass(ManagerDetailDto, { public_address });
  }

  // Create new user and key
  async userCreate(user_id: string, vault_token: string): Promise<UserInfoResponseDto> {
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');

    const public_address: string = await this.vaultService.transitCreateKey(user_id, transitKeyPath, vault_token);
    return { user_id, public_address };
  }

  // Get all users
  async getKeys(vault_token: string): Promise<UserInfoResponseDto[]> {
    return (await this.vaultService.getKeys(vault_token)) as UserInfoResponseDto[];
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
    const signature: Uint8Array<ArrayBufferLike> = await this.vaultService.signAsUser(user_id, tx, vault_token);
    const signedTx: Uint8Array<ArrayBufferLike> = this.chainService.addSignatureToTxn(tx, signature);
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
    const signature: Uint8Array<ArrayBufferLike> = await this.vaultService.signAsManager(tx, vault_token);
    const signedTx: Uint8Array<ArrayBufferLike> = this.chainService.addSignatureToTxn(tx, signature);
    return signedTx;
  }

  async createAsset(options: CreateAssetDto, vault_token: string) {
    const managerPublicAddress: string = await this.vaultService.getManagerPublicAddress(vault_token);
    const tx: Uint8Array<ArrayBufferLike> = await this.chainService.craftAssetCreateTx(managerPublicAddress, options);
    const signedTx: Uint8Array<ArrayBufferLike> = await this.signTxAsManager(tx, vault_token);
    const transactionId: string = (await this.chainService.submitTransaction(signedTx)).txid;

    return transactionId;
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
   * @param vault_token The token used to authenticate with the vault.
   * @returns The transaction ID of the submitted transaction.
   */
  async transferAsset(assetId: bigint, userId: string, amount: number, vault_token: string) {
    const userPublicAddress: string = (await this.getUserInfo(userId, vault_token)).public_address;
    const managerPublicAddress: string = await this.vaultService.getManagerPublicAddress(vault_token);

    let suggested_params = await this.chainService.getSuggestedParams();

    // check if user opted in for the asset

    let willOptInTx: boolean = false;
    let account_asset = await this.chainService.getAccountAsset(userPublicAddress, assetId);
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

    let unSignedTxs: Uint8Array[] = [];
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
        suggested_params,
      ),
    );

    // group them

    let unSignedGroupedTxns: Uint8Array<ArrayBufferLike>[] = this.chainService.setGroupID(unSignedTxs);

    // sign txs by sender

    let signedTxs: Uint8Array[] = [];
    for (let tx of unSignedGroupedTxns) {
      let encoder: AlgorandEncoder = new AlgorandEncoder();
      let isUserTx: boolean =
        encoder.encodeAddress(Buffer.from(encoder.decodeTransaction(tx).snd)) == userPublicAddress;
      let isManagerTx: boolean =
        encoder.encodeAddress(Buffer.from(encoder.decodeTransaction(tx).snd)) == managerPublicAddress;

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
}

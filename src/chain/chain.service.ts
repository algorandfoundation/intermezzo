import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AlgorandEncoder,
  AlgorandTransactionCrafter,
  AssetParamsBuilder,
  AssetTransferTxBuilder,
} from '@algorandfoundation/algo-models';
import { HttpErrorByCode } from '@nestjs/common/utils/http-error-by-code.util';
import { HttpService } from '@nestjs/axios';
import { AxiosResponse } from 'axios';

@Injectable()
export class ChainService {
  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  private getCrafter(): AlgorandTransactionCrafter {
    return new AlgorandTransactionCrafter(this.configService.get('GENESIS_ID'), this.configService.get('GENESIS_HASH'));
  }

  addSignatureToTxn(encodedTransaction: Uint8Array, signature: Uint8Array): Uint8Array {
    let crafter = this.getCrafter();
    return crafter.addSignature(encodedTransaction, signature);
  }

  /**
   * Sets the group ID for a list of transactions.
   *
   * This function computes a group ID for the given transactions and then sets this ID for each transaction.
   *
   * @param txns The list of transactions to be grouped.
   * @returns The list of transactions with the group ID set.
   */
  setGroupID(txns: Uint8Array[]): Uint8Array[] {
    let groupId = new AlgorandEncoder().computeGroupId(txns);

    let grouped: Uint8Array[] = [];
    for (let txn of txns) {
      let decodedTx = new AlgorandEncoder().decodeTransaction(txn);
      decodedTx.grp = groupId;
      grouped.push(new AlgorandEncoder().encodeTransaction(decodedTx));
    }

    return grouped;
  }

  async craftAssetCreateTx(
    creatorAddress: string,
    options: {
      total: number;
      decimals: bigint;
      defaultFrozen: boolean;
      unitName: string;
      assetName: string;
      url: string;
      managerAddress?: string;
      reserveAddress?: string;
      freezeAddress?: string;
      clawbackAddress?: string;
    },
  ): Promise<Uint8Array> {
    let crafter = this.getCrafter();
    let suggested_params: TruncatedSuggestedParamsResponse = await this.getSuggestedParams();

    let paramsBuilder = new AssetParamsBuilder();
    if (options.total) paramsBuilder.addTotal(options.total);
    if (options.decimals) paramsBuilder.addDecimals(Number(options.decimals));
    if (options.defaultFrozen) paramsBuilder.addDefaultFrozen(options.defaultFrozen);
    if (options.unitName) paramsBuilder.addUnitName(options.unitName);
    if (options.assetName) paramsBuilder.addAssetName(options.assetName);
    if (options.managerAddress) paramsBuilder.addManagerAddress(options.managerAddress);
    if (options.reserveAddress) paramsBuilder.addReserveAddress(options.reserveAddress);
    if (options.freezeAddress) paramsBuilder.addFreezeAddress(options.freezeAddress);
    if (options.clawbackAddress) paramsBuilder.addClawbackAddress(options.clawbackAddress);

    let params = paramsBuilder.get();
    if (options.url) params.au = options.url;

    let transactionBuilder = crafter
      .createAsset(creatorAddress, params)
      .addFee(suggested_params.minFee)
      .addFirstValidRound(suggested_params.lastRound)
      .addLastValidRound(suggested_params.lastRound + 1000n);

    return transactionBuilder.get().encode();
  }

  async craftPaymentTx(
    from: string,
    to: string,
    amount: number,
    suggested_params?: TruncatedSuggestedParamsResponse,
  ): Promise<Uint8Array> {
    suggested_params = suggested_params ? suggested_params : await this.getSuggestedParams();

    let crafter = this.getCrafter();

    let transactionBuilder = crafter
      .pay(amount, from, to)
      .addFee(suggested_params.minFee)
      .addFirstValidRound(suggested_params.lastRound)
      .addLastValidRound(suggested_params.lastRound + 1000n);

    return transactionBuilder.get().encode();
  }

  async craftAssetTransferTx(
    from: string,
    to: string,
    asset_id: bigint,
    amount: number | bigint,
    lease?: string,
    note?: string,
    suggested_params?: TruncatedSuggestedParamsResponse,
  ): Promise<Uint8Array> {
    suggested_params = suggested_params ? suggested_params : await this.getSuggestedParams();

    let builder = new AssetTransferTxBuilder(
      this.configService.get('GENESIS_ID'),
      this.configService.get('GENESIS_HASH'),
    );
    builder.addAssetId(asset_id);
    builder.addSender(from);
    builder.addAssetReceiver(to);
    builder.addFee(suggested_params.minFee);
    builder.addFirstValidRound(suggested_params.lastRound);
    builder.addLastValidRound(suggested_params.lastRound + 1000n);
    if (note) {
      builder.addNote(note);
    }
    if (amount != 0) {
      builder.addAssetAmount(amount);
    }
    if (lease) {
      try {
        const leaseBuffer = Buffer.from(lease, 'base64');
        const leaseUint8Array = new Uint8Array(leaseBuffer);
        builder.addLease(leaseUint8Array);
      } catch (error) {
        throw new HttpErrorByCode[400](
          `Invalid lease format: ${error.message}`,
        );
      }
    }

    return builder.get().encode();
  }

  async craftAssetClawbackTx(
    clawbackAddress: string,
    from: string,
    to: string,
    asset_id: bigint,
    amount: number | bigint,
    suggested_params?: TruncatedSuggestedParamsResponse,
  ): Promise<Uint8Array> {
    suggested_params = suggested_params
      ? suggested_params
      : await this.getSuggestedParams();

    const builder = new AssetTransferTxBuilder(
      this.configService.get('GENESIS_ID'),
      this.configService.get('GENESIS_HASH'),
    );
    builder.addAssetId(asset_id);
    builder.addSender(clawbackAddress);
    builder.addAssetSender(from);
    builder.addAssetReceiver(to);
    builder.addFee(suggested_params.minFee);
    builder.addFirstValidRound(suggested_params.lastRound);
    builder.addLastValidRound(suggested_params.lastRound + 1000n);

    if (amount != 0) {
      builder.addAssetAmount(amount);
    }

    return builder.get().encode();
  }

  async makeAlgoNodeRequest(path: string, method: 'GET' | 'POST', data?: any): Promise<any> {
    const nodeHttpScheme: string = this.configService.get<string>('NODE_HTTP_SCHEME');
    const nodeHost: string = this.configService.get<string>('NODE_HOST');
    const nodePort: string = this.configService.get<string>('NODE_PORT');
    const token: string = this.configService.get<string>('NODE_TOKEN');

    const url: string = `${nodeHttpScheme}://${nodeHost}:${nodePort}/${path}`;

    try {
      const config = {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Algo-API-Token': token,
        },
      };

      let result: AxiosResponse<any>;

      if (method === 'POST') {
        result = await this.httpService.axiosRef.post(url, data, config);
      } else {
        result = await this.httpService.axiosRef.get(url, config);
      }

      return result.data;
    } catch (error) {
      if (error.response?.status) {
        throw new HttpErrorByCode[error.response.status](`NodeException: ${error.response.text}`);
      } else {
        throw new InternalServerErrorException('NodeException');
      }
    }
  }

  async waitConfirmation(txId: string, waitRounds: bigint = 20n) {
    // copy paste logic from algo-sdk
    const startRound = (await this.getSuggestedParams()).lastRound;
    const stopRound = startRound + waitRounds;

    let currentRound = startRound;
    while (currentRound < stopRound) {
      let poolError = false;
      try {
        const pendingInfo = await this.makeAlgoNodeRequest(`v2/transactions/pending/${txId}`, 'GET');

        if (pendingInfo['confirmed-round']) {
          // Got the completed Transaction
          return pendingInfo;
        }

        if (pendingInfo['pool-error']) {
          // If there was a pool error, then the transaction has been rejected
          poolError = true;
          throw new Error(`Transaction Rejected: ${pendingInfo['pool-error']}`);
        }
      } catch (err) {
        // Ignore errors from PendingTransactionInformation, since it may return 404 if the algod
        // instance is behind a load balancer and the request goes to a different algod than the
        // one we submitted the transaction to
        if (poolError) {
          // Rethrow error only if it's because the transaction was rejected
          throw err;
        }
      }

      await this.makeAlgoNodeRequest(`v2/status/wait-for-block-after/${currentRound}`, 'GET');
      currentRound += BigInt(1);
    }
  }

  async getSuggestedParams(): Promise<TruncatedSuggestedParamsResponse> {
    const response = await this.makeAlgoNodeRequest('v2/transactions/params', 'GET');
    const suggestedParams: TruncatedSuggestedParamsResponse = {
      lastRound: BigInt(response['last-round']),
      minFee: response['min-fee'],
    };
    return suggestedParams;
  }

  /**
   * Get the account detail for a specific public address.
   * 
   * @param public_address - The public address of the account.
   * @returns - The account detail including amount, min balance, and asset holdings.
   */
  async getAccountDetail(public_address: string): Promise<TruncatedAccountResponse> {
    const response = await this.makeAlgoNodeRequest(`v2/accounts/${public_address}`, 'GET');

    Logger.debug(`Account detail response: ${JSON.stringify(response)}`);

    const truncatedAccountResponse: TruncatedAccountResponse = {
      amount: BigInt(response['amount']),
      minBalance: BigInt(response['min-balance']),
      assets: response['assets'].map((asset: any) => ({ assetId: asset['asset-id'], balance: asset['amount'] }) as TruncatedAssetHolding),
    };
    return truncatedAccountResponse;
  }

  /**
   * Get the asset holding for a specific account and asset ID.
   * 
   * @param public_address - The public address of the account.
   * @param asset_id - The ID of the asset.
   * @returns - The asset holding for the account and asset ID, or null if not found.
   */
  async getAccountAssetHoldings(public_address: string): Promise<AssetHolding[]> {
    const response: AccountAssetsResponse = await this.makeAlgoNodeRequest(`v2/accounts/${public_address}`, 'GET');

    Logger.debug(`Account asset holdings response: ${JSON.stringify(response)}`);

    return response.assets
  }

  /**
   * Get the asset holding for a specific account and asset ID.
   * 
   * @param public_address - The public address of the account.
   * @param asset_id - The ID of the asset.
   * @returns - The asset holding for the account and asset ID, or null if not found.
   */

  async getAccountAsset(public_address: string, asset_id: bigint): Promise<TruncatedAccountAssetResponse | null> {
    try {
      await this.makeAlgoNodeRequest(`v2/accounts/${public_address}/assets/${asset_id}/`, 'GET');
      const truncatedAccountAssetResponse: TruncatedAccountAssetResponse = {};
      return truncatedAccountAssetResponse;
    } catch (error) {
      if (error.response?.statusCode) {
        // if 404, account has no asset, we return null
        if (error.response.statusCode == 404) {
          return null;
        }
        throw error;
      }
      throw error;
    }
  }

  /**
   * Get the last round number from the Algorand node.
   * 
   * @returns - last round number
   */
  async getLastRound(): Promise<bigint> {
    const response = await this.makeAlgoNodeRequest('v2/status', 'GET');
    return BigInt(response['last-round']);
  }

  /**
   * Submits a transaction or transactions to the Algorand network.
   * 
   * @param txnOrtxns - The transaction or transactions to be submitted.
   * @returns - The transaction ID of the submitted transaction.
   */
  async submitTransaction(txnOrtxns: Uint8Array | Uint8Array[]): Promise<TruncatedPostTransactionsResponse> {
    let data = txnOrtxns instanceof Uint8Array ? Buffer.from(txnOrtxns) : Buffer.concat(txnOrtxns);
    let response = await this.makeAlgoNodeRequest('v2/transactions', 'POST', data);
    const postTransactionResponse: TruncatedPostTransactionsResponse = {
      txid: response['txId'],
    };

    await this.waitConfirmation(postTransactionResponse.txid);
    return postTransactionResponse;
  }
}

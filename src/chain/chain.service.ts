import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AlgorandEncoder,
  AlgorandTransactionCrafter,
  AssetParamsBuilder,
  AssetTransferTxBuilder,
  // ApplicationCallTxBuilder,
  StateSchema,
} from '@algorandfoundation/algo-models';

import { ApplicationCallTxBuilder } from './algorand.transaction.appl.temp';
import { HttpErrorByCode } from '@nestjs/common/utils/http-error-by-code.util';
import { HttpService } from '@nestjs/axios';
import { AxiosResponse } from 'axios';
import { safeStringify } from '../util';
import {
  AccountAssetsResponse,
  AssetHolding,
  TruncatedAccountAssetResponse,
  TruncatedAccountResponse,
  TruncatedAssetHolding,
  TruncatedPostTransactionsResponse,
  TruncatedSuggestedParamsResponse,
} from './algo-node-responses';
import { AppCallRequestDto } from '../wallet/app-call-request.dto';
import { base64ToBytes, bytesToBase64, encodeString, encodeUint64 } from './encoding';
import { sha512_256 } from 'js-sha512';

@Injectable()
export class ChainService {
  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  private getCrafter(): AlgorandTransactionCrafter {
    return new AlgorandTransactionCrafter(this.configService.get('GENESIS_ID'), this.configService.get('GENESIS_HASH'));
  }

  private parseLease(lease: string): Uint8Array {
    return new Uint8Array(Buffer.from(lease, 'base64'));
  }

  addSignatureToTxn(encodedTransaction: Uint8Array, signature: Uint8Array): Uint8Array {
    const crafter = this.getCrafter();
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
    const groupId = new AlgorandEncoder().computeGroupId(txns);

    const grouped: Uint8Array[] = [];
    for (const txn of txns) {
      const decodedTx = new AlgorandEncoder().decodeTransaction(txn);
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
    const crafter = this.getCrafter();
    const suggested_params: TruncatedSuggestedParamsResponse = await this.getSuggestedParams();

    const paramsBuilder = new AssetParamsBuilder();
    if (options.total) paramsBuilder.addTotal(options.total);
    if (options.decimals) paramsBuilder.addDecimals(Number(options.decimals));
    if (options.defaultFrozen) paramsBuilder.addDefaultFrozen(options.defaultFrozen);
    if (options.unitName) paramsBuilder.addUnitName(options.unitName);
    if (options.assetName) paramsBuilder.addAssetName(options.assetName);
    if (options.managerAddress) paramsBuilder.addManagerAddress(options.managerAddress);
    if (options.reserveAddress) paramsBuilder.addReserveAddress(options.reserveAddress);
    if (options.freezeAddress) paramsBuilder.addFreezeAddress(options.freezeAddress);
    if (options.clawbackAddress) paramsBuilder.addClawbackAddress(options.clawbackAddress);

    const params = paramsBuilder.get();
    if (options.url) params.au = options.url;

    const transactionBuilder = crafter
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

    const crafter = this.getCrafter();

    const transactionBuilder = crafter
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

    const builder = new AssetTransferTxBuilder(
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
        builder.addLease(this.parseLease(lease));
      } catch (error) {
        throw new HttpErrorByCode[400](`Invalid lease format: ${error.message}`);
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
    lease?: string,
    note?: string,
    suggested_params?: TruncatedSuggestedParamsResponse,
  ): Promise<Uint8Array> {
    suggested_params = suggested_params ? suggested_params : await this.getSuggestedParams();

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

    if (note) {
      builder.addNote(note);
    }

    if (amount != 0) {
      builder.addAssetAmount(amount);
    }

    if (lease) {
      try {
        builder.addLease(this.parseLease(lease));
      } catch (error) {
        throw new HttpErrorByCode[400](`Invalid lease format: ${error.message}`);
      }
    }

    return builder.get().encode();
  }

  async craftAppCallTx(
    managerPublicAddress: string,
    appCallRequestDto: AppCallRequestDto,
    suggested_params: TruncatedSuggestedParamsResponse,
    fee?: number,
  ) {
    const builder = new ApplicationCallTxBuilder(
      this.configService.get('GENESIS_ID'),
      this.configService.get('GENESIS_HASH'),
    );
    builder.addSender(managerPublicAddress);
    builder.addFee(fee ?? suggested_params.minFee);
    builder.addFirstValidRound(suggested_params.lastRound);
    builder.addLastValidRound(suggested_params.lastRound + 1000n);

    if (appCallRequestDto.note) builder.addNote(appCallRequestDto.note);
    if (appCallRequestDto.lease) builder.addLease(this.parseLease(appCallRequestDto.lease));

    if (appCallRequestDto.onComplete) builder.addOnComplete(appCallRequestDto.onComplete);

    let globalStateSchema: StateSchema | undefined;
    if (appCallRequestDto.globalInts && appCallRequestDto.globalInts > 0) {
      globalStateSchema = {
        ...(globalStateSchema ?? {}),
        nui: Number(appCallRequestDto.globalInts),
      } as StateSchema;
    }
    if (appCallRequestDto.globalByteSlices && appCallRequestDto.globalByteSlices > 0) {
      globalStateSchema = {
        ...(globalStateSchema ?? {}),
        nbs: Number(appCallRequestDto.globalByteSlices),
      } as StateSchema;
    }
    if (globalStateSchema) {
      builder.addGlobalSchema(globalStateSchema);
    }

    let localStateSchema: StateSchema | undefined;
    if (appCallRequestDto.localInts && appCallRequestDto.localInts > 0) {
      localStateSchema = {
        ...(localStateSchema ?? {}),
        nui: Number(appCallRequestDto.localInts),
      } as StateSchema;
    }
    if (appCallRequestDto.localByteSlices && appCallRequestDto.localByteSlices > 0) {
      localStateSchema = {
        ...(localStateSchema ?? {}),
        nbs: Number(appCallRequestDto.localByteSlices),
      } as StateSchema;
    }
    if (localStateSchema) {
      builder.addLocalSchema(localStateSchema);
    }

    if (appCallRequestDto.foreignAssets?.length) {
      builder.addForeignAssets(appCallRequestDto.foreignAssets.map((a: any) => BigInt(a)));
    }
    if (appCallRequestDto.foreignApps?.length) {
      builder.addForeignApps(appCallRequestDto.foreignApps.map((a: any) => BigInt(a)));
    }
    if (appCallRequestDto.foreignAccounts?.length) {
      builder.addAccounts(appCallRequestDto.foreignAccounts);
    }

    if (appCallRequestDto.boxes?.length) {
      builder.addBoxes(appCallRequestDto.boxes);
    }

    if (appCallRequestDto.approvalProgram) builder.addApprovalProgram(base64ToBytes(appCallRequestDto.approvalProgram));
    if (appCallRequestDto.clearProgram) builder.addClearStateProgram(base64ToBytes(appCallRequestDto.clearProgram));

    if (appCallRequestDto.appId) builder.addApplicationId(BigInt(appCallRequestDto.appId));

    const appArgs = await this.processAbiMethodArgs(appCallRequestDto.args);
    if (appArgs.length > 0) builder.addApplicationArgs(appArgs);

    return builder.get().encode();
  }

  /**
   * Build ABI method selector + encoded arguments array suitable for addApplicationArgs.
   * It uses the ABI specification and embedded `value` fields from AppCallRequestDto.args.
   * It currently supports uint64, string, and address. Txn-typed args are ignored here
   * and must be represented as separate transactions in the group.
   */
  async processAbiMethodArgs(spec: AppCallRequestDto['args']): Promise<Uint8Array[]> {
    if (!spec) {
      return [];
    }

    const methodName = spec.name;
    const argSpecs = Array.isArray(spec.args) ? spec.args : [];
    const returnType = spec.returns?.type ?? 'void';

    const argTypes: string[] = argSpecs.map((s: any) => s.type).filter((t: any): t is string => typeof t === 'string');

    const signature = `${methodName}(${argTypes.join(',')})${returnType}`;

    const selector = new Uint8Array(sha512_256.array(Buffer.from(signature)).slice(0, 4));

    const encodedArgs: Uint8Array[] = [];

    argSpecs.forEach((argSpec: any) => {
      const type = argSpec.type as string;
      const value = argSpec.value;

      // For now we skip txn typed args here; they are expected to be
      // separate transactions in the group, not ABI-encoded scalars.
      if (type === 'pay' || type === 'keyreg' || type === 'axfer' || type === 'acfg' || type === 'appl') {
        return;
      }

      if (value === undefined || value === null) {
        return;
      }

      const encoded = this.encodeAbiArgument(type, value);

      if (encoded) {
        encodedArgs.push(encoded);
      }
    });

    return [selector, ...encodedArgs];
  }

  private encodeAbiArgument(type: string, value: any): Uint8Array | null {
    switch (type) {
      case 'uint64': {
        return encodeUint64(BigInt(value));
      }
      case 'string': {
        return encodeString(value);
      }
      case 'address': {
        // Expecting a base32 Algorand address string; need its 32-byte public key bytes
        const encoder = new AlgorandEncoder();
        // decodeAddress returns the raw public key bytes for an address string
        // @ts-ignore decodeAddress may not be typed on older versions
        return encoder.decodeAddress(value);
      }
      default:
        throw new Error(`Unsupported ABI argument type: ${type}`);
    }
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
        const message =
          error.response.text ??
          (typeof error.response.data === 'string' ? error.response.data : safeStringify(error.response.data));
        throw new HttpErrorByCode[error.response.status](`NodeException: ${message}`);
      } else {
        throw new InternalServerErrorException(`NodeException: ${error.message}`);
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
      assets: response['assets'].map(
        (asset: any) => ({ assetId: asset['asset-id'], balance: asset['amount'] }) as TruncatedAssetHolding,
      ),
    };
    return truncatedAccountResponse;
  }

  // Get Algo Balance, fetch balance from AlgoD
  async getAccountBalance(public_address: string): Promise<bigint> {
    const response = await this.makeAlgoNodeRequest(`v2/accounts/${public_address}`, 'GET');

    Logger.debug(`Account balance response: ${JSON.stringify(response)}`);

    return BigInt(response['amount']);
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

    return response.assets;
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
    const data = txnOrtxns instanceof Uint8Array ? Buffer.from(txnOrtxns) : Buffer.concat(txnOrtxns);
    const response = await this.makeAlgoNodeRequest('v2/transactions', 'POST', data);
    const postTransactionResponse: TruncatedPostTransactionsResponse = {
      txid: response['txId'],
    };

    await this.waitConfirmation(postTransactionResponse.txid);
    return postTransactionResponse;
  }
}

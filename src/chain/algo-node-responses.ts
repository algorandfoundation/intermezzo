interface TruncatedSuggestedParamsResponse {
  lastRound: bigint;
  minFee: number;
}

interface TruncatedAssetHolding {
  assetId: number;
}

interface TruncatedAccountResponse {
  amount: bigint;
  minBalance: bigint;
  assets: TruncatedAssetHolding[];
}

interface TruncatedAccountAssetResponse {}

interface TruncatedPostTransactionsResponse {
  txid: string;
}

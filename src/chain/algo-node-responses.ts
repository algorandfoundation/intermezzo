interface TruncatedSuggestedParamsResponse {
  lastRound: bigint;
  minFee: number;
}

interface TruncatedAssetHolding {
  assetId: number;
  balance: number;
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

// example value : {"address":"FJH4NJ5WEEGPZSNF4ZIJBJEQFXYDTAV3ZK62IPRQIHIR4RPTPUT4Y6RPWE","amount":200000,
// "amount-without-pending-rewards":200000,"apps-local-state":[],"apps-total-schema":{"num-byte-slice":0,"num-uint":0},
// "assets":[{"amount":2,"asset-id":737034321,"is-frozen":false}],"created-apps":[],"created-assets":[],"min-balance":200000,"pending-rewards":0,"reward-base":27521,"rewards":0,"round":50893756,"status":"Offline","total-apps-opted-in":0,"total-assets-opted-in":1,"total-created-apps":0,"total-created-assets":0}
interface AccountAssetsResponse {
  address: string;
  amount: bigint;
  "amount-without-pending-rewards": bigint;
  "apps-local-state": any[];
  "apps-total-schema": {
    "num-byte-slice": number;
    "num-uint": number;
  };
  assets: AssetHolding[];
}

interface AssetHolding {
  amount: bigint;
  "asset-id": number;
  "is-frozen": boolean;
}
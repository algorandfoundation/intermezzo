import { AlgorandEncoder } from '@algorandfoundation/algo-models';
import { ITransactionHeaderBuilder, TransactionHeader } from '@algorandfoundation/algo-models';

export type StateSchema = {
  nui: number;
  nbs: number;
};

export class ApplicationCallTransactionTemp extends TransactionHeader {
  declare type: 'appl';

  apid!: bigint; // Application ID
  apan!: number; // OnComplete

  apat?: Uint8Array[]; // Accounts
  apaa?: Uint8Array[]; // App args
  apap?: Uint8Array; // Approval program
  apsu?: Uint8Array; // Clear program

  apfa?: bigint[]; // ✅ Foreign APPS (FIXED)
  apas?: bigint[]; // ✅ Foreign ASSETS (FIXED)

  apgs?: StateSchema;
  apls?: StateSchema;
  apep?: number;

  apbx?: {
    i: number; // index into apfa
    n: Uint8Array; // ✅ RAW BYTES (FIXED)
  }[];

  encode(): Uint8Array {
    return new AlgorandEncoder().encodeTransaction(this as any);
  }
}

export interface IApplicationCallTxBuilder extends ITransactionHeaderBuilder<IApplicationCallTxBuilder> {
  addApplicationId(apid: bigint): IApplicationCallTxBuilder;
  addOnComplete(apan: number): IApplicationCallTxBuilder;
  addAccounts(apat: string[]): IApplicationCallTxBuilder;
  addApplicationArgs(apaa: Uint8Array[]): IApplicationCallTxBuilder;
  addApprovalProgram(apap: Uint8Array): IApplicationCallTxBuilder;
  addClearStateProgram(apsu: Uint8Array): IApplicationCallTxBuilder;

  addForeignApps(apps: bigint[]): IApplicationCallTxBuilder;
  addForeignAssets(assets: bigint[]): IApplicationCallTxBuilder;

  addGlobalSchema(apgs: StateSchema): IApplicationCallTxBuilder;
  addLocalSchema(apls: StateSchema): IApplicationCallTxBuilder;
  addExtraProgramPages(apep: number): IApplicationCallTxBuilder;

  addBoxes(apbx: { i: number; n: string }[]): IApplicationCallTxBuilder;

  get(): ApplicationCallTransactionTemp;
}

export class ApplicationCallTxBuilder implements IApplicationCallTxBuilder {
  private readonly tx: ApplicationCallTransactionTemp;
  private readonly encoder = new AlgorandEncoder();

  constructor(genesisId: string, genesisHash: string) {
    this.tx = new ApplicationCallTransactionTemp();
    this.tx.type = 'appl';
    this.tx.gen = genesisId;
    this.tx.gh = new Uint8Array(Buffer.from(genesisHash, 'base64'));
    this.tx.fee = 1000n;
  }

  addApplicationId(appId: bigint) {
    this.tx.apid = appId;
    return this;
  }

  addOnComplete(apan: number) {
    this.tx.apan = apan;
    return this;
  }

  addAccounts(accounts: string[]) {
    this.tx.apat = accounts.map((a) => this.encoder.decodeAddress(a));
    return this;
  }

  addApplicationArgs(apaa: Uint8Array[]) {
    this.tx.apaa = apaa;
    return this;
  }

  addApprovalProgram(apap: Uint8Array) {
    this.tx.apap = apap;
    return this;
  }

  addClearStateProgram(apsu: Uint8Array) {
    this.tx.apsu = apsu;
    return this;
  }

  // ✅ FIXED: correct field
  addForeignApps(apps: bigint[]) {
    this.tx.apfa = apps;
    return this;
  }

  // ✅ FIXED: correct field
  addForeignAssets(assets: bigint[]) {
    this.tx.apas = assets;
    return this;
  }

  addGlobalSchema(apgs: StateSchema) {
    this.tx.apgs = apgs;
    return this;
  }

  addLocalSchema(apls: StateSchema) {
    this.tx.apls = apls;
    return this;
  }

  addExtraProgramPages(apep: number) {
    this.tx.apep = apep;
    return this;
  }

  // ✅ FIXED: decode base64 → raw bytes
  addBoxes(apbx: { i: number; n: string }[]) {
    this.tx.apbx = apbx.map((b) => ({
      i: b.i, // i = index into apfa (0 is VALID)
      n: new Uint8Array(Buffer.from(b.n, 'base64')),
    }));
    return this;
  }

  addSender(sender: string) {
    this.tx.snd = this.encoder.decodeAddress(sender);
    return this;
  }

  addFee(fee: number | bigint) {
    this.tx.fee = AlgorandEncoder.safeCastBigInt(fee);
    return this;
  }

  addFirstValidRound(fv: number | bigint) {
    this.tx.fv = AlgorandEncoder.safeCastBigInt(fv);
    return this;
  }

  addLastValidRound(lv: number | bigint) {
    this.tx.lv = AlgorandEncoder.safeCastBigInt(lv);
    return this;
  }

  addNote(note: string, encoding: BufferEncoding = 'utf8') {
    this.tx.note = new Uint8Array(Buffer.from(note, encoding));
    return this;
  }

  addLease(lease: Uint8Array) {
    this.tx.lx = lease;
    return this;
  }

  addGroup(group: Uint8Array) {
    this.tx.grp = group;
    return this;
  }

  addRekey(address: string) {
    this.tx.rekey = this.encoder.decodeAddress(address);
    return this;
  }

  get(): ApplicationCallTransactionTemp {
    return this.tx;
  }
}

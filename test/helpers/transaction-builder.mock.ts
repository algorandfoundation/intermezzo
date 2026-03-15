import { AlgorandEncoder, AlgorandTransactionCrafter, AssetTransferTxBuilder } from '@algorandfoundation/algo-models';

/**
 * Test helper class to mock client-side transaction crafting.
 * Creates real Algorand transactions for testing the sponsor endpoint.
 */
export class TestTransactionBuilder {
  private static genesisId = 'testnet-v1.0';
  private static genesisHash = 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';

  /**
   * Creates a payment transaction.
   *
   * @param sender The sender address
   * @param receiver The receiver address
   * @param amount The amount in microAlgos
   * @param fee The fee (default 0 for user transactions)
   * @param groupId Optional group ID
   * @returns The encoded transaction as Uint8Array
   */
  static createPaymentTx(
    sender: string,
    receiver: string,
    amount: number,
    fee: number = 0,
    groupId?: Uint8Array,
  ): Uint8Array {
    const crafter = new AlgorandTransactionCrafter(this.genesisId, this.genesisHash);

    const lastRound = BigInt(1000);
    const transactionBuilder = crafter
      .pay(amount, sender, receiver)
      .addFee(fee)
      .addFirstValidRound(lastRound)
      .addLastValidRound(lastRound + BigInt(1000));

    const tx = transactionBuilder.get();
    if (groupId) {
      tx.grp = groupId;
    }

    return new AlgorandEncoder().encodeTransaction(tx);
  }

  /**
   * Creates an asset transfer transaction.
   *
   * @param sender The sender address
   * @param receiver The receiver address
   * @param assetId The asset ID
   * @param amount The amount
   * @param fee The fee (default 0 for user transactions)
   * @param groupId Optional group ID
   * @returns The encoded transaction as Uint8Array
   */
  static createAssetTransferTx(
    sender: string,
    receiver: string,
    assetId: bigint,
    amount: number,
    fee: number = 0,
    groupId?: Uint8Array,
  ): Uint8Array {
    const builder = new AssetTransferTxBuilder(this.genesisId, this.genesisHash);

    const lastRound = BigInt(1000);
    builder.addAssetId(assetId);
    builder.addSender(sender);
    builder.addAssetReceiver(receiver);
    builder.addAssetAmount(amount);
    builder.addFee(fee);
    builder.addFirstValidRound(lastRound);
    builder.addLastValidRound(lastRound + BigInt(1000));

    const tx = builder.get();
    if (groupId) {
      tx.grp = groupId;
    }

    return new AlgorandEncoder().encodeTransaction(tx);
  }

  /**
   * Groups transactions together by computing and setting a group ID.
   *
   * @param txs Array of transactions to group
   * @returns Array of transactions with group ID set
   */
  static setGroupId(txs: Uint8Array[]): Uint8Array[] {
    const encoder = new AlgorandEncoder();
    const groupId = encoder.computeGroupId(txs);

    const grouped: Uint8Array[] = [];
    for (const txn of txs) {
      const decodedTx = encoder.decodeTransaction(txn);
      decodedTx.grp = groupId;
      grouped.push(encoder.encodeTransaction(decodedTx));
    }

    return grouped;
  }

  /**
   * Converts a transaction to base64 string.
   *
   * @param tx The transaction as Uint8Array
   * @returns Base64 encoded string
   */
  static toBase64(tx: Uint8Array): string {
    return Buffer.from(tx).toString('base64');
  }

  /**
   * Converts a base64 string to transaction.
   *
   * @param base64 The base64 encoded transaction
   * @returns The transaction as Uint8Array
   */
  static fromBase64(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  /**
   * Generates a test Algorand address from a seed string.
   * This creates a deterministic address for testing.
   *
   * @param seed The seed string
   * @returns A base32 Algorand address
   */
  static generateTestAddress(seed: string): string {
    // Create a deterministic 32-byte public key from seed
    const encoder = new AlgorandEncoder();
    const publicKey = new Uint8Array(32);
    for (let i = 0; i < seed.length && i < 32; i++) {
      publicKey[i] = seed.charCodeAt(i);
    }
    return encoder.encodeAddress(Buffer.from(publicKey));
  }
}

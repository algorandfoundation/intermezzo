import { Address } from '@algorandfoundation/algokit-utils';
import { encodeTransaction, Transaction } from '@algorandfoundation/algokit-utils/transact';
import type { TransactionSigner } from '@algorandfoundation/algokit-utils/transact';
import { ChainService } from '../chain/chain.service';
import { VaultService } from '../vault/vault.service';

/**
 * Decode a Vault transit signature (`vault:v1:<base64-sig>`) into raw
 * 64-byte ed25519 signature material.
 */
export function decodeVaultSignature(vaultRawSig: Buffer): Uint8Array {
  const raw = vaultRawSig?.toString() ?? '';
  const parts = raw.split(':');
  // Expected envelope: `vault:v1:<base64-sig>`
  if (parts.length < 3 || parts[0] !== 'vault' || !parts[1]?.startsWith('v') || !parts[2]) {
    throw new Error(`Invalid Vault signature envelope: expected "vault:v<n>:<base64>", got "${raw}"`);
  }
  const sig = new Uint8Array(Buffer.from(parts[2], 'base64'));
  // Ed25519 signatures are exactly 64 bytes.
  if (sig.length !== 64) {
    throw new Error(`Invalid Vault signature length: expected 64 bytes, got ${sig.length}`);
  }
  return sig;
}

/**
 * Build a `TransactionSigner` for a sender whose private key lives in Vault
 * and is signed via Vault Transit.
 *
 * For each transaction at an indexed position, we:
 *   1. encode it with the canonical `TX` domain-separation prefix,
 *   2. delegate signing to the supplied `vaultSign` function (Vault Transit),
 *   3. assemble a wire-format SignedTransaction by attaching the raw sig,
 * matching the convention already used by `WalletService`.
 */
export function buildVaultTransactionSigner(
  chainService: ChainService,
  vaultSign: (bytesToSign: Uint8Array) => Promise<Buffer>,
): TransactionSigner {
  return async (txnGroup: Transaction[], indexesToSign: number[]) => {
    const signed: Uint8Array[] = [];
    for (const i of indexesToSign) {
      const encoded = encodeTransaction(txnGroup[i]); // includes "TX" prefix
      const vaultSig = await vaultSign(encoded);
      const sig = decodeVaultSignature(vaultSig);
      signed.push(chainService.addSignatureToTxn(encoded, sig));
    }
    return signed;
  };
}

/**
 * Wraps `buildVaultTransactionSigner` for the manager identity, returning
 * both the manager Algorand address and a TransactionSigner bound to it.
 */
export async function buildManagerSigner(
  vaultService: VaultService,
  chainService: ChainService,
  vaultToken: string,
): Promise<{ address: Address; signer: TransactionSigner }> {
  const managerPublicKey = await vaultService.getManagerPublicKey(vaultToken);
  const address = new Address(managerPublicKey);
  const signer = buildVaultTransactionSigner(chainService, (bytes) => vaultService.signAsManager(bytes, vaultToken));
  return { address, signer };
}

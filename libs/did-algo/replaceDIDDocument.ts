import { Address, AlgorandClient } from '@algorandfoundation/algokit-utils';
import { DidAlgoStorageClient } from './contracts/DidAlgoStorageClient';
import { deleteDIDDocument, DID_STATUS_READY } from './deleteDIDDocument';
import { resolveDIDDocument } from './resolveDIDDocument';
import { tryReadMetadata } from './tryReadMetadata';
import { calculateUploadCost, MAX_BOX_SIZE, uploadDIDDocument } from './uploadDIDDocument';

/** Result of a {@link replaceDIDDocument} call. */
export interface ReplaceDIDDocumentResult {
  /**
   * `true` when the on-chain document was already byte-identical to
   * the supplied payload and no transactions were issued. In that
   * case `deleteTxIds` and `uploadTxIds` are both empty and the MBR
   * delta is zero.
   */
  skipped: boolean;
  /** Transaction ids from the delete phase (empty when no prior box existed or when skipped). */
  deleteTxIds: string[];
  /** Transaction ids from the upload phase (empty only when skipped). */
  uploadTxIds: string[];
  /**
   * µAlgo MBR locked by the previously-published box (refunded to
   * the sender on delete), or `0n` when no prior document existed.
   */
  oldMbrMicroAlgos: bigint;
  /**
   * µAlgo MBR required by the new payload (paid by the sender on
   * upload). When `skipped === true` no payment is made and this
   * value is informational only — it represents the MBR that *would*
   * have been paid had the document differed.
   */
  newMbrMicroAlgos: bigint;
}

/**
 * Atomic-equivalent "replace the on-chain DID document" operation for
 * the `DIDAlgoStorage` contract.
 *
 * The contract enforces a multi-step lifecycle (UPLOADING → READY →
 * DELETING) implemented across multiple atomic transaction groups —
 * a *single* on-chain atomic group is not large enough to delete a
 * document and then upload its replacement. {@link replaceDIDDocument}
 * therefore orchestrates the two phases here, in one centralized
 * place, so every callsite uses the exact same sequence and there is
 * no opportunity for partial state (e.g. delete-without-upload) to
 * leak through.
 *
 * Cost-minimisation policy:
 *
 *   1. **No prior document** → upload only. Sender pays the new box
 *      MBR.
 *   2. **Prior document, byte-identical payload** → no on-chain
 *      writes. Returns `skipped: true`; the operator's account is
 *      never debited a single µAlgo of fees or MBR.
 *   3. **Prior document, different payload** → delete (refunding the
 *      prior box MBR back to the sender) then upload (paying the new
 *      box MBR). The sender's net out-of-pocket is
 *      `newMbrMicroAlgos − oldMbrMicroAlgos` (plus fees); when the
 *      sizes happen to match this is zero.
 *
 * Returns an explicit MBR breakdown so callers can surface the actual
 * funding requirement (or the lack thereof) to operators.
 */
export async function replaceDIDDocument(
  appClient: DidAlgoStorageClient,
  algorand: AlgorandClient,
  data: Buffer,
  appId: bigint,
  pubKey: Uint8Array,
  sender: Address,
): Promise<ReplaceDIDDocumentResult> {
  const newBoxCount = Math.ceil(data.byteLength / MAX_BOX_SIZE) || 1;
  const newEndBoxSize = data.byteLength % MAX_BOX_SIZE;
  const newMbrMicroAlgos = BigInt(calculateUploadCost(newBoxCount, newEndBoxSize));

  const existing = await tryReadMetadata(appClient, pubKey);

  // No prior document → upload only.
  if (!existing) {
    const uploadTxIds = await uploadDIDDocument(appClient, algorand, data, appId, pubKey, sender);
    return {
      skipped: false,
      deleteTxIds: [],
      uploadTxIds,
      oldMbrMicroAlgos: 0n,
      newMbrMicroAlgos,
    };
  }

  // Compute the MBR currently locked by the prior box.
  const oldBoxCount = Number(BigInt(existing.end) - BigInt(existing.start)) + 1;
  const oldEndBoxSize = Number(existing.endSize);
  const oldMbrMicroAlgos = BigInt(calculateUploadCost(oldBoxCount, oldEndBoxSize));

  // Byte-equality short-circuit. Only attempt the comparison when the
  // prior box is in the READY state — anything else (UPLOADING /
  // DELETING) is a half-baked document we should overwrite, not
  // compare against.
  if (Number(existing.status) === DID_STATUS_READY) {
    try {
      const onChain = await resolveDIDDocument(appClient, pubKey);
      if (onChain !== null) {
        // Compare via `JSON.stringify` on both sides — the on-chain
        // payload was stored as raw bytes but is re-parsed to JSON
        // by `resolveDIDDocument`, so whitespace/key-order
        // differences in the original upload are normalised out.
        const incoming = JSON.parse(data.toString('utf-8')) as unknown;
        if (JSON.stringify(onChain) === JSON.stringify(incoming)) {
          return {
            skipped: true,
            deleteTxIds: [],
            uploadTxIds: [],
            oldMbrMicroAlgos,
            newMbrMicroAlgos,
          };
        }
      }
    } catch {
      // Resolution / parse failure → fall through to the full
      // delete-and-upload path so the on-chain state is forcibly
      // refreshed.
    }
  }

  const deleteTxIds = await deleteDIDDocument(appClient, algorand, appId, pubKey, sender);
  const uploadTxIds = await uploadDIDDocument(appClient, algorand, data, appId, pubKey, sender);
  return {
    skipped: false,
    deleteTxIds,
    uploadTxIds,
    oldMbrMicroAlgos,
    newMbrMicroAlgos,
  };
}

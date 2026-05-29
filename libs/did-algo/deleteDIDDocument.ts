import { Address, AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils';
import { BoxReference } from '@algorandfoundation/algokit-utils/types/app-manager';
import { DidAlgoStorageClient, Metadata } from './contracts/DidAlgoStorageClient';
import { encodeUint64 } from './util';
import { MAX_TXNS_PER_GROUP } from './uploadDIDDocument';

/**
 * Status enum mirrored from the on-chain contract (`did-algo-storage.algo.ts`).
 * The TEAL constants are: UPLOADING=0x00, READY=0x01, DELETING=0x02.
 */
export const DID_STATUS_UPLOADING = 0;
export const DID_STATUS_READY = 1;
export const DID_STATUS_DELETING = 2;

/**
 * MicroAlgos added to each `deleteData` outer call to cover the inner
 * MBR-refund payment that the contract submits with `Fee=0`. The standard
 * Algorand min fee is 1000 µALGO; we add it once per outer call.
 */
const INNER_REFUND_FEE_MICROALGOS = 1000;

/**
 * Deletes a previously-published DID document from the `DIDAlgoStorage`
 * contract, reclaiming the box MBR back to {@link sender}.
 *
 * The contract enforces a sequential delete from `metadata.start` upward,
 * with the metadata box itself removed on the final `deleteData` call.
 * This helper drives that sequence in atomic groups of at most
 * {@link MAX_TXNS_PER_GROUP} transactions:
 *
 *   - first group: `[startDelete?, ...deleteData]`
 *     (`startDelete` is omitted when the contract is already in the
 *      `DELETING` status, e.g. resuming a partial delete).
 *   - middle groups: `[...deleteData]`
 *   - final group: ends on the `metadata.end` box (which also deletes the
 *     metadata box and resolves any remaining MBR refund).
 *
 * On every outer `deleteData` call we bump `extraFee` to cover the inner
 * refund payment, which the contract submits with `Fee=0`.
 *
 * Returns the list of confirmed transaction ids across all groups.
 */
export async function deleteDIDDocument(
  appClient: DidAlgoStorageClient,
  algorand: AlgorandClient,
  appId: bigint,
  pubKey: Uint8Array,
  sender: Address,
): Promise<string[]> {
  const pubKeyAddress = new Address(pubKey).toString();

  // 1. Read current metadata to discover the box range and lifecycle status.
  const metadata = await appClient.state.box.metadata.value(pubKeyAddress);
  if (!metadata) {
    throw new Error(`No on-chain DID metadata found for pubKey ${pubKeyAddress}`);
  }

  const endBox = metadata.end;

  // 2. Determine which boxes still need deleting and whether `startDelete`
  //    must be invoked first. The contract keeps `lastDeleted` on metadata
  //    after each successful `deleteData` (except the final call which
  //    removes the metadata box altogether), so a partial delete is safely
  //    resumable.
  const needsStartDelete = metadata.status === DID_STATUS_READY;
  if (metadata.status !== DID_STATUS_READY && metadata.status !== DID_STATUS_DELETING) {
    throw new Error(
      `Cannot delete DID for pubKey ${pubKeyAddress}: contract status=${metadata.status} (expected READY or DELETING)`,
    );
  }
  const firstBox = computeNextBoxToDelete(metadata);

  // Box references replicated for each delete call: the data box being
  // removed plus the metadata box (which is mutated on every call and
  // deleted on the last one).
  const buildDeleteBoxes = (boxIndex: bigint): BoxReference[] => [
    { appId: 0n, name: encodeUint64(boxIndex) },
    { appId: 0n, name: pubKey },
  ];

  const startDeleteMethod = appClient.appClient.getABIMethod('startDelete')!;
  const deleteDataMethod = appClient.appClient.getABIMethod('deleteData')!;

  const txIds: string[] = [];
  let nextBox = firstBox;
  let prepended = !needsStartDelete; // true once startDelete has either been added or skipped.

  while (nextBox <= endBox) {
    const composer = algorand.newGroup();
    let remaining = MAX_TXNS_PER_GROUP;

    if (!prepended) {
      composer.addAppCallMethodCall({
        method: startDeleteMethod,
        args: [pubKeyAddress],
        boxReferences: [pubKey],
        sender: sender.toString(),
        appId,
      });
      remaining -= 1;
      prepended = true;
    }

    while (remaining > 0 && nextBox <= endBox) {
      composer.addAppCallMethodCall({
        method: deleteDataMethod,
        args: [pubKeyAddress, nextBox],
        boxReferences: buildDeleteBoxes(nextBox),
        sender: sender.toString(),
        appId,
        // Bump fee so the outer call covers its own min fee plus the
        // inner refund payment the contract submits with Fee=0.
        extraFee: microAlgos(INNER_REFUND_FEE_MICROALGOS),
      });
      remaining -= 1;
      nextBox += 1n;
    }

    // Brief pause to give the algod pool time to accept earlier groups —
    // mirrors the throttling used in `uploadDIDDocument`.
    await new Promise((r) => setTimeout(r, 500));
    const result = await composer.send({ maxRoundsToWaitForConfirmation: 3 });
    if (result.txIds) txIds.push(...result.txIds);
  }

  return txIds;
}

/**
 * Pick the next box index that should be passed to `deleteData`, taking
 * into account any partial progress recorded in `metadata.lastDeleted`.
 *
 * The contract uses `lastDeleted=0` as the initial sentinel (set by
 * `startUpload`); a value of `0` only really means "no progress" when
 * `start > 0`. For the edge case where `start === 0` the sentinel
 * collides with a legitimate "I deleted box 0 as a non-end box" record,
 * so we additionally disambiguate via `status`: when `status === READY`
 * the document is intact (`startDelete` hasn't even run yet), therefore
 * by construction no `deleteData` has executed and the first box to
 * delete is `metadata.start`. Once `status === DELETING`, `lastDeleted`
 * is authoritative.
 */
function computeNextBoxToDelete(metadata: Metadata): bigint {
  if (Number(metadata.status) === DID_STATUS_READY) return metadata.start;
  if (metadata.lastDeleted < metadata.start) return metadata.start;
  return metadata.lastDeleted + 1n;
}

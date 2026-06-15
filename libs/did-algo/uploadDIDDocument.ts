import { Address, AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils';
import { BoxReference } from '@algorandfoundation/algokit-utils/types/app-manager';
import { DidAlgoStorageClient } from './contracts/DidAlgoStorageClient';
import { encodeUint64 } from './util';

export const COST_PER_BYTE = 400;
export const COST_PER_BOX = 2500;
export const MAX_BOX_SIZE = 32768;
// Match the reference contract: 2048 (max app args size) - 4 (selector) - 34 (pubkey ABI) - 8 - 8.
export const BYTES_PER_CALL = 2048 - 4 - 34 - 8 - 8;
// Algorand atomic transaction groups support up to 16 transactions.
export const MAX_TXNS_PER_GROUP = 16;

type UploadCall = {
  boxIndex: bigint;
  bytesOffset: number;
  chunk: Uint8Array;
  boxes: BoxReference[];
};

/**
 * Port of the reference `uploadDIDDocument` from
 * `did-algo/reference_contract/src/index.ts`, adapted to use only
 * the algokit-utils v10 API surface (no algosdk dependency).
 *
 * The full publish flow (mbr payment + startUpload + N upload calls + finishUpload)
 * is split across atomic groups of at most {@link MAX_TXNS_PER_GROUP} transactions,
 * with the mbr/start txns prepended to the first group and finishUpload appended
 * to the last group. Each group commits atomically on chain.
 */
export async function uploadDIDDocument(
  appClient: DidAlgoStorageClient,
  algorand: AlgorandClient,
  data: Buffer,
  appId: bigint,
  pubKey: Uint8Array,
  sender: Address,
): Promise<string[]> {
  // 1. Calculate MBR cost and prepare payment.
  const boxCount = Math.ceil(data.byteLength / MAX_BOX_SIZE);
  const endBoxSize = data.byteLength % MAX_BOX_SIZE;
  const totalCost = calculateUploadCost(boxCount, endBoxSize);
  const mbrPayment = appClient.algorand.createTransaction.payment({
    sender: sender.toString(),
    receiver: appClient.appAddress,
    amount: microAlgos(totalCost),
  });

  // 2. Determine the box index that startUpload will allocate from
  //    (currentIndex global state). This lets us prepare upload calls
  //    in the same atomic group as startUpload.
  const currentIndex = (await appClient.state.global.currentIndex()) ?? 0n;
  const startBox = currentIndex;

  const pubKeyAddress = new Address(pubKey).toString();

  // 3. Build all upload calls (across every box) ahead of time.
  const boxData = splitDataIntoBoxes(data);
  const uploadCalls: UploadCall[] = [];
  boxData.forEach((box, boxIndexOffset) => {
    const boxIndex = startBox + BigInt(boxIndexOffset);
    // 7 box references reserve room for the data box across chained calls,
    // and the last reference is the metadata box keyed by the public key.
    const boxes: BoxReference[] = new Array(7)
      .fill({ appId: 0n, name: encodeUint64(boxIndex) })
      .concat({ appId: 0n, name: pubKey });
    const chunks = splitBoxIntoChunks(box);
    chunks.forEach((chunk, i) => {
      uploadCalls.push({ boxIndex, bytesOffset: i, chunk, boxes });
    });
  });

  // 4. Compose groups: first group carries [mbrPayment, startUpload, ...uploads],
  //    last group ends with finishUpload, middle groups are uploads only.
  const txIds: string[] = [];
  const uploadMethod = appClient.appClient.getABIMethod('upload')!;
  const startUploadMethod = appClient.appClient.getABIMethod('startUpload')!;
  const finishUploadMethod = appClient.appClient.getABIMethod('finishUpload')!;

  let i = 0;
  let isFirstGroup = true;
  while (isFirstGroup || i < uploadCalls.length) {
    const composer = algorand.newGroup();
    let remaining = MAX_TXNS_PER_GROUP;

    if (isFirstGroup) {
      composer.addAppCallMethodCall({
        method: startUploadMethod,
        args: [pubKeyAddress, BigInt(boxCount), BigInt(endBoxSize), mbrPayment],
        boxReferences: [pubKey],
        sender: sender.toString(),
        appId,
      });
      remaining -= 2; // mbr payment + startUpload
      isFirstGroup = false;
    }

    // Reserve room for finishUpload only when this group can fit the remaining uploads.
    const callsLeft = uploadCalls.length - i;
    const willFitFinish = callsLeft <= remaining - 1;
    const uploadsToAdd = willFitFinish ? callsLeft : Math.min(remaining, callsLeft);

    for (let n = 0; n < uploadsToAdd; n++) {
      const call = uploadCalls[i++];
      composer.addAppCallMethodCall({
        method: uploadMethod,
        args: [pubKeyAddress, call.boxIndex, BigInt(BYTES_PER_CALL * call.bytesOffset), call.chunk],
        boxReferences: call.boxes,
        sender: sender.toString(),
        appId,
      });
    }

    if (willFitFinish) {
      composer.addAppCallMethodCall({
        method: finishUploadMethod,
        args: [pubKeyAddress],
        boxReferences: [pubKey],
        sender: sender.toString(),
        appId,
      });
    }

    // Brief pause to give the algod pool time to accept earlier groups.
    await new Promise((r) => setTimeout(r, 500));
    const result = await composer.send({ maxRoundsToWaitForConfirmation: 3 });
    if (result.txIds) txIds.push(...result.txIds);

    if (willFitFinish) break;
  }

  return txIds;
}

/**
 * Upload cost matching `did-algo/reference_contract/src/index.ts`:
 * box MBR + per-byte cost for data, plus the metadata box overhead.
 */
export function calculateUploadCost(boxCount: number, endBoxSize: number): number {
  return (
    boxCount * COST_PER_BOX +
    (boxCount - 1) * MAX_BOX_SIZE * COST_PER_BYTE +
    boxCount * 8 * COST_PER_BYTE +
    endBoxSize * COST_PER_BYTE +
    COST_PER_BOX +
    (8 + 8 + 1 + 8 + 32 + 8) * COST_PER_BYTE
  );
}

export function splitDataIntoBoxes(data: Buffer): Uint8Array[] {
  const numBoxes = Math.floor(data.byteLength / MAX_BOX_SIZE);
  const boxes: Uint8Array[] = [];
  for (let i = 0; i < numBoxes; i++) {
    boxes.push(new Uint8Array(data.subarray(i * MAX_BOX_SIZE, (i + 1) * MAX_BOX_SIZE)));
  }
  boxes.push(new Uint8Array(data.subarray(numBoxes * MAX_BOX_SIZE, data.byteLength)));
  return boxes;
}

export function splitBoxIntoChunks(box: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < box.byteLength; i += BYTES_PER_CALL) {
    chunks.push(box.subarray(i, i + BYTES_PER_CALL));
  }
  return chunks;
}

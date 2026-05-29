import { Address } from '@algorandfoundation/algokit-utils';

import { DidAlgoStorageClient } from './contracts/DidAlgoStorageClient';
import { MAX_BOX_SIZE } from './uploadDIDDocument';
import { DID_STATUS_READY } from './deleteDIDDocument';

/**
 * Read the on-chain DID Document published for a given public key from
 * the `DIDAlgoStorage` contract.
 *
 * The contract stores the document JSON spread across one or more
 * `dataBoxes` (keyed by `uint64` box index, each up to
 * {@link MAX_BOX_SIZE} bytes) plus a `metadata` box (keyed by the
 * public-key bytes encoded as an Algorand address) carrying the box
 * range and lifecycle status. This helper:
 *
 *   1. reads the metadata box,
 *   2. requires `status === READY` (an in-flight upload or in-flight
 *      delete returns `null` rather than a half-baked document),
 *   3. reads `[metadata.start .. metadata.end]` inclusive,
 *   4. concatenates and trims to `(boxCount - 1) * MAX_BOX_SIZE + endSize`,
 *   5. JSON-parses the result.
 *
 * Returns `null` for any of: missing metadata box, non-READY status,
 * missing data box in the declared range, or unparseable JSON. The
 * helper deliberately treats Algod 404s on the metadata box as a
 * normal "not published" result — matching `tryReadMetadata` in the
 * service layer.
 *
 * Throws only when the chain is unreachable or returns an unexpected
 * shape; callers should let those surface so the underlying outage is
 * reported instead of being masked as "DID not found".
 */
export async function resolveDIDDocument(
  appClient: DidAlgoStorageClient,
  pubKey: Uint8Array,
): Promise<Record<string, unknown> | null> {
  const pubKeyAddress = new Address(pubKey).toString();

  let metadata;
  try {
    metadata = await appClient.state.box.metadata.value(pubKeyAddress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/status\s*404/i.test(message) && /box not found/i.test(message)) {
      return null;
    }
    throw err;
  }
  if (!metadata) return null;
  if (Number(metadata.status) !== DID_STATUS_READY) return null;

  const start = BigInt(metadata.start);
  const end = BigInt(metadata.end);
  const endSize = Number(metadata.endSize);
  const boxCount = Number(end - start) + 1;
  if (boxCount < 1) return null;
  const totalSize = (boxCount - 1) * MAX_BOX_SIZE + endSize;

  const chunks: Buffer[] = [];
  for (let i = start; i <= end; i += 1n) {
    const box = await appClient.state.box.dataBoxes.value(i);
    if (!box) return null;
    chunks.push(Buffer.from(box));
  }
  const data = Buffer.concat(chunks).subarray(0, totalSize);

  try {
    return JSON.parse(data.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

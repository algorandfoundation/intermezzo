import { Address } from '@algorandfoundation/algokit-utils';
import { DidAlgoStorageClient, Metadata } from './contracts/DidAlgoStorageClient';

/**
 * Read the metadata box for a given raw ed25519 public key from the
 * `DIDAlgoStorage` contract.
 *
 * Returns `undefined` if no metadata box has been allocated for the
 * key (the legitimate "no document published" steady-state), and
 * rethrows any other unexpected error. The 404 "box not found"
 * response from algod surfaces as an Error whose message contains
 * `status 404` / `box not found`; that pair is treated as
 * "not present" rather than a failure.
 */
export async function tryReadMetadata(
  appClient: DidAlgoStorageClient,
  pubKey: Uint8Array,
): Promise<Metadata | undefined> {
  const pubKeyAddress = new Address(pubKey).toString();
  try {
    return await appClient.state.box.metadata.value(pubKeyAddress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/status\s*404/i.test(message) && /box not found/i.test(message)) {
      return undefined;
    }
    throw err;
  }
}

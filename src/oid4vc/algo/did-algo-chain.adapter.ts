import { Injectable } from '@nestjs/common';

import { DidService } from '../../did/did.service';
import { AlgoVaultTokenProvider } from './algo-vault-token.provider';
import type {
  DidAlgoChainReaderPort,
  DidAlgoChainWriterPort,
  DidAlgoPublishResult,
} from '../../../libs/credo-did-algo';

/**
 * Intermezzo's adapter binding the in‑repo `DidService` to the chain
 * ports exposed by `@algorandfoundation/credo-did-algo`.
 *
 * Implements both the reader and writer surfaces:
 *
 *   - {@link DidAlgoChainReaderPort.resolveDocument} delegates to
 *     `DidService.resolveOnChainDocument`, which reads the
 *     `DIDAlgoStorage` metadata + data boxes off chain. There is **no**
 *     in-memory DID Document cache; every call goes to the algod node.
 *   - {@link DidAlgoChainWriterPort.uploadDocument} calls
 *     `DidService.publishControlledDid` (the manager Vault key pays
 *     the on-chain fees and signs the box write).
 *   - {@link DidAlgoChainWriterPort.deleteDocument} calls
 *     `DidService.deleteControlledDid`; missing boxes are a best-effort
 *     no-op, which the port contract permits.
 */
@Injectable()
export class DidAlgoChainAdapter implements DidAlgoChainReaderPort, DidAlgoChainWriterPort {
  constructor(
    private readonly didService: DidService,
    private readonly tokenProvider: AlgoVaultTokenProvider,
  ) {}

  resolveDocument(did: string): Promise<Record<string, unknown> | null> {
    return this.didService.resolveOnChainDocument(did);
  }

  async uploadDocument(input: {
    controller: string;
    keyRef: unknown;
    publicKeyBase58: string;
    force?: boolean;
  }): Promise<DidAlgoPublishResult> {
    const vaultToken = await this.tokenProvider.getToken();
    // Decode the canonical public key out of the consumer's
    // `publicKeyBase58` so the chain publish doesn't need a second
    // Vault round-trip. `keyRef` is opaque to the package and to this
    // adapter — Intermezzo's manager signer is rebuilt from the
    // manager Vault key by `publishControlledDid` itself. Hosts on a
    // different KMS would route the keyRef through the
    // `credo-vault-wallet` signer instead.
    void input.keyRef;
    const publicKey = decodeBase58(input.publicKeyBase58);
    const result = await this.didService.publishControlledDid({
      controller: input.controller,
      publicKey,
      vaultToken,
      force: Boolean(input.force),
    });
    return {
      did: result.did,
      publicKeyBase58: input.publicKeyBase58,
      metadata: { txIds: result.txIds, controller: input.controller },
    };
  }

  async deleteDocument(input: { did: string; publicKeyBase58: string }): Promise<void> {
    const vaultToken = await this.tokenProvider.getToken();
    const publicKey = decodeBase58(input.publicKeyBase58);
    await this.didService.deleteControlledDid(publicKey, vaultToken);
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decode a base58btc string back to bytes. Mirror of the encoder in
 * `libs/credo-did-algo/multibase.ts`; kept here (not in the package)
 * because no package-side caller needs decoding today.
 */
function decodeBase58(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array();
  let zeros = 0;
  while (zeros < input.length && input[zeros] === BASE58_ALPHABET[0]) zeros++;

  const bytes: number[] = [];
  for (let i = zeros; i < input.length; i++) {
    const c = BASE58_ALPHABET.indexOf(input[i]);
    if (c < 0) throw new Error(`Invalid base58 character: ${input[i]}`);
    let carry = c;
    for (let j = 0; j < bytes.length; j++) {
      const v = bytes[j] * 58 + carry;
      bytes[j] = v & 0xff;
      carry = v >>> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + bytes.length - 1 - i] = bytes[i];
  return out;
}

import type { AgentContext, DidResolutionResult, DidResolver, ParsedDid } from '@credo-ts/core';
import {
  DidDocument as CredoDidDocument,
  JsonTransformer,
  VerificationMethod as CredoVerificationMethod,
} from '@credo-ts/core';

import { parseDidAlgo } from './identifier';
import { encodeEd25519PublicKeyMultibase } from './multibase';
import type { DidAlgoChainReaderPort } from './ports';

/**
 * Credo `DidResolver` for the `did:algo` method.
 *
 * The resolver **always** reads from chain via the supplied
 * {@link DidAlgoChainReaderPort}. It does not synthesise a DID
 * Document from the identifier — when there is no published box, the
 * resolver returns `notFound`. This guarantees a `did:algo` only ever
 * resolves to something a verifier can independently confirm against
 * the on-chain `DIDAlgoStorage` contract.
 *
 * Credo's own resolver-level caching is disabled (`allowsCaching =
 * false`, `allowsLocalDidRecord = false`) so the agent always asks
 * the method-level resolver rather than serving a stale document from
 * its dids repository. The chain remains the single source of truth.
 *
 * The resolver never signs, mutates or publishes. The registrar owns
 * those concerns.
 */
export class AlgoDidResolver implements DidResolver {
  readonly supportedMethods = ['algo'];
  readonly allowsCaching = false;
  readonly allowsLocalDidRecord = false;

  /**
   * Optional logger surface. We don't depend on `@nestjs/common.Logger`
   * directly so the package is consumable from non-Nest hosts; the
   * Intermezzo wrapper passes a Nest logger that satisfies this shape.
   */
  private readonly logger: { warn: (msg: string) => void; error: (msg: string) => void };

  constructor(
    private readonly chainReader: DidAlgoChainReaderPort,
    logger?: { warn?: (msg: string) => void; error?: (msg: string) => void },
  ) {
    this.logger = {
      warn: logger?.warn?.bind(logger) ?? (() => undefined),
      error: logger?.error?.bind(logger) ?? (() => undefined),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async resolve(_agentContext: AgentContext, did: string, _parsed: ParsedDid): Promise<DidResolutionResult> {
    try {
      const parsed = parseDidAlgo(did);
      if (!parsed) {
        return this.failure(`Unable to parse did:algo identifier: ${did}`, 'invalidDid');
      }
      const documentJson = await this.chainReader.resolveDocument(parsed.did);
      if (!documentJson) {
        return this.failure(`No on-chain DID Document published for ${did}`, 'notFound');
      }
      let didDocument: CredoDidDocument;
      try {
        didDocument = JsonTransformer.fromJSON(documentJson, CredoDidDocument);
      } catch (err) {
        const message = (err as Error).message;
        this.logger.error(`Failed to hydrate did:algo document for ${did}: ${message}`);
        return this.failure(`Malformed on-chain DID Document for ${did}: ${message}`, 'notFound');
      }
      return this.success(didDocument);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Failed to resolve ${did}: ${message}`);
      return this.failure(message, 'notFound');
    }
  }

  private success(didDocument: CredoDidDocument): DidResolutionResult {
    return {
      didResolutionMetadata: { contentType: 'application/did+ld+json' },
      didDocument,
      didDocumentMetadata: {},
    };
  }

  private failure(
    message: string,
    error: 'invalidDid' | 'notFound' | 'representationNotSupported',
  ): DidResolutionResult {
    return {
      didResolutionMetadata: { error, message },
      didDocument: null,
      didDocumentMetadata: {},
    };
  }
}

/**
 * Build a freshly constructed Credo `DidDocument` from raw key material.
 *
 * Used by the registrar at publish time so the local Credo `DidRecord`
 * is created with the same key encoding as the on-chain document. It
 * is **not** used by the resolver — resolution always goes to chain via
 * {@link DidAlgoChainReaderPort}. Pure / no I/O.
 */
export function buildCredoDidDocumentFromKey(did: string, publicKey: Uint8Array): CredoDidDocument {
  const keyId = `${did}#keys-1`;
  const verificationMethod = new CredoVerificationMethod({
    id: keyId,
    type: 'Ed25519VerificationKey2020',
    controller: did,
    publicKeyMultibase: encodeEd25519PublicKeyMultibase(publicKey),
  });
  return new CredoDidDocument({
    context: ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
    id: did,
    verificationMethod: [verificationMethod],
    authentication: [keyId],
    assertionMethod: [keyId],
  });
}

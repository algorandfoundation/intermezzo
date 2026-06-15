import { Injectable, Logger } from '@nestjs/common';
import type { AgentContext, DidResolutionResult, DidResolver, ParsedDid } from '@credo-ts/core';

import {
  AlgoDidResolver as PackageAlgoDidResolver,
  DID_ALGO_PATTERN,
  buildCredoDidDocumentFromKey,
} from '../../../libs/credo-did-algo';
import { DidAlgoChainAdapter } from './did-algo-chain.adapter';

/**
 * Nest-side wrapper around the host-agnostic `AlgoDidResolver` exported
 * by `@algorandfoundation/credo-did-algo`.
 *
 * The package resolver always reads the DID Document from chain via
 * the supplied `DidAlgoChainReaderPort` (here implemented by
 * `DidAlgoChainAdapter` → `DidService.resolveOnChainDocument`). The
 * wrapper exists to make the resolver injectable through Nest's DI
 * and to surface a Nest `Logger` for parity with the rest of the
 * OID4VC module.
 *
 * Credo-level caching is disabled on both the resolver
 * (`allowsCaching = false`) and the local-record fallback
 * (`allowsLocalDidRecord = false`) so the agent always asks the
 * method-level resolver — never a stale Askar `DidRecord` — for the
 * current state of the document. On-chain `DIDAlgoStorage` boxes are
 * the single source of truth.
 */
@Injectable()
export class AlgoDidResolver implements DidResolver {
  private readonly logger = new Logger(AlgoDidResolver.name);
  private readonly delegate: PackageAlgoDidResolver;

  readonly supportedMethods = ['algo'];
  readonly allowsCaching = false;
  readonly allowsLocalDidRecord = false;

  constructor(chainAdapter: DidAlgoChainAdapter) {
    this.delegate = new PackageAlgoDidResolver(chainAdapter, {
      warn: (msg) => this.logger.warn(msg),
      error: (msg) => this.logger.error(msg),
    });
  }

  resolve(agentContext: AgentContext, did: string, parsed: ParsedDid): Promise<DidResolutionResult> {
    return this.delegate.resolve(agentContext, did, parsed);
  }
}

// Re-exports for existing call sites that import these from the
// in-repo resolver file. They live in the package now; this keeps the
// migration zero-churn for `algo-did.registrar.ts` and any spec.
export { DID_ALGO_PATTERN, buildCredoDidDocumentFromKey };

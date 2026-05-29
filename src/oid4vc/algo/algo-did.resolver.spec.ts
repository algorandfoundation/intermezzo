import { AlgoDidResolver } from '../../../libs/credo-did-algo';
import type { DidAlgoChainReaderPort } from '../../../libs/credo-did-algo';

/**
 * The package `AlgoDidResolver` always reads from chain via the
 * supplied `DidAlgoChainReaderPort` — there is no self-describe
 * fallback and no host-side cache. The spec exercises that contract
 * with a mock reader.
 */
describe('AlgoDidResolver (package)', () => {
  const HEX = '0'.repeat(64);
  const DID = `did:algo:testnet:app:1234:${HEX}`;

  const buildResolver = (
    reader: Partial<DidAlgoChainReaderPort> = {},
  ): { resolver: AlgoDidResolver; resolveDocument: jest.Mock } => {
    const resolveDocument = jest.fn().mockResolvedValue(null);
    const r: DidAlgoChainReaderPort = { resolveDocument, ...reader };
    return { resolver: new AlgoDidResolver(r), resolveDocument };
  };

  it('rejects identifiers that do not match the did:algo shape', async () => {
    const { resolver, resolveDocument } = buildResolver();
    const r = await resolver.resolve({} as never, 'did:algo:not-real', { method: 'algo' } as never);
    expect(r.didDocument).toBeNull();
    expect(r.didResolutionMetadata.error).toBe('invalidDid');
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it('returns notFound when the chain reader reports no document', async () => {
    const { resolver, resolveDocument } = buildResolver();
    const r = await resolver.resolve({} as never, DID, { method: 'algo' } as never);
    expect(resolveDocument).toHaveBeenCalledWith(DID);
    expect(r.didDocument).toBeNull();
    expect(r.didResolutionMetadata.error).toBe('notFound');
  });

  it('hydrates the on-chain JSON document when present', async () => {
    const documentJson = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: DID,
      verificationMethod: [
        {
          id: `${DID}#keys-1`,
          type: 'Ed25519VerificationKey2020',
          controller: DID,
          publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        },
      ],
      authentication: [`${DID}#keys-1`],
      assertionMethod: [`${DID}#keys-1`],
    };
    const { resolver } = buildResolver({ resolveDocument: jest.fn().mockResolvedValue(documentJson) });
    const r = await resolver.resolve({} as never, DID, { method: 'algo' } as never);
    expect(r.didDocument?.id).toBe(DID);
    expect(r.didResolutionMetadata.contentType).toBe('application/did+ld+json');
  });

  it('disables Credo-level caching so every resolve hits the method resolver', () => {
    const { resolver } = buildResolver();
    expect(resolver.allowsCaching).toBe(false);
    expect(resolver.allowsLocalDidRecord).toBe(false);
  });
});

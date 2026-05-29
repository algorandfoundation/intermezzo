import { buildDidDocument, encodePublicKeyMultibase } from './did-document';

describe('did-document', () => {
  const PUB_KEY = new Uint8Array(32).fill(0x42);
  const DID = 'did:algo:localnet:app:1234:' + Buffer.from(PUB_KEY).toString('hex');

  it('builds a W3C-compatible document with the public key as authentication & assertion method', () => {
    const doc = buildDidDocument({ did: DID, publicKey: PUB_KEY });

    expect(doc.id).toBe(DID);
    expect(doc['@context']).toContain('https://www.w3.org/ns/did/v1');
    expect(doc['@context']).toContain('https://w3id.org/security/suites/ed25519-2020/v1');

    expect(doc.verificationMethod).toHaveLength(1);
    const [vm] = doc.verificationMethod;
    expect(vm.id).toBe(`${DID}#keys-1`);
    expect(vm.type).toBe('Ed25519VerificationKey2020');
    expect(vm.controller).toBe(DID);
    // multibase ed25519 keys are prefixed with 'z'
    expect(vm.publicKeyMultibase.startsWith('z')).toBe(true);

    expect(doc.authentication).toEqual([`${DID}#keys-1`]);
    expect(doc.assertionMethod).toEqual([`${DID}#keys-1`]);
    expect(doc.alsoKnownAs).toBeUndefined();
  });

  it('includes the linked wallet address in alsoKnownAs when provided', () => {
    const wallet = 'EKXHY5NSZLQAMWM5MVWSGRWQLIXXNVSZ6NFYIGEX2C2EBKIHFJO6NUFVSI';
    const doc = buildDidDocument({ did: DID, publicKey: PUB_KEY, linkedWalletAddress: wallet });
    expect(doc.alsoKnownAs).toEqual([`algorand:${wallet}`]);
  });

  it('does not promote the linked Algorand payment key to a verification method', () => {
    // The linked algorand payment key is correlation metadata only —
    // identity-purpose signatures (OID4VCI proofs, DID-Auth) bind to
    // the wallet's primary identity key (`#keys-2`), not the on-chain
    // payment account.
    const wallet = 'EKXHY5NSZLQAMWM5MVWSGRWQLIXXNVSZ6NFYIGEX2C2EBKIHFJO6NUFVSI';
    const doc = buildDidDocument({ did: DID, publicKey: PUB_KEY, linkedWalletAddress: wallet });

    expect(doc.verificationMethod).toHaveLength(1);
    expect(doc.verificationMethod[0].id).toBe(`${DID}#keys-1`);
    expect(doc.authentication).toEqual([`${DID}#keys-1`]);
    expect(doc.assertionMethod).toEqual([`${DID}#keys-1`]);
  });

  it('publishes the wallet identity public key as `#keys-2` when supplied', () => {
    const identityKey = new Uint8Array(32).fill(0x77);
    const doc = buildDidDocument({ did: DID, publicKey: PUB_KEY, identityPublicKey: identityKey });

    expect(doc.verificationMethod).toHaveLength(2);
    const [primary, identity] = doc.verificationMethod;
    expect(primary.id).toBe(`${DID}#keys-1`);
    expect(identity.id).toBe(`${DID}#keys-2`);
    expect(identity.type).toBe('Ed25519VerificationKey2020');
    expect(identity.controller).toBe(DID);
    expect(identity.publicKeyMultibase.startsWith('z')).toBe(true);
    // The identity key must differ from the user's vault `#keys-1` key.
    expect(identity.publicKeyMultibase).not.toBe(primary.publicKeyMultibase);

    expect(doc.authentication).toEqual([`${DID}#keys-1`, `${DID}#keys-2`]);
    expect(doc.assertionMethod).toEqual([`${DID}#keys-1`, `${DID}#keys-2`]);
  });

  it('combines identity key (`#keys-2`) with linked wallet (`alsoKnownAs`) without conflating them', () => {
    const identityKey = new Uint8Array(32).fill(0x77);
    const wallet = 'EKXHY5NSZLQAMWM5MVWSGRWQLIXXNVSZ6NFYIGEX2C2EBKIHFJO6NUFVSI';
    const doc = buildDidDocument({
      did: DID,
      publicKey: PUB_KEY,
      identityPublicKey: identityKey,
      linkedWalletAddress: wallet,
    });

    expect(doc.verificationMethod).toHaveLength(2);
    expect(doc.verificationMethod[1].id).toBe(`${DID}#keys-2`);
    expect(doc.alsoKnownAs).toEqual([`algorand:${wallet}`]);
  });

  it('omits alsoKnownAs when linkedWalletAddress is null/empty', () => {
    const docNull = buildDidDocument({ did: DID, publicKey: PUB_KEY, linkedWalletAddress: null });
    const docEmpty = buildDidDocument({ did: DID, publicKey: PUB_KEY, linkedWalletAddress: '' });
    expect(docNull.alsoKnownAs).toBeUndefined();
    expect(docEmpty.alsoKnownAs).toBeUndefined();
  });

  it('encodes ed25519 multibase deterministically (multicodec 0xed01 + base58btc)', () => {
    const a = encodePublicKeyMultibase(PUB_KEY);
    const b = encodePublicKeyMultibase(PUB_KEY);
    expect(a).toBe(b);
    // 32-byte key + 2-byte multicodec encoded as base58btc usually lands at 48 chars + the 'z' prefix.
    expect(a).toMatch(/^z[1-9A-HJ-NP-Za-km-z]+$/);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });
});

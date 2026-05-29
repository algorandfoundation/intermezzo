import { buildDidIdentifier, encodeUint64, genesisIdToNetwork } from './util';

describe('did/util', () => {
  describe('genesisIdToNetwork', () => {
    it.each([
      ['mainnet-v1.0', 'mainnet'],
      ['testnet-v1.0', 'testnet'],
      ['betanet-v1.0', 'betanet'],
      ['fnet-v1', 'fnet'],
      ['dockernet-v1', 'localnet'],
      ['sandnet-v1', 'localnet'],
      ['', 'localnet'],
      [undefined, 'localnet'],
    ])('%s -> %s', (input, expected) => {
      expect(genesisIdToNetwork(input as string | undefined)).toBe(expected);
    });

    it('passes through unrecognised genesis ids verbatim', () => {
      expect(genesisIdToNetwork('custom-net')).toBe('custom-net');
    });
  });

  describe('buildDidIdentifier', () => {
    it('renders the canonical did:algo:<network>:app:<app-id>:<hex-pubkey> form', () => {
      const pubKey = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
      const id = buildDidIdentifier('testnet', 12345n, pubKey);
      expect(id).toBe('did:algo:testnet:app:12345:deadbeef');
    });
  });

  describe('encodeUint64', () => {
    it('produces big-endian 8-byte buffers', () => {
      expect(Buffer.from(encodeUint64(0)).toString('hex')).toBe('0000000000000000');
      expect(Buffer.from(encodeUint64(1)).toString('hex')).toBe('0000000000000001');
      expect(Buffer.from(encodeUint64(0x0102030405060708n)).toString('hex')).toBe('0102030405060708');
    });

    it('rejects out-of-range values', () => {
      expect(() => encodeUint64(-1)).toThrow();
      expect(() => encodeUint64(2n ** 64n)).toThrow();
    });
  });
});

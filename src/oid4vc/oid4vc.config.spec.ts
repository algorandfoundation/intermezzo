import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Oid4vcConfig } from './oid4vc.config';

describe('Oid4vcConfig', () => {
  async function build(env: Record<string, string | undefined>): Promise<Oid4vcConfig> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        Oid4vcConfig,
        {
          provide: ConfigService,
          useValue: {
            get: <T>(key: string, def?: T): T => (env[key] !== undefined ? (env[key] as unknown as T) : (def as T)),
          },
        },
      ],
    }).compile();
    return moduleRef.get(Oid4vcConfig);
  }

  it('returns sensible defaults', async () => {
    const cfg = await build({});
    expect(cfg.label).toBe('intermezzo');
    expect(cfg.baseUrl).toBe('http://localhost:3000/v1');
    expect(cfg.issuerPath).toBe('/oid4vci');
    expect(cfg.verifierPath).toBe('/oid4vp');
    expect(cfg.issuerBaseUrl).toBe('http://localhost:3000/v1/oid4vci');
    expect(cfg.verifierBaseUrl).toBe('http://localhost:3000/v1/oid4vp');
    // The Express mount paths must reflect the absolute pathname Credo
    // advertises in offer/auth URIs — including the `/v1` prefix the
    // default base URL carries — otherwise wallets hit Nest's 404.
    expect(cfg.issuerMountPath).toBe('/v1/oid4vci');
    expect(cfg.verifierMountPath).toBe('/v1/oid4vp');
    expect(cfg.autoInit).toBe(true);
  });

  it('strips trailing slashes from base url and normalises paths', async () => {
    const cfg = await build({
      OID4VC_BASE_URL: 'https://wallet.example.com//',
      OID4VC_ISSUER_PATH: 'issuer/',
      OID4VC_VERIFIER_PATH: '/verifier/',
    });
    expect(cfg.baseUrl).toBe('https://wallet.example.com');
    expect(cfg.issuerPath).toBe('/issuer');
    expect(cfg.verifierPath).toBe('/verifier');
    expect(cfg.issuerBaseUrl).toBe('https://wallet.example.com/issuer');
    expect(cfg.issuerMountPath).toBe('/issuer');
    expect(cfg.verifierMountPath).toBe('/verifier');
  });

  it('derives mount paths from OID4VC_BASE_URL pathname (e.g. /v1 prefix)', async () => {
    const cfg = await build({
      OID4VC_BASE_URL: 'https://api.example.com/v1',
    });
    expect(cfg.issuerBaseUrl).toBe('https://api.example.com/v1/oid4vci');
    expect(cfg.issuerMountPath).toBe('/v1/oid4vci');
    expect(cfg.verifierMountPath).toBe('/v1/oid4vp');
  });

  it('honours OID4VC_AUTO_INIT=false', async () => {
    expect((await build({ OID4VC_AUTO_INIT: 'false' })).autoInit).toBe(false);
    expect((await build({ OID4VC_AUTO_INIT: '0' })).autoInit).toBe(false);
    expect((await build({ OID4VC_AUTO_INIT: 'true' })).autoInit).toBe(true);
  });

  describe('status lists', () => {
    it('derives status list URIs from the base URL, prefix included', async () => {
      const cfg = await build({});
      expect(cfg.statusListBaseUrl).toBe('http://localhost:3000/v1/credential/status/list');
      expect(cfg.statusListUri('default')).toBe('http://localhost:3000/v1/credential/status/list/default');
    });

    it('tracks a non-default base URL', async () => {
      const cfg = await build({ OID4VC_BASE_URL: 'https://api.example.com/v1/' });
      expect(cfg.statusListUri('default')).toBe('https://api.example.com/v1/credential/status/list/default');
    });

    it('warns when the base URL carries no path, because the API is served behind a global prefix', async () => {
      const cfg = await build({ OID4VC_BASE_URL: 'https://api.example.com' });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        // Still returns a URL — the warning exists so a misconfiguration is
        // visible before it is baked into issued credentials, not to block boot.
        expect(cfg.statusListUri('default')).toBe('https://api.example.com/credential/status/list/default');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no path segment'));
      } finally {
        warn.mockRestore();
      }
    });
  });
});

import * as crypto from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SDJwtVcInstance } from '@sd-jwt/sd-jwt-vc';
import * as request from 'supertest';

import { Oid4vcAgentProvider } from '../src/oid4vc/agent/oid4vc-agent.provider';
import { AlgoVaultTokenProvider } from '../src/oid4vc/algo/algo-vault-token.provider';
import { Oid4vcConfig } from '../src/oid4vc/oid4vc.config';
import { Oid4vcIssuanceSession } from '../src/oid4vc/entities/oid4vc-issuance-session.entity';
import { Oid4vcIssuanceSessionRepository } from '../src/oid4vc/sessions/vault-repository';
import { Oid4vcStatusController } from '../src/oid4vc/status/oid4vc-status.controller';
import { Oid4vcStatusService } from '../src/oid4vc/status/oid4vc-status.service';
import { StatusListRepository } from '../src/oid4vc/status/status-list.repository';
import { VaultService } from '../src/vault/vault.service';

const ISSUER_DID = 'did:algo:testnet:app:1:' + 'aa'.repeat(32);

/**
 * End-to-end proof that revocation actually takes effect.
 *
 * Unlike `app.e2e-spec.ts`, this suite stands alone: no Vault, no chain, no
 * separately running server. Vault KV is a `Map`, and Vault transit signing is
 * a real Ed25519 key from node's `crypto` — so the credential and the status
 * list are genuinely signed by the same key, which is what Credo requires.
 *
 * The credential is issued and verified with `SDJwtVcInstance`, the exact
 * library Credo delegates to. The status list is fetched over real HTTP from a
 * listening Nest app by `@sd-jwt`'s own default fetcher, so the media type and
 * the URL are exercised rather than stubbed.
 */
describe('Credential status list (e2e)', () => {
  let app: INestApplication;
  let statusService: Oid4vcStatusService;
  let sdjwt: SDJwtVcInstance;
  let publicKey: crypto.KeyObject;
  let baseUrl: string;

  beforeAll(async () => {
    const keyPair = crypto.generateKeyPairSync('ed25519');
    publicKey = keyPair.publicKey;

    // Vault KV as a map. Values are JSON round-tripped the way a real write
    // and read-back would be, so `undefined` fields really do disappear and
    // dates really do come back as strings.
    const kv = new Map<string, Record<string, unknown>>();
    const vault = {
      kvRead: async (path: string) => kv.get(path),
      kvWrite: async (path: string, data: Record<string, unknown>) => {
        kv.set(path, JSON.parse(JSON.stringify(data)));
      },
      kvDelete: async (path: string) => {
        kv.delete(path);
      },
      kvList: async (prefix: string) =>
        [...kv.keys()].filter((k) => k.startsWith(`${prefix}/`)).map((k) => k.slice(prefix.length + 1)),
      sign: async (_key: string, _path: string, data: Uint8Array) =>
        `vault:v1:${crypto.sign(null, Buffer.from(data), keyPair.privateKey).toString('base64')}`,
    } as unknown as VaultService;

    // Read lazily: the port is only known once the app is listening, and the
    // status URI embedded in credentials has to match it.
    baseUrl = 'http://127.0.0.1:0/v1';
    const configService = {
      get: <T>(key: string, fallback?: T) => (key === 'OID4VC_BASE_URL' ? (baseUrl as unknown as T) : fallback),
    } as unknown as ConfigService;

    const tokenProvider = { getToken: async () => 'vault-token' } as unknown as AlgoVaultTokenProvider;

    const moduleRef = await Test.createTestingModule({
      controllers: [Oid4vcStatusController],
      providers: [
        { provide: VaultService, useValue: vault },
        { provide: ConfigService, useValue: configService },
        { provide: AlgoVaultTokenProvider, useValue: tokenProvider },
        {
          provide: Oid4vcAgentProvider,
          useValue: {
            ensureIssuerDid: async () => ({ did: ISSUER_DID, verificationMethodId: `${ISSUER_DID}#keys-1` }),
          },
        },
        Oid4vcConfig,
        StatusListRepository,
        Oid4vcIssuanceSessionRepository,
        Oid4vcStatusService,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, stopAtFirstError: true }));
    // The revoke routes sit behind the global manager AuthGuard in production;
    // it is an APP_GUARD from AuthModule and is not mounted here. The
    // controller spec asserts the auth metadata separately.
    await app.listen(0);

    const { port } = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${port}/v1`;

    statusService = moduleRef.get(Oid4vcStatusService);

    sdjwt = new SDJwtVcInstance({
      signer: (data) => crypto.sign(null, Buffer.from(data), keyPair.privateKey).toString('base64url'),
      signAlg: 'EdDSA',
      verifier: (data, sig) => crypto.verify(null, Buffer.from(data), publicKey, Buffer.from(sig, 'base64url')),
      hasher: (data, alg) => crypto.createHash(alg.replace('-', '')).update(Buffer.from(data)).digest(),
      hashAlg: 'sha-256',
      saltGenerator: (length) => crypto.randomBytes(length).toString('hex'),
      // No `statusListFetcher` override: `@sd-jwt`'s default fetcher is used,
      // which requires the response to be `application/statuslist+jwt`.
    });
  });

  afterAll(async () => {
    await app.close();
  });

  /** Allocates an entry, records the session, and issues a credential against it. */
  async function issueCredential(sessionId: string): Promise<string> {
    const entry = await statusService.allocate();
    const sessions = app.get(Oid4vcIssuanceSessionRepository);
    await sessions.save({
      id: sessionId,
      statusListId: entry.listId,
      statusListIndex: entry.idx,
    } as Partial<Oid4vcIssuanceSession>);

    return sdjwt.issue({
      iss: ISSUER_DID,
      vct: 'device-attestation-credential',
      iat: Math.floor(Date.now() / 1000),
      status: { status_list: { uri: entry.uri, idx: entry.idx } },
    });
  }

  it('revokes one credential without touching the other', async () => {
    const credentialA = await issueCredential('session-a');
    const credentialB = await issueCredential('session-b');

    // 1. Both verify. The verifier fetches the list over HTTP from the app.
    await expect(sdjwt.verify(credentialA)).resolves.toBeDefined();
    await expect(sdjwt.verify(credentialB)).resolves.toBeDefined();

    // 2. The list is served publicly, with the media type the fetcher requires.
    const served = await request(app.getHttpServer()).get('/v1/credential/status/list/default').expect(200);
    expect(served.headers['content-type']).toBe('application/statuslist+jwt');
    expect(served.headers['cache-control']).toBe('no-store');

    // ...and signed by the same key as the credentials.
    const signingInput = served.text.slice(0, served.text.lastIndexOf('.'));
    const signature = Buffer.from(served.text.slice(served.text.lastIndexOf('.') + 1), 'base64url');
    expect(crypto.verify(null, Buffer.from(signingInput), publicKey, signature)).toBe(true);

    // 3. Revoke A over HTTP.
    await request(app.getHttpServer())
      .post('/v1/credential/status/revoke')
      .send({ sessionId: 'session-a', reason: 'device reported stolen' })
      .expect(201);

    // 4. The whole point: A now fails verification, B is unaffected.
    await expect(sdjwt.verify(credentialA)).rejects.toThrow('Status is not valid');
    await expect(sdjwt.verify(credentialB)).resolves.toBeDefined();

    // 5. And a revocation made in error can be undone.
    await request(app.getHttpServer())
      .post('/v1/credential/status/reactivate')
      .send({ sessionId: 'session-a' })
      .expect(201);

    await expect(sdjwt.verify(credentialA)).resolves.toBeDefined();
  });

  it('refuses to revoke a session that never redeemed an offer', async () => {
    const sessions = app.get(Oid4vcIssuanceSessionRepository);
    await sessions.save({ id: 'never-redeemed' } as Partial<Oid4vcIssuanceSession>);

    await request(app.getHttpServer())
      .post('/v1/credential/status/revoke')
      .send({ sessionId: 'never-redeemed' })
      .expect(404);
  });
});

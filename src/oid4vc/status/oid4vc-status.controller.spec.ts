import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { IS_PUBLIC_KEY } from '../../auth/constants';
import { Oid4vcStatusService } from './oid4vc-status.service';
import { Oid4vcStatusController } from './oid4vc-status.controller';

const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJkaWQ6YWxnbyJ9.c2ln';

describe('Oid4vcStatusController', () => {
  let app: INestApplication;
  let getStatusListJwt: jest.Mock;
  let revoke: jest.Mock;
  let reactivate: jest.Mock;

  beforeEach(async () => {
    getStatusListJwt = jest.fn(async () => TOKEN);
    // Arrays: a target can match more than one credential (a holder's whole
    // history), and all matched entries are flipped together.
    revoke = jest.fn(async () => [
      { listId: 'f538cd53-79e5-4877-b6c2-51c09c51f8ab', idx: 7, uri: 'https://host/v1/x' },
    ]);
    reactivate = jest.fn(async () => [
      { listId: 'f538cd53-79e5-4877-b6c2-51c09c51f8ab', idx: 7, uri: 'https://host/v1/x' },
    ]);

    const moduleRef = await Test.createTestingModule({
      controllers: [Oid4vcStatusController],
      providers: [
        {
          provide: Oid4vcStatusService,
          useValue: { getStatusListJwt, revoke, reactivate },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirrors `main.ts` so DTO validation behaves as it will in production.
    app.useGlobalPipes(new ValidationPipe({ transform: true, stopAtFirstError: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET list/:listId', () => {
    it('serves the token as application/statuslist+jwt and forbids caching', async () => {
      const response = await request(app.getHttpServer())
        .get('/credential/status/list/f538cd53-79e5-4877-b6c2-51c09c51f8ab')
        .expect(200);

      // Exact match, no `; charset=utf-8` suffix. `@sd-jwt`'s default fetcher
      // compares this header with strict equality, and Express would append a
      // charset to any string body sent the ordinary way — see the controller.
      expect(response.headers['content-type']).toBe('application/statuslist+jwt');
      // A cached list is a window in which a revoked credential still verifies.
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).toBe(TOKEN);
      expect(getStatusListJwt).toHaveBeenCalledWith('f538cd53-79e5-4877-b6c2-51c09c51f8ab');
    });

    it('is public — verifiers dereference it without credentials', () => {
      const isPublic = new Reflector().get<boolean>(
        IS_PUBLIC_KEY,
        Oid4vcStatusController.prototype.getStatusList as never,
      );
      expect(isPublic).toBe(true);
    });

    it('surfaces an unknown list as a 404', async () => {
      getStatusListJwt.mockRejectedValue(new NotFoundException('Status list nope does not exist'));

      await request(app.getHttpServer()).get('/credential/status/list/nope').expect(404);
    });
  });

  describe('revoke / reactivate', () => {
    const HOLDER_DID_KEY = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
    const URI = 'https://host/v1/credential/status/list/f538cd53-79e5-4877-b6c2-51c09c51f8ab';

    it('revokes by holderDidKey, with an optional reason and configuration filter', async () => {
      await request(app.getHttpServer())
        .post('/credential/status/revoke')
        .send({
          holderDidKey: HOLDER_DID_KEY,
          credentialConfigurationId: 'device-attestation-credential',
          reason: 'device reported stolen',
        })
        .expect(201);

      expect(revoke).toHaveBeenCalledWith({
        holderDidKey: HOLDER_DID_KEY,
        credentialConfigurationId: 'device-attestation-credential',
        reason: 'device reported stolen',
      });
    });

    it('revokes by uri + idx', async () => {
      await request(app.getHttpServer()).post('/credential/status/revoke').send({ uri: URI, idx: 7 }).expect(201);

      expect(revoke).toHaveBeenCalledWith({ uri: URI, idx: 7 });
    });

    it('reactivates by holderDidKey', async () => {
      await request(app.getHttpServer())
        .post('/credential/status/reactivate')
        .send({ holderDidKey: HOLDER_DID_KEY })
        .expect(201);

      expect(reactivate).toHaveBeenCalledWith({ holderDidKey: HOLDER_DID_KEY });
    });

    it('reactivates by uri + idx', async () => {
      await request(app.getHttpServer()).post('/credential/status/reactivate').send({ uri: URI, idx: 7 }).expect(201);

      expect(reactivate).toHaveBeenCalledWith({ uri: URI, idx: 7 });
    });

    it('rejects a body with neither addressing form', async () => {
      await request(app.getHttpServer()).post('/credential/status/revoke').send({}).expect(400);
      expect(revoke).not.toHaveBeenCalled();
    });

    it('rejects a leftover sessionId (no longer a valid form)', async () => {
      await request(app.getHttpServer()).post('/credential/status/revoke').send({ sessionId: 'session-a' }).expect(400);
      expect(revoke).not.toHaveBeenCalled();
    });

    it('rejects a malformed holderDidKey', async () => {
      await request(app.getHttpServer())
        .post('/credential/status/revoke')
        .send({ holderDidKey: 'not-a-did-key' })
        .expect(400);
      expect(revoke).not.toHaveBeenCalled();
    });

    it('rejects uri without idx', async () => {
      await request(app.getHttpServer()).post('/credential/status/revoke').send({ uri: URI }).expect(400);
      expect(revoke).not.toHaveBeenCalled();
    });

    // `''` used to read as "no filter" and silently widen the revocation to
    // every credential the holder holds.
    it('rejects an empty credentialConfigurationId rather than ignoring it', async () => {
      await request(app.getHttpServer())
        .post('/credential/status/revoke')
        .send({ holderDidKey: HOLDER_DID_KEY, credentialConfigurationId: '' })
        .expect(400);
      expect(revoke).not.toHaveBeenCalled();
    });

    it('rejects a negative idx', async () => {
      await request(app.getHttpServer()).post('/credential/status/revoke').send({ uri: URI, idx: -1 }).expect(400);
      expect(revoke).not.toHaveBeenCalled();
    });

    it('stays behind the global auth guard', () => {
      // Neither mutating route opts out, so both inherit the manager AuthGuard
      // that the host application mounts as an APP_GUARD.
      const reflector = new Reflector();
      expect(reflector.get(IS_PUBLIC_KEY, Oid4vcStatusController.prototype.revoke as never)).toBeUndefined();
      expect(reflector.get(IS_PUBLIC_KEY, Oid4vcStatusController.prototype.reactivate as never)).toBeUndefined();
    });
  });
});

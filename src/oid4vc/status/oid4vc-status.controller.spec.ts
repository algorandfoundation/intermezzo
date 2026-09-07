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
  let revokeBySessionId: jest.Mock;
  let reactivateBySessionId: jest.Mock;

  beforeEach(async () => {
    getStatusListJwt = jest.fn(async () => TOKEN);
    // Arrays: a session can hold an entry per credential it issued, and all
    // of them are flipped together.
    revokeBySessionId = jest.fn(async () => [{ listId: 'default', idx: 7, uri: 'https://host/v1/x' }]);
    reactivateBySessionId = jest.fn(async () => [{ listId: 'default', idx: 7, uri: 'https://host/v1/x' }]);

    const moduleRef = await Test.createTestingModule({
      controllers: [Oid4vcStatusController],
      providers: [
        {
          provide: Oid4vcStatusService,
          useValue: { getStatusListJwt, revokeBySessionId, reactivateBySessionId },
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
      const response = await request(app.getHttpServer()).get('/credential/status/list/default').expect(200);

      // Exact match, no `; charset=utf-8` suffix. `@sd-jwt`'s default fetcher
      // compares this header with strict equality, and Express would append a
      // charset to any string body sent the ordinary way — see the controller.
      expect(response.headers['content-type']).toBe('application/statuslist+jwt');
      // A cached list is a window in which a revoked credential still verifies.
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).toBe(TOKEN);
      expect(getStatusListJwt).toHaveBeenCalledWith('default');
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
    it('passes the session id and reason through', async () => {
      await request(app.getHttpServer())
        .post('/credential/status/revoke')
        .send({ sessionId: 'session-a', reason: 'device reported stolen' })
        .expect(201);

      expect(revokeBySessionId).toHaveBeenCalledWith('session-a', 'device reported stolen');
    });

    it('reactivates without a reason', async () => {
      await request(app.getHttpServer())
        .post('/credential/status/reactivate')
        .send({ sessionId: 'session-a' })
        .expect(201);

      expect(reactivateBySessionId).toHaveBeenCalledWith('session-a');
    });

    it('rejects a body with no session id', async () => {
      await request(app.getHttpServer()).post('/credential/status/revoke').send({}).expect(400);
      expect(revokeBySessionId).not.toHaveBeenCalled();
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

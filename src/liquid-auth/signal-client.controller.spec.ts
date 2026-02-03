import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SignalClientController } from './signal-client.controller';

describe('SignalClientController', () => {
  let controller: SignalClientController;
  let mockManager: any;

  beforeEach(() => {
    mockManager = {
      startOffer: jest.fn(),
      get: jest.fn(),
    };
    controller = new SignalClientController(mockManager);
  });

  test('start returns session shape when manager succeeds', async () => {
    const fakeSession = { requestId: 'r1', expiresAt: 12345, state: 'starting' };
    mockManager.startOffer.mockResolvedValueOnce(fakeSession);
    const result = await controller.start();
    expect(result).toEqual({
      requestId: fakeSession.requestId,
      expiresAt: fakeSession.expiresAt,
      status: fakeSession.state,
      origin: 'https://debug.liquidauth.com',
    });
  });

  test('start throws ServiceUnavailableException when manager fails', async () => {
    mockManager.startOffer.mockRejectedValueOnce(new Error('boom'));
    await expect(controller.start()).rejects.toThrow(ServiceUnavailableException);
  });

  test('status returns session metadata when found', async () => {
    const session = { requestId: 'r2', expiresAt: 1, state: 'active', url: 'u', lastActivity: 2, createdAt: 3 };
    mockManager.get.mockReturnValueOnce(session);
    const res = await controller.status('r2');
    expect(res).toEqual({
      requestId: session.requestId,
      expiresAt: session.expiresAt,
      status: session.state,
      origin: session.url,
      lastActivity: session.lastActivity,
      createdAt: session.createdAt,
    });
  });

  test('status throws NotFoundException when missing', async () => {
    mockManager.get.mockReturnValueOnce(undefined);
    await expect(controller.status('missing')).rejects.toThrow(NotFoundException);
  });
});

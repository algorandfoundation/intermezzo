import { AuthGuard } from './auth.gard';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

describe('AuthGuard', () => {
  let authGuard: AuthGuard;
  let jwtServiceMock: jest.Mocked<JwtService>;
  let reflectorMock: jest.Mocked<Reflector>;
  let configServiceMock: jest.Mocked<ConfigService>;

  beforeEach(() => {
    jwtServiceMock = {
      verifyAsync: jest.fn(),
    } as unknown as jest.Mocked<JwtService>;

    reflectorMock = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;

    configServiceMock = {
      get: jest.fn().mockReturnValue('test-secret'),
    } as unknown as jest.Mocked<ConfigService>;

    authGuard = new AuthGuard(jwtServiceMock, reflectorMock, configServiceMock);
  });

  const createExecutionContext = (headers: Record<string, string> = {}) =>
    ({
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
        getResponse: () => ({}),
      }),
    }) as ExecutionContext;

  describe('canActivate', () => {
    it('should return true for public routes', async () => {
      reflectorMock.getAllAndOverride.mockReturnValue(true);
      const context = createExecutionContext();

      const result = await authGuard.canActivate(context);

      expect(result).toBe(true);
      expect(reflectorMock.getAllAndOverride).toHaveBeenCalledWith('isPublicEndpoint', [null, null]);
    });

    it('should throw UnauthorizedException when no token is present', async () => {
      reflectorMock.getAllAndOverride.mockReturnValue(false);
      const context = createExecutionContext();

      await expect(authGuard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for invalid token format', async () => {
      reflectorMock.getAllAndOverride.mockReturnValue(false);
      const context = createExecutionContext({
        authorization: 'InvalidTokenFormat',
      });

      await expect(authGuard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for invalid token', async () => {
      reflectorMock.getAllAndOverride.mockReturnValue(false);
      jwtServiceMock.verifyAsync.mockRejectedValue(new Error('Invalid token'));
      const context = createExecutionContext({
        authorization: 'Bearer invalid-token',
      });

      await expect(authGuard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(jwtServiceMock.verifyAsync).toHaveBeenCalledWith('invalid-token', {
        secret: 'test-secret',
      });
    });

    it('should return true for valid token', async () => {
      reflectorMock.getAllAndOverride.mockReturnValue(false);
      jwtServiceMock.verifyAsync.mockResolvedValue({ vault_token: 'valid-vault-token' });
      const context = createExecutionContext({
        authorization: 'Bearer valid-token',
      });

      const result = await authGuard.canActivate(context);

      expect(result).toBe(true);
      expect(jwtServiceMock.verifyAsync).toHaveBeenCalledWith('valid-token', {
        secret: 'test-secret',
      });
    });
  });
});

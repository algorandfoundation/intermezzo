import { VaultService } from '../vault/vault.service';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { SignInResponseDto } from './sign-in.dto';
import { UnauthorizedException } from '@nestjs/common';

describe('AuthService', () => {
  let authService: AuthService;
  let vaultServiceMock: VaultService;
  let jwtServiceMock: JwtService;

  beforeEach(() => {
    vaultServiceMock = {
      checkToken: jest.fn(),
    } as any;
    jwtServiceMock = {
      signAsync: jest.fn(),
    } as any;

    authService = new AuthService(vaultServiceMock, jwtServiceMock);
  });

  it('signIn should return SignInResponseDto on successful authentication', async () => {
    const vaultToken = 'test_vault_token';
    (vaultServiceMock.checkToken as jest.Mock).mockResolvedValue(true);
    (jwtServiceMock.signAsync as jest.Mock).mockResolvedValue('test_access_token');

    const expectedResponse = new SignInResponseDto();
    expectedResponse.access_token = 'test_access_token';

    const result = await authService.signIn(vaultToken);
    expect(result).toEqual(expectedResponse);
    expect(vaultServiceMock.checkToken).toHaveBeenCalledWith(vaultToken);
    expect(jwtServiceMock.signAsync).toHaveBeenCalledWith({ vault_token: vaultToken });
  });

  it('signIn should throw UnauthorizedException if vault token is invalid', async () => {
    const vaultToken = 'invalid_vault_token';
    (vaultServiceMock.checkToken as jest.Mock).mockRejectedValue(new UnauthorizedException());

    await expect(authService.signIn(vaultToken)).rejects.toThrowError(UnauthorizedException);
    expect(vaultServiceMock.checkToken).toHaveBeenCalledWith(vaultToken);
    expect(jwtServiceMock.signAsync).not.toHaveBeenCalled();
  });
});

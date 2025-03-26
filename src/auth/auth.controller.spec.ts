import { Test, TestingModule } from '@nestjs/testing';
import { Auth } from './auth.controller';
import { AuthService } from './auth.service';
import { SignInRequestDto, SignInResponseDto } from './sign-in.dto';

describe('Auth Controller', () => {
  let authController: Auth;
  let authService: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [Auth],
      providers: [
        {
          provide: AuthService,
          useValue: {
            signIn: jest.fn(),
          },
        },
      ],
    }).compile();

    authController = module.get<Auth>(Auth);
    authService = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(authController).toBeDefined();
  });

  describe('signIn', () => {
    it('should call authService.signIn with correct parameters', async () => {
      const signInRequestDto: SignInRequestDto = { vault_token: 'test_token' };
      await authController.signIn(signInRequestDto);
      expect(authService.signIn).toHaveBeenCalledWith(signInRequestDto.vault_token);
    });

    it('should return the result of authService.signIn', async () => {
      const signInResponseDto: SignInResponseDto = { access_token: 'test_access_token' };
      (authService.signIn as jest.Mock).mockResolvedValue(signInResponseDto);
      const result = await authController.signIn({ vault_token: 'test_token' });
      expect(result).toBe(signInResponseDto);
    });
  });
});

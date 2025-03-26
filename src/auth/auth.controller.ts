import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './constants';
import { SignInRequestDto, SignInResponseDto } from './sign-in.dto';

@Controller()
export class Auth {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('auth/sign-in/')
  async signIn(@Body() signInParams: SignInRequestDto) {
    let signInResponse: SignInResponseDto = await this.authService.signIn(signInParams.vault_token);

    return signInResponse;
  }
}

import {
  Body,
  Controller,
  Post,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './constants';
import { SignInRequestDto, SignInResponseDto } from './sign-in.dto';
import { ApiCreatedResponse, ApiOperation, ApiUnauthorizedResponse } from "@nestjs/swagger";

@Controller()
export class Auth {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('auth/sign-in/')
  @ApiOperation({
    summary: 'Sign In',
    description: 'Endpoint to sign in with a `vault_token`',
  })
  @ApiCreatedResponse({
    description: 'The access token has been successfully created.',
    type: SignInResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async signIn(@Body() signInParams: SignInRequestDto) {
    let signInResponse: SignInResponseDto = await this.authService.signIn(signInParams.vault_token);

    return signInResponse;
  }
}

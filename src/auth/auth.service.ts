import { Injectable } from '@nestjs/common';
import { VaultService } from '../vault/vault.service';
import { JwtService } from '@nestjs/jwt';
import { SignInResponseDto } from './sign-in.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly vaultService: VaultService,
    private jwtService: JwtService,
  ) {}

  async signIn(vault_token: string): Promise<SignInResponseDto> {
    await this.vaultService.checkToken(vault_token);

    let payload = { vault_token: vault_token };
    const response = { access_token: await this.jwtService.signAsync(payload) };

    return response as SignInResponseDto;
  }
}

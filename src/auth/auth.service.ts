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

  /**
   * Sign in with a role ID and secret ID to get a vault token.
   * @param roleId The role ID for the Vault authentication.
   * @param secretId The secret ID for the Vault authentication.
   * @returns The vault token.
   */
  async signInWithRole(roleId: string, secretId: string): Promise<string> {
    const vault_token = await this.vaultService.getTokenWithRole(roleId, secretId);
    return vault_token
  }

  /**
   * Sign in with a vault token to get a JWT token.
   * @param vault_token The vault token for authentication.
   * @returns The JWT token.
   */
  async signIn(vault_token: string): Promise<SignInResponseDto> {
    await this.vaultService.checkToken(vault_token);

    let payload = { vault_token: vault_token };
    const response = { access_token: await this.jwtService.signAsync(payload) };

    return response as SignInResponseDto;
  }

  async authGithub(token: string): Promise<string> {
    const vault_token = await this.vaultService.authGithub(token);
    return vault_token
  }

}

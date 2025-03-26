import { IsNumber, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SignInRequestDto {
  @IsString()
  @ApiProperty({
    example: 'hvb.AAAAAQJ5tcbZ2....',
    description: 'A vault token produced by the hashicorp service',
  })
  vault_token: string;
}

export class SignInResponseDto {
  @IsNumber()
  @ApiProperty({
    example: 'eyJhbG....',
    description:
      'A JSON Web Token (JWT) that enables secure access to protected resources. This token includes encoded user information and is signed to ensure integrity.',
  })
  access_token: string;
}

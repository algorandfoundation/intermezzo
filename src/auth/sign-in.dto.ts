import { IsNumber, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SignInRequestDto {
  @IsString()
  @ApiProperty({
    example: 'hvb.AAAAAQJ5tcbZ2....',
  })
  vault_token: string;
}

export class SignInResponseDto {
  @IsNumber()
  @ApiProperty({
    example: 'eyJhbG....',
  })
  access_token: string;
}

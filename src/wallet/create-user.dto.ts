import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { AccountType } from '../vault/user-info.dto';

export class CreateUserDto {
  @IsString()
  @ApiProperty({
    example: '1234',
    description: 'The unique identifier of the User',
  })
  user_id: string;

  @IsOptional()
  @IsIn(['ed25519', 'falcon1024'])
  @ApiProperty({
    required: false,
    default: 'ed25519',
    enum: ['ed25519', 'falcon1024'],
    description:
      'The signature scheme backing the account. Omit for a standard **ed25519** account. ' +
      '`falcon1024` creates a post-quantum account, which cannot be changed afterwards — ' +
      'the two schemes derive different addresses, so an existing user cannot be converted.',
  })
  account_type?: AccountType;
}

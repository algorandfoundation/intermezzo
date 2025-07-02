import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class UserInfoResponseDto {
  @IsString()
  @ApiProperty({
    example: '1234',
    description: 'The unique identifier of the User',
  })
  user_id: string;

  @IsString()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
    description: 'The public address of the User',
  })
  public_address: string;

  @IsString()
  @ApiProperty({
    type: 'string',
    example: '1000000',
    description: 'The balance of Algorand held by the User in microAlgos',
  })
  algoBalance: string;
}

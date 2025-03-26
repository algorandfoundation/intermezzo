import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class UserInfoResponseDto {
  @IsString()
  user_id: string;

  @IsString()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
  })
  public_address: string;
}

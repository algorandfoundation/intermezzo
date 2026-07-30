import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ManagerAddressDto {
  @IsString()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
    description:
      'The public address of the manager. This is also the **Sponsor** address used by `POST /wallet/transactions/sponsor/`.',
  })
  public_address: string;
}

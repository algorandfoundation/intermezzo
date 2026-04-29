import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SponsorDetailDto {
  @IsString()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
    description:
      'The Algorand `public_address` of the **Sponsor** account. Clients MUST use this address as both the sender and receiver of the 0 ALGO sponsor fee transaction at index 0 of any sponsored transaction group.',
  })
  public_address: string;
}

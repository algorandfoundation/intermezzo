import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ManagerDetailDto {
  @IsString()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
    description: 'The public address of the manager',
  })
  public_address?: string;

  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        asset_id: {
          type: 'string',
          example: '123456789',
          description: 'The unique identifier of the asset',
        },
        asset_name: {
          type: 'string',
          example: 'Gold',
          description: 'The name of the asset',
        },
        asset_amount: {
          type: 'number',
          example: 1000,
          description: 'The amount of the asset held by the manager',
        },
      },
    },
    description: 'List of assets held by the manager',
  })
  assets: AssetHolding[];

  @IsString()
  @ApiProperty({
    type: 'string',
    example: '1000000',
    description: 'The balance of Algorand held by the manager in microAlgos',
  })  
  algoBalance?: string;
}

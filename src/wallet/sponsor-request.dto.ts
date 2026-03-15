import { IsArray, ArrayMinSize, IsOptional, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SponsorRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ApiProperty({
    required: true,
    description:
      'Array of msgpack-encoded transactions (base64-encoded for JSON transport). All transactions must belong to the same group and be unsigned.',
    example: ['gaR0eXBlo2ZlZV9wZXJfdHhuAaN0eG4Bo2Z2ZXIAAaNsdgE=', 'gaR0eXBlo2ZlZV9wZXJfdHhuAaN0eG4Bo2Z2ZXIAAaNsdgE='],
  })
  transactions: string[];

  @IsOptional()
  @IsNumber()
  @Min(1.0)
  @ApiProperty({
    description: 'Fee multiplier for safety margin (default: 1.0)',
    required: false,
    default: 1.0,
    example: 1.2,
  })
  feeMultiplier?: number;
}

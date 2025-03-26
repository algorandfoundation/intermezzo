import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAssetResponseDto {
  @IsString()
  @ApiProperty({
    example: 'QOOBRVQMX4HW5QZ2EGLQDQCQTKRF3UP3JKDGKYPCXMI6AVV35KQA',
  })
  transaction_id: string;
}

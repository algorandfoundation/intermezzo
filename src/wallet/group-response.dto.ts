import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GroupResponseDto {
  @IsString()
  @ApiProperty({
    example: 'QOOBRVQMX4HW5QZ2EGLQDQCQTKRF3UP3JKDGKYPCXMI6AVV35KQA',
    description: 'The group id of the transaction',
  })
  group_id: string;
}

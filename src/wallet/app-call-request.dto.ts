import { IsArray, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AppCallRequestDto {
  @IsString()
  @IsOptional()
  @ApiProperty({
    example: 'BYEB',
    description: 'The program to execute for all OnCompletes',
  })
  approvalProgram?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    example: 'BYEB',
    description: 'The program to execute for ClearState OnComplete',
  })
  clearProgram?: string;

  @IsNumber()
  @IsOptional()
  @ApiProperty({
    example: 1234,
    description: 'The id of the App',
  })
  appId?: number;

  @IsNumber()
  @IsOptional()
  @ApiProperty({
    example: 1,
    description: 'The maximum number of global byte slices',
  })
  globalByteSlices?: number;

  @IsNumber()
  @IsOptional()
  @ApiProperty({
    example: 1,
    description: 'The maximum number of global ints',
  })
  globalInts?: number;

  @IsNumber()
  @IsOptional()
  @ApiProperty({
    example: 1,
    description: 'The maximum number of local byte slices',
  })
  localByteSlices?: number;

  @IsNumber()
  @IsOptional()
  @ApiProperty({
    example: 1,
    description: 'The maximum number of local ints',
  })
  localInts?: number;

  @IsArray()
  @IsOptional()
  @ApiProperty({
    example: [1, 2],
    description: 'The asset to be passed to the app',
  })
  foreignAssets?: number[];

  @IsArray()
  @IsOptional()
  @ApiProperty({
    example: [1, 2],
    description:
      "Lists the applications in addition to the application-id whose global states may be accessed by this application's approval-program and clear-state-program. The access is read-only.",
  })
  foreignApps?: bigint[];

  @IsOptional()
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {
      name: 'abi_method_name',
      args: [
        {
          type: 'pay | keyreg | axfer | acfg| appl',
          value: null,
        },
        {
          type: 'uint64',
          value: 12345,
        },
        {
          type: 'address',
          value: 'V5LR6C5SVHBQY3SPTEPD5WEGNBBUDNEP2MSDIONQIODZXZHRMC6QF3CTZI',
        },
        {
          type: 'string',
          value: 'abcd',
        },
      ],
      returns: {
        type: 'void',
      },
    },
    description: 'The arguments to be passed to the app as a JSON object',
  })
  args?: Record<string, any>;

  @IsArray()
  @IsOptional()
  @ApiProperty({
    example: [1, 2],
    description:
      "List of accounts in addition to the sender that may be accessed from the application's approval-program and clear-state-program.",
  })
  foreignAccounts?: string[];

  // Boxes
  @IsArray()
  @IsOptional()
  @ApiProperty({
    example: [{ n: 'YWN0XwAAAAAAAATS' }],
    description: 'The boxes that should be made available for the runtime of the program.',
  })
  boxes?: Array<{ i: number; n: string }>;

  @IsNumber()
  @IsOptional()
  @ApiProperty({
    example: [0, 1, 2, 3, 4, 5],
    description:
      'An application transaction must indicate the action to be taken following the execution of its approvalProgram or clearStateProgram.',
  })
  onComplete?: number;

  @IsNumber()
  @IsOptional()
  @ApiProperty({
    example: 1000,
    description: 'The fee to be paid for the transaction. Fee should be in microAlgos.',
  })
  fee?: number;

  @IsString()
  @ApiProperty({
    example: '1234',
    description: 'The id of the User that is transferring Algos',
  })
  fromUserId: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    example: '9kykoZ1IpuOAqhzDgRVaVY2ME0ZlCNrUpnzxpXlEF/s=',
    description:
      'Optional 32-byte base64-encoded lease to prevent replay and conflicting transactions. Use a fixed value to ensure exclusivity. Generate with: Buffer.from(crypto.randomBytes(32)).toString("base64")',
  })
  lease?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  @ApiProperty({
    example: 'Note to all: notes are public',
    description: 'Optional public note to attach to transaction',
  })
  note?: string;
}

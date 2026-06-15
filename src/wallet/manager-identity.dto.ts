import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Request body for `POST /v1/wallet/manager/identity`.
 *
 * The deploy endpoint refuses to mint a new `DIDAlgoStorage` contract
 * when one is already configured for this process; pass `force: true`
 * to redeploy (key rotation, network switch). On force the manager's
 * existing DID-document box on the previous contract is deleted first
 * so its MBR is refunded back to the manager account.
 */
export class DeployManagerIdentityDto {
  @ApiPropertyOptional({
    description:
      'Set to `true` to redeploy `DIDAlgoStorage` when a contract is already configured. ' +
      "The previous contract's manager DID-document box is deleted first so its MBR is reclaimed; " +
      'the previous app account itself remains on chain (the contract has no `DeleteApplication` action).',
    default: false,
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/**
 * Manager identity response — exposes the issuer `did:algo` and its
 * resolved DID Document so wallets / partners can pin the issuer
 * without having to ship a `did:algo` resolver of their own.
 *
 * When no `DIDAlgoStorage` contract is yet deployed for the active
 * network, `GET /v1/wallet/manager/identity` responds with HTTP 404;
 * the manager can deploy a fresh contract (and provision its own DID
 * document on it) via `POST /v1/wallet/manager/identity`.
 */
export class ManagerIdentityDto {
  @ApiProperty({
    description: 'Always `true` on a successful response. `GET` returns HTTP 404 when no contract is deployed.',
    example: true,
  })
  deployed!: boolean;

  @ApiProperty({
    type: String,
    example: 'did:algo:dockernet:app:1002:9a2c…',
    description: 'The issuer `did:algo` controlled by the manager Vault key.',
  })
  did!: string;

  @ApiProperty({
    type: String,
    example: 'did:algo:dockernet:app:1002:9a2c…#keys-1',
    description: 'Canonical verification-method id used to sign issued credentials.',
  })
  verificationMethodId!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The resolved DID Document for the issuer. Sourced on-demand from the on-chain `DIDAlgoStorage` ' +
      'box via the agent resolver; no local cache.',
  })
  didDocument!: Record<string, unknown>;
  @ApiProperty({
    type: String,
    example: '1002',
    description: 'Numeric Algorand application id of the deployed `DIDAlgoStorage` contract backing this issuer DID.',
  })
  appId!: string;
  @ApiProperty({
    type: String,
    example: 'WYK7…',
    description: 'Algorand address of the `DIDAlgoStorage` application account holding the box storage MBR.',
  })
  appAddress!: string;
  @ApiProperty({
    type: String,
    example: '100000',
    description:
      'Current spendable balance of the application account, in microAlgos, queried from algod at request time.',
  })
  appBalance!: string;
}

/**
 * Response for the manager-deploy endpoint — confirms the new
 * `DIDAlgoStorage` contract was created and the manager's issuer DID
 * was published against it.
 */
export class DeployManagerIdentityResponseDto extends ManagerIdentityDto {
  @ApiProperty({
    description: 'Operation performed by the factory (`create`, `update`, `replace`, or `nothing`).',
    example: 'create',
  })
  operation!: string;

  @ApiProperty({
    type: [String],
    description:
      'Confirmed txids for the delete phase of the on-chain DID-document refresh (one per group, ' +
      'reclaiming the existing box MBR). Empty when no prior document existed on the contract.',
    example: [],
  })
  deleteTxIds!: string[];

  @ApiProperty({
    type: [String],
    description:
      'Confirmed txids for the upload phase of the on-chain DID-document publish (one per group). ' +
      'Empty when `skipped === true` (the on-chain document was already byte-identical).',
    example: ['RAQOJVMSUUJABZYLLU7C6VBYLTV4FEEQ242SKAOAGZ23XAO6AMXQ'],
  })
  uploadTxIds!: string[];

  @ApiProperty({
    type: Boolean,
    description:
      '`true` when the on-chain DID document was already byte-identical to the freshly-built one — ' +
      'no transactions were issued, no MBR was charged, no fees were paid. Useful for idempotent ' +
      'force-redeploys that may run repeatedly without on-chain churn.',
    example: false,
  })
  skipped!: boolean;

  @ApiProperty({
    type: String,
    description:
      'µAlgo MBR locked by the previously-published DID-document box, refunded to the manager on ' +
      'delete. `"0"` when no prior document existed.',
    example: '347600',
  })
  oldMbrMicroAlgos!: string;

  @ApiProperty({
    type: String,
    description:
      'µAlgo MBR required by the new DID-document box, paid by the manager on upload. ' +
      'When `skipped === true` this is informational only — no payment was made. ' +
      'The manager`s net out-of-pocket on a refresh is `newMbrMicroAlgos − oldMbrMicroAlgos` (plus fees).',
    example: '347600',
  })
  newMbrMicroAlgos!: string;
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiNotFoundResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { DidService, UserContractCreatePlan, UserDidUpdatePlan } from './did.service';
import { Public } from '../auth/constants';
import { CredentialAuthGuard } from '../auth/credential-auth.guard';
import type { CredentialAuthRequest } from '../auth/credential-auth.guard';
import { ManagerVaultTokenProvider } from '../auth/manager-vault-token.provider';
import {
  BuildUserContractCreateDto,
  BuildUserDidDocumentUpdateDto,
  SubmitUserContractCreateDto,
  SubmitUserDidDocumentUpdateDto,
} from './dto/user-did-update.dto';

interface UserDidEntry {
  didKey: string;
  did: string;
  appId: string;
  appAddress: string;
}

/** Express request augmented by the global manager `AuthGuard`. */
interface ManagerAuthedRequest {
  vault_token: string;
}

/**
 * Endpoints for the per-user `did:algo` registry.
 *
 * Authentication is split deliberately:
 *
 *   - **GETs (`identities`, `identities/:didKey`)** are gated by the global
 *     manager `AuthGuard` (`Authorization: Bearer <manager-JWT>`).
 *     The manager orchestrates listing and lookup.
 *
 *   - **`POST create/transactions`** and **`POST update/transactions`**
 *     are `@Public()` — the wallet drives both directly. The
 *     update-transactions route is gated by
 *     {@link CredentialAuthGuard} (device-attestation SD-JWT VC in the
 *     `X-Credential-Presentation` header) and is `@Public()` to opt
 *     out of the manager JWT guard. The wallet is the sole caller of
 *     this route: the credential identifies *which* `did:key` the txn
 *     groups should be built for, and the manager Vault Transit key
 *     pre-signs the MBR `pay` only because that proof-of-possession
 *     was presented. The submit route is also gated by
 *     {@link CredentialAuthGuard}: the transactions it broadcasts
 *     are already wallet-signed (and host-pre-signed at manager
 *     positions), but the credential is still required to identify
 *     the caller's `did:key` for the server-side app-id lookup.
 *     Manager-orchestrated DID-document publishes
 *     happen at onboarding time via `DidService.publishUncontrolledDid`,
 *     not through this route.
 */
@ApiTags('DID')
@ApiBearerAuth()
@Controller('did')
export class DidController {
  constructor(
    private readonly didService: DidService,
    private readonly managerToken: ManagerVaultTokenProvider,
  ) {}

  /**
   * List every user `did:key` that has a per-user `DIDAlgoStorage`
   * contract registered in Vault KV, together with the corresponding
   * `did:algo` identifier and contract address.
   */
  @Get('identities')
  @ApiOperation({
    summary: 'List every per-user did:algo registered in Vault KV',
    description:
      'Returns one entry per onboarded wallet `did:key`, with the matching `did:algo`, ' +
      '`DIDAlgoStorage` app id, and app account address. Authenticate with the manager JWT.',
  })
  async listIdentities(@Req() request: ManagerAuthedRequest): Promise<UserDidEntry[]> {
    return await this.didService.listUserDids(request.vault_token);
  }

  /**
   * Look up a single user record by `did:key`. Returns 404 when no
   * per-user contract has been provisioned for that key.
   */
  @Get('identities/:didKey')
  @ApiOperation({
    summary: 'Look up a single user did:algo by did:key',
  })
  @ApiNotFoundResponse({ description: 'No per-user did:algo registered for the supplied did:key.' })
  async getIdentity(@Param('didKey') didKey: string, @Req() request: ManagerAuthedRequest): Promise<UserDidEntry> {
    const entry = await this.didService.getUserDid(didKey, request.vault_token);
    if (!entry) {
      throw new NotFoundException(`No per-user did:algo registered for ${didKey}`);
    }
    return entry;
  }

  /**
   * Build (but do not sign or send) the single atomic group that
   * deploys a fresh per-user `DIDAlgoStorage` contract owned by the
   * credential-bound `did:key`. The wallet signs position 2 (the
   * `applicationCreate` txn); the host signs the manager-funded
   * `pay` positions only at submit time, after validating the
   * wallet-signed bytes byte-for-byte against the canonical bytes
   * the server just rebuilt.
   *
   * Authentication: SD-JWT VC device-attestation credential in
   * `X-Credential-Presentation`. The `did:key` that becomes the
   * contract creator is taken from the credential's `cnf.kid` —
   * there is no way for a caller to spoof a different owner.
   */
  @Post('create/transactions')
  @HttpCode(200)
  @Public()
  @UseGuards(CredentialAuthGuard)
  @ApiSecurity('x-credential-presentation')
  @ApiOperation({
    summary: 'Build the tx group to deploy a caller-owned did:algo contract',
    description:
      'Requires a verified device-attestation credential. Returns a single 3-txn atomic ' +
      'group: `[manager-funder pay, manager pay → user, user applicationCreate]`. The wallet ' +
      'is expected to sign only position 2 (the `appl` create), which makes its ' +
      '`did:key`-derived address the contract creator on chain. The two `pay` positions are ' +
      'left unsigned for the host to sign at submit time after byte-for-byte validation.',
  })
  async createTransactions(
    // Reserved for future options (e.g. dispenser overrides). Empty body is accepted.
    @Body() _body: BuildUserContractCreateDto,
    @Req() request: CredentialAuthRequest,
  ): Promise<UserContractCreatePlan> {
    const didKey = request.didKey!;
    const vaultToken = await this.managerToken.getToken();
    return await this.didService.buildUserContractCreate({ didKey, vaultToken });
  }

  /**
   * Broadcast a wallet-signed `applicationCreate` group produced by
   * {@link createTransactions}. The host rebuilds the expected
   * unsigned group from canonical inputs (the credential-bound
   * `did:key` is the only such input), validates every wallet-signed
   * position byte-for-byte, signs the manager-funded `pay` positions
   * via Vault Transit, and broadcasts. On confirmation it persists
   * the new app id to Vault KV and returns the new `did:algo`.
   *
   * Credential-gated: a wallet may only deploy a contract owned by
   * the `did:key` bound to its current device-attestation credential.
   */
  @Post('create/submit')
  @HttpCode(200)
  @Public()
  @UseGuards(CredentialAuthGuard)
  @ApiSecurity('x-credential-presentation')
  @ApiOperation({
    summary: 'Broadcast a wallet-signed create-app group and register the new did:algo',
    description:
      'Validates the wallet-signed `applicationCreate` against the canonical bytes the server ' +
      'just rebuilt, signs the manager-funded `pay` positions via Vault Transit, broadcasts ' +
      'the atomic group, persists the new app id to Vault KV, and returns the new `did:algo`.',
  })
  async createSubmit(
    @Body() body: SubmitUserContractCreateDto,
    @Req() request: CredentialAuthRequest,
  ): Promise<{ appId: string; appAddress: string; did: string; txId: string }> {
    const didKey = request.didKey!;
    const vaultToken = await this.managerToken.getToken();
    return await this.didService.submitUserContractCreate({
      didKey,
      signedTxns: body.signedTxns,
      vaultToken,
    });
  }

  /**
   * Build (but do not send) the atomic transaction groups required
   * to update the caller's on-chain DID document. The per-user
   * `DIDAlgoStorage` contract must already have been deployed via
   * `POST /did/create/{transactions,submit}`; this endpoint only
   * ever *updates* an existing document — it never deploys a new
   * contract.
   *
   * The caller is identified solely by the device-attestation
   * credential they present in `X-Credential-Presentation` — the
   * `did:key` extracted from the credential's `cnf.kid` is the
   * subject of the contract that will be mutated, and is also what
   * proves to the host that it is safe to attach the manager Vault
   * Transit pre-signature to the MBR `pay`. The host always
   * pre-signs the MBR `pay` on this route; every app-call is left
   * unsigned for the wallet to Ed25519-sign with its `did:key`.
   *
   * The supplied DID document **must** be owned by the credential-
   * bound `did:key`: its `id` is required to equal the
   * `did:algo:...` derived from that key and the user's app id.
   *
   * Each group in the response follows the standard wallet-connect
   * `signTransactions` contract:
   *
   * ```ts
   * async signTransactions(
   *   txnGroup: Uint8Array[],
   *   indexesToSign?: number[],
   * ): Promise<(Uint8Array | null)[]>
   * ```
   *
   * The wallet decodes `txnGroup` (base64) plus `indexesToSign`,
   * signs the listed positions with its `did:key`, and posts the
   * resulting `(Uint8Array | null)[]` back as `signedTxns` on the
   * submit endpoint — along with `preSigned` (echoed from the
   * `signed` field below). The host then merges the two arrays
   * index-wise before broadcast. Wire format per signed txn is the
   * Algorand `SignedTransaction` envelope:
   * `{ txn: <decoded txn>, sig: <64-byte ed25519 signature> }`,
   * msgpack-encoded.
   */
  @Post('update/transactions')
  @HttpCode(200)
  @Public()
  @UseGuards(CredentialAuthGuard)
  @ApiSecurity('x-credential-presentation')
  @ApiOperation({
    summary: 'Build tx groups to update the caller-owned did:algo document',
    description:
      'Requires a verified device-attestation credential in `X-Credential-Presentation`. The ' +
      "credential's bound `did:key` identifies which per-user `DIDAlgoStorage` contract is " +
      'mutated. The supplied DID document must be self-owned: its `id` must equal the ' +
      "`did:algo:...` derived from the credential-bound `did:key` and the user's app id. The " +
      'manager-role MBR `pay` is pre-signed by the Vault Transit key in-band; app-calls are ' +
      'returned unsigned for the wallet to Ed25519-sign with its `did:key`. Returns a flat list ' +
      'of atomic groups: every operation required to swap the on-chain document (`startDelete`, ' +
      '`deleteData×N`, `mbrPay+startUpload`, `upload×K`, `finishUpload`) is greedily packed ' +
      'into 16-txn groups; the on-chain contract reclaims the prior box MBR via inner refunds ' +
      'and locks in the new MBR via `mbrPayment`, so the caller pays only the net delta.',
  })
  @ApiNotFoundResponse({ description: 'No per-user did:algo registered for the credential-bound did:key.' })
  async updateTransactions(
    @Body() body: BuildUserDidDocumentUpdateDto,
    @Req() request: CredentialAuthRequest,
  ): Promise<UserDidUpdatePlan> {
    // `CredentialAuthGuard` populates `request.didKey` from the
    // verified credential's `cnf.kid`; the route is registered with
    // that guard so this is always set by the time we get here.
    const didKey = request.didKey!;
    const vaultToken = await this.managerToken.getToken();
    const plan = await this.didService.buildUserDidDocumentUpdate({
      didKey,
      document: body.document,
      vaultToken,
    });
    if (!plan) {
      throw new NotFoundException(`No per-user did:algo registered for ${didKey}`);
    }
    if (body.document) {
      // The wallet may only update *its own* DID document. Reject
      // any payload whose `id` doesn't match the canonical did:algo
      // derived from the credential-bound did:key + app id.
      const incomingId = (body.document as { id?: unknown }).id;
      if (typeof incomingId !== 'string' || incomingId !== plan.did) {
        throw new BadRequestException(
          `Supplied DID document id ${String(incomingId)} does not match caller-owned did ${plan.did}`,
        );
      }
    }
    return plan;
  }

  /**
   * Broadcast a user-signed DID-document update produced by
   * {@link updateTransactions}. The body mirrors the build
   * response shape but every transaction is now expected to be in
   * wire-format `SignedTransaction` bytes.
   *
   * This endpoint is `@Public()` (opting out of the manager JWT
   * guard) but is gated by {@link CredentialAuthGuard}: the wallet
   * presents the same device-attestation credential it used to
   * build the groups, and the credential-bound `did:key` is used
   * server-side to look up the user's app id from Vault KV for
   * the sanity check. The transactions themselves are already
   * Ed25519-signed by the wallet (and host-pre-signed at manager
   * positions), so algod and the on-chain contract are the sole
   * authority on whether the submission is accepted.
   */
  @Post('update/submit')
  @HttpCode(200)
  @Public()
  @UseGuards(CredentialAuthGuard)
  @ApiSecurity('x-credential-presentation')
  @ApiOperation({
    summary: 'Broadcast a user-signed did:algo document update',
    description:
      'Submits the signed atomic groups returned by `POST /did/update/transactions` to algod, ' +
      'in execution order. Each group is sent as its own on-chain atomic transaction group; ' +
      'the returned `txIds` are the confirmed transaction ids for the first txn of each group. ' +
      'Requires a verified device-attestation credential in `X-Credential-Presentation`; the ' +
      'credential-bound `did:key` identifies the per-user `DIDAlgoStorage` contract being ' +
      'mutated. The transactions themselves are already wallet-signed.',
  })
  @ApiNotFoundResponse({ description: 'No per-user did:algo registered for the credential-bound did:key.' })
  async submitUserDocumentUpdate(
    @Body() body: SubmitUserDidDocumentUpdateDto,
    @Req() request: CredentialAuthRequest,
  ): Promise<{ txIds: string[] }> {
    const didKey = request.didKey!;
    const vaultToken = await this.managerToken.getToken();
    return await this.didService.submitUserDidDocumentUpdate({
      didKey,
      document: body.document,
      groups: body.groups,
      vaultToken,
    });
  }
}

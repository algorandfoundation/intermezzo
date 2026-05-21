import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, verify as cryptoVerify, createPublicKey } from 'crypto';
import { DidService } from '../did/did.service';
import { decodeDidKeyEd25519 } from '../did/did-key';
import { Oid4vcIssuerService } from '../oid4vc/issuer/oid4vc-issuer.service';
import { Oid4vcIssuanceSession } from '../oid4vc/entities/oid4vc-issuance-session.entity';
import { ManagerVaultTokenProvider } from '../auth/manager-vault-token.provider';
import { VaultService } from '../vault/vault.service';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Vault KV-v2 folder under the platform mount (default `secret`)
 * where single-use attestation challenges live. Each challenge is a
 * KV entry keyed by its server-issued nonce. Challenges are deleted
 * outright on redemption / expiry — there is no audit trail beyond
 * Vault's own version history.
 */
export const ATTESTATION_CHALLENGES_KV_FOLDER = 'intermezzo/attestations/challenges';

/**
 * Credential configuration id minted by this service. Must be present
 * in `DEFAULT_CREDENTIAL_CONFIGURATIONS` on the issuer.
 */
export const DEVICE_ATTESTATION_CREDENTIAL_ID = 'device-attestation-credential';

/**
 * Shape of a stored challenge entry in Vault KV.
 */
interface ChallengeEntry extends Record<string, unknown> {
  didKey: string;
  /** ISO-8601 timestamp. */
  expiresAt: string;
  /** ISO-8601 timestamp; absent until the challenge is redeemed. */
  consumedAt?: string;
  /** ISO-8601 timestamp; recorded for the audit-of-last-resort. */
  issuedAt: string;
}

/**
 * Stateful, two-step device-attestation handshake. Owns the challenge
 * lifecycle and, on successful redemption, mints a per-user `did:algo`
 * (controlled by the caller's `did:key`) and creates an OID4VCI offer
 * for the {@link DEVICE_ATTESTATION_CREDENTIAL_ID} credential pinned
 * to the same `did:key`.
 *
 * No PII is persisted. The service stores only:
 *   - the public `did:key`,
 *   - a server-issued opaque nonce,
 *   - the challenge lifecycle timestamps,
 * and it stores them in **Vault KV-v2** under
 * {@link ATTESTATION_CHALLENGES_KV_FOLDER} — not in a sidecar
 * database — so the platform footprint is "Vault and an Algorand
 * node, nothing else".
 */
@Injectable()
export class LinkService {
  private readonly logger = new Logger(LinkService.name);

  constructor(
    private readonly didService: DidService,
    private readonly issuerService: Oid4vcIssuerService,
    private readonly managerToken: ManagerVaultTokenProvider,
    private readonly vaultService: VaultService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Validates the inbound device-attestation blob. This is the
   * single place in the service where device-platform attestation is
   * enforced — once the credential is minted in {@link redeem}, the
   * credential's signature transitively vouches for this check on
   * every subsequent wallet-authenticated call
   * (`CredentialAuthGuard`).
   *
   * Today's implementation is a placeholder: it requires a non-empty
   * opaque blob of reasonable length unless
   * `DEVICE_ATTESTATION=disabled` is set (local development only).
   * Production deployments must replace this method with a real App
   * Attest / Play Integrity verifier:
   *
   *   - iOS: validate Apple's App Attest assertion against the
   *     previously registered key id and the request nonce.
   *   - Android: verify Play Integrity verdicts via Google's API and
   *     pin the package + cert hash.
   */
  private verifyDeviceAttestation(deviceAttestation: string | undefined, nonce: string): void {
    const mode = this.config.get<string>('DEVICE_ATTESTATION') ?? 'placeholder';
    if (mode === 'disabled') {
      this.logger.warn(
        'DEVICE_ATTESTATION=disabled — accepting attestation redeem without device-attestation validation. ' +
          'Do not run like this in production.',
      );
      return;
    }
    if (!deviceAttestation || typeof deviceAttestation !== 'string' || deviceAttestation.length < 16) {
      throw new UnauthorizedException(
        'Missing or malformed deviceAttestation. Attestation redeem requires a signed device-platform ' +
          'attestation (Apple App Attest / Play Integrity).',
      );
    }
    // The `nonce` is in scope so a real verifier can pin the
    // attestation to the same challenge the wallet signed. The
    // placeholder body does not consume it; explicitly referencing it
    // keeps the parameter intentional under strict-no-unused.
    void nonce;
  }

  private kvPathFor(nonce: string): string {
    // The nonce is base64url (no `/`), so we can splice it directly
    // into the KV path without sanitisation.
    return `${ATTESTATION_CHALLENGES_KV_FOLDER}/${nonce}`;
  }

  /**
   * Mints a single-use challenge bound to the caller's `did:key`.
   * Also opportunistically prunes expired entries so the KV folder
   * doesn't grow unbounded under load.
   */
  async issueChallenge(didKey: string): Promise<{ nonce: string; expiresAt: Date }> {
    if (!didKey.startsWith('did:key:')) {
      throw new BadRequestException('Caller did:key is required to issue a challenge');
    }
    const token = await this.managerToken.getToken();
    await this.pruneExpired(token);
    const nonce = randomBytes(32).toString('base64url');
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
    const entry: ChallengeEntry = {
      didKey,
      expiresAt: expiresAt.toISOString(),
      issuedAt: issuedAt.toISOString(),
    };
    await this.vaultService.kvWrite(this.kvPathFor(nonce), entry, token);
    this.logger.log(`attestation: issued challenge didKey=${didKey} expiresAt=${expiresAt.toISOString()}`);
    return { nonce, expiresAt };
  }

  /**
   * Verifies a signed challenge, mints a per-user `did:algo`, and
   * creates the OID4VCI offer. Returns the offer URI so the wallet
   * can immediately redeem it without a second round-trip.
   */
  async redeem(input: {
    didKey: string;
    nonce: string;
    signatureB64: string;
    deviceAttestation?: string;
  }): Promise<{ issuanceSession: Oid4vcIssuanceSession }> {
    const { didKey, nonce, signatureB64, deviceAttestation } = input;
    this.verifyDeviceAttestation(deviceAttestation, nonce);
    const token = await this.managerToken.getToken();
    const path = this.kvPathFor(nonce);
    const entry = await this.vaultService.kvRead<ChallengeEntry>(path, token);
    if (!entry) throw new NotFoundException('Unknown attestation challenge');
    if (entry.didKey !== didKey) {
      throw new BadRequestException('Challenge belongs to a different did:key');
    }
    if (entry.consumedAt) {
      throw new BadRequestException('Challenge has already been consumed');
    }
    const expiresAt = new Date(entry.expiresAt);
    if (expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Challenge has expired');
    }

    let publicKey: Uint8Array;
    try {
      publicKey = decodeDidKeyEd25519(didKey);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const signature = Buffer.from(signatureB64, 'base64');
    const verified = cryptoVerify(
      null,
      Buffer.from(nonce, 'utf8'),
      { key: spkiFromEd25519(publicKey), format: 'der', type: 'spki' },
      signature,
    );
    if (!verified) {
      throw new BadRequestException('Challenge signature does not verify against the caller did:key');
    }

    // Mark consumed *before* the chain write so a partial failure
    // does not let the same nonce be replayed against a different
    // outcome. The caller can simply request a fresh challenge.
    const consumed: ChallengeEntry = { ...entry, consumedAt: new Date().toISOString() };
    await this.vaultService.kvWrite(path, consumed, token);

    // Attestation is now a pure credential-issuance handshake. The
    // on-chain `DIDAlgoStorage` contract is deployed lazily by the
    // wallet itself via `POST /v1/did/create/{transactions,submit}`
    // (creator = the user's `did:key`-derived address; the host only
    // sponsors fees and account min-balance). That decision pins
    // signing authority for every subsequent write to the wallet
    // alone, with no manager-side capability over the resulting DID.
    const attestedAt = new Date().toISOString();
    this.logger.log(`attestation: redeemed challenge didKey=${didKey}`);

    const issuanceSession = await this.issuerService.createOffer({
      credentialConfigurationIds: [DEVICE_ATTESTATION_CREDENTIAL_ID],
      holderDidKey: didKey,
      issuanceMetadata: {
        did_key: didKey,
        attested_at: attestedAt,
      },
    });

    // Best-effort cleanup: the challenge has been redeemed, its row
    // serves no further purpose. Failures are non-fatal — `pruneExpired`
    // will sweep it on the next `issueChallenge`.
    try {
      await this.vaultService.kvDelete(path, token);
    } catch (e) {
      this.logger.warn(`attestation: post-redeem KV cleanup failed: ${(e as Error).message}`);
    }

    return { issuanceSession };
  }

  /**
   * Best-effort cleanup of stale challenges. Runs inline on every
   * `issueChallenge`; we list the folder, read each entry, and delete
   * anything past its `expiresAt`. The folder is expected to stay
   * small because every entry has a 5-minute TTL.
   */
  private async pruneExpired(token: string): Promise<void> {
    try {
      const nonces = await this.vaultService.kvList(ATTESTATION_CHALLENGES_KV_FOLDER, token);
      const now = Date.now();
      await Promise.all(
        nonces.map(async (nonce) => {
          const path = this.kvPathFor(nonce);
          try {
            const entry = await this.vaultService.kvRead<ChallengeEntry>(path, token);
            if (!entry) return;
            const expiresAt = new Date(entry.expiresAt).getTime();
            if (Number.isFinite(expiresAt) && expiresAt < now - CHALLENGE_TTL_MS) {
              await this.vaultService.kvDelete(path, token);
            }
          } catch (e) {
            this.logger.warn(`attestation: prune failed for ${nonce}: ${(e as Error).message}`);
          }
        }),
      );
    } catch (e) {
      this.logger.warn(`attestation: pruning expired challenges failed: ${(e as Error).message}`);
    }
  }
}

function spkiFromEd25519(rawPublicKey: Uint8Array): Buffer {
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPublicKey)]);
  createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return spki;
}

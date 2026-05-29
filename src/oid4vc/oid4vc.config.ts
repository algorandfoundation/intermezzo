import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Centralised configuration for the OID4VC module.
 *
 * Reads from the existing Nest `ConfigService`/env so that the rest of the app
 * can stay agnostic of how Credo expects its configuration.
 *
 * Env vars (all optional, sensible defaults provided for local dev):
 * - OID4VC_LABEL              Human readable agent label                         (default: `intermezzo`)
 * - OID4VC_BASE_URL           Public base URL of this service (no trailing /)   (default: `http://localhost:3000/v1`)
 * - OID4VC_WALLET_ID          Askar wallet id                                    (default: `intermezzo`)
 * - OID4VC_WALLET_KEY         Askar wallet master key                            (default: `pawn-oid4vc-key`)
 * - OID4VC_ISSUER_PATH        URL path mounted for OID4VCI endpoints             (default: `/oid4vci`)
 * - OID4VC_VERIFIER_PATH      URL path mounted for OID4VP endpoints              (default: `/oid4vp`)
 * - OID4VC_ISSUER_DISPLAY_NAME    Display name for credential issuer             (default: `Algorand Foundation Rewards`)
 * - OID4VC_AUTO_INIT          Initialize agent on Nest bootstrap (true|false)    (default: `true`)
 * - OID4VC_MANAGER_USER_ID    Vault transit key name for the manager identity    (default: `VAULT_MANAGER_KEY` or `manager`)
 * - CREDO_LOG_LEVEL           Verbosity of the Credo agent's internal logger     (default: `debug`)
 *                             One of: test, trace, debug, info, warn, error, fatal, off.
 *                             Use `trace` to surface full request/response bodies
 *                             when debugging silent OID4VCI/OID4VP 500s — the
 *                             Credo Express routers are mounted outside Nest's
 *                             interceptor pipeline, so this is the only knob
 *                             that turns them into visible log output.
 *
 * On `OID4VC_MANAGER_USER_ID`: the OID4VC issuer DID is the manager's
 * `did:algo`. Using a dedicated env var (instead of just reading
 * `VAULT_MANAGER_KEY`) lets deployments point the OID4VC subsystem at a
 * separate manager identity — for example, when issuing credentials under a
 * sub-tenant key without granting that key the broader manager-policy
 * privileges. The default falls back to `VAULT_MANAGER_KEY` so existing
 * single-tenant deployments work unchanged.
 */
@Injectable()
export class Oid4vcConfig {
  private readonly logger = new Logger(Oid4vcConfig.name);

  constructor(private readonly config: ConfigService) {}

  get label(): string {
    return this.config.get<string>('OID4VC_LABEL', 'intermezzo');
  }

  get baseUrl(): string {
    let url = this.config.get<string>('OID4VC_BASE_URL', 'http://localhost:3000/v1').trim();
    if (!/^https?:\/\//i.test(url)) {
      this.logger.warn(
        `OID4VC_BASE_URL "${url}" is missing a scheme; defaulting to http://. Set the full URL (e.g. http://192.168.1.115:3000/v1) to silence this warning.`,
      );
      url = `http://${url}`;
    }
    return url.replace(/\/+$/, '');
  }

  get walletId(): string {
    return this.config.get<string>('OID4VC_WALLET_ID', 'intermezzo');
  }

  get walletKey(): string {
    const key = this.config.get<string>('OID4VC_WALLET_KEY', 'pawn-oid4vc-key');
    if (key === 'pawn-oid4vc-key') {
      this.logger.warn('OID4VC_WALLET_KEY is using the default development value. Set a secret in production.');
    }
    return key;
  }

  get issuerPath(): string {
    return this.normalisePath(this.config.get<string>('OID4VC_ISSUER_PATH', '/oid4vci'));
  }

  get verifierPath(): string {
    return this.normalisePath(this.config.get<string>('OID4VC_VERIFIER_PATH', '/oid4vp'));
  }

  get issuerBaseUrl(): string {
    return `${this.baseUrl}${this.issuerPath}`;
  }

  get verifierBaseUrl(): string {
    return `${this.baseUrl}${this.verifierPath}`;
  }

  /**
   * Express mount path (URL pathname portion of {@link issuerBaseUrl}) at
   * which the Credo OID4VCI router must be mounted in {@link main.ts}.
   *
   * `issuerPath` alone is *not* a safe mount point: `OID4VC_BASE_URL` is
   * permitted to include a path prefix (e.g. `http://localhost:3000/v1`),
   * and Credo bakes the absolute `issuerBaseUrl` into the credential offer
   * URIs it emits. If we mounted the router at just `/oid4vci` while the
   * advertised offer URI is `/v1/oid4vci/...`, wallets would hit a 404
   * from Nest's fallback. Deriving the mount path from the pathname of
   * the absolute base URL keeps the mount in lockstep with what Credo
   * actually advertises.
   */
  get issuerMountPath(): string {
    return this.toMountPath(this.issuerBaseUrl);
  }

  /**
   * Express mount path for the Credo OID4VP verifier router. See
   * {@link issuerMountPath} for the rationale.
   */
  get verifierMountPath(): string {
    return this.toMountPath(this.verifierBaseUrl);
  }

  private toMountPath(absoluteUrl: string): string {
    try {
      const pathname = new URL(absoluteUrl).pathname.replace(/\/+$/, '');
      return pathname || '/';
    } catch {
      // Should not happen: `baseUrl` already enforces a scheme above.
      return this.issuerPath;
    }
  }

  get issuerDisplayName(): string {
    return this.config.get<string>('OID4VC_ISSUER_DISPLAY_NAME', 'Algorand Foundation Rewards');
  }

  get autoInit(): boolean {
    const v = this.config.get<string>('OID4VC_AUTO_INIT', 'true');
    return v !== 'false' && v !== '0';
  }

  /**
   * Vault transit key name for the manager (the platform's root identity).
   * The OID4VC issuer DID is the manager's on-chain `did:algo`, so this is
   * also the userId we publish/look up under {@link DidService}.
   */
  get managerUserId(): string {
    return this.config.get<string>('OID4VC_MANAGER_USER_ID', this.config.get<string>('VAULT_MANAGER_KEY', 'manager'));
  }

  /**
   * Vault transit engine path the manager's signing key lives under
   * (e.g. `pawn/managers`). The OID4VC issuer DID is anchored against
   * this path — *not* the users path — because the manager already has
   * an Ed25519 transit key there that the rest of the platform uses for
   * Algorand transactions and that the on-chain DID document must
   * reference (so credential signatures resolve to the same key the
   * verifier sees on chain).
   */
  get managerTransitPath(): string {
    return this.config.get<string>('VAULT_TRANSIT_MANAGERS_PATH', 'pawn/managers');
  }

  private normalisePath(path: string): string {
    if (!path.startsWith('/')) path = `/${path}`;
    return path.replace(/\/+$/, '');
  }
}

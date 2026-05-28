import { JwaSignatureAlgorithm } from '@credo-ts/core';
import { OpenId4VciCredentialConfigurationsSupported, OpenId4VciCredentialFormatProfile } from '@credo-ts/openid4vc';

/**
 * Default credential configurations exposed by this issuer.
 *
 * A dedicated `device-attestation-credential` SD-JWT VC issued by the
 * manager to bind the wallet-local `did:key` to the on-chain `did:algo`.
 *
 * Kept in its own module so consumers can import the default set
 * without pulling in `Oid4vcIssuerService` (and the agent provider
 * graph behind it).
 */
export const DEFAULT_CREDENTIAL_CONFIGURATIONS: OpenId4VciCredentialConfigurationsSupported = {
  'device-attestation-credential': {
    format: OpenId4VciCredentialFormatProfile.SdJwtVc,
    vct: 'device-attestation-credential',
    cryptographic_binding_methods_supported: ['did:key', 'did:algo'],
    credential_signing_alg_values_supported: [JwaSignatureAlgorithm.EdDSA],
    scope: 'device_attestation_credential',
  },
};

/**
 * Vault KV-v2 folder under the platform mount where dynamic
 * credential configurations are stored.
 */
export const CREDENTIAL_CONFIGURATIONS_KV_FOLDER = 'intermezzo/oid4vc/credential-configurations';

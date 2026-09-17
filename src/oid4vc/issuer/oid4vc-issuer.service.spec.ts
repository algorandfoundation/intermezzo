import { ConfigService } from '@nestjs/config';
import { OpenId4VciCredentialRequestToCredentialMapper } from '@credo-ts/openid4vc';

import { Oid4vcAgentProvider } from '../agent/oid4vc-agent.provider';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';
import { Oid4vcConfig } from '../oid4vc.config';
import { VaultService } from '../../vault/vault.service';
import { Oid4vcIssuanceSessionRepository } from '../sessions/vault-repository';
import { Oid4vcStatusService } from '../status/oid4vc-status.service';
import { Oid4vcIssuerService } from './oid4vc-issuer.service';

const ISSUER_DID = 'did:algo:testnet:app:1:' + 'aa'.repeat(32);
const HOLDER_DID_KEY = 'did:key:z6MkExampleHolderKey';
const LIST_ID = 'f538cd53-79e5-4877-b6c2-51c09c51f8ab';
const LIST_URI = `http://localhost:3000/v1/credential/status/list/${LIST_ID}`;

/**
 * The mapper is private and installed on the agent provider during
 * `onModuleInit`, so tests capture it the way Credo receives it.
 */
describe('Oid4vcIssuerService credential mapper', () => {
  let mapper: OpenId4VciCredentialRequestToCredentialMapper;
  let findOneBy: jest.Mock;
  let save: jest.Mock;
  let allocate: jest.Mock;
  let isConfigured: jest.Mock;
  let kvList: jest.Mock;
  let kvRead: jest.Mock;

  beforeEach(async () => {
    findOneBy = jest.fn(async () => ({ id: 'local-session-1', credoIssuanceSessionId: 'credo-session-1' }));
    save = jest.fn(async (entity: Record<string, unknown>) => entity);
    allocate = jest.fn(async () => ({ listId: LIST_ID, idx: 7, uri: LIST_URI }));
    // Defaults only, unless a test opts into dynamic Vault configurations.
    isConfigured = jest.fn(() => false);
    kvList = jest.fn(async () => []);
    kvRead = jest.fn(async () => undefined);

    let captured: OpenId4VciCredentialRequestToCredentialMapper | undefined;
    const service = new Oid4vcIssuerService(
      {
        setCredentialMapper: (m: OpenId4VciCredentialRequestToCredentialMapper) => {
          captured = m;
        },
        ensureIssuerDid: jest.fn(async () => ({
          did: ISSUER_DID,
          verificationMethodId: `${ISSUER_DID}#keys-1`,
        })),
      } as unknown as Oid4vcAgentProvider,
      // OID4VC_AUTO_INIT=false so `onModuleInit` installs the mapper without
      // trying to reach Credo or the chain.
      new Oid4vcConfig({
        get: <T>(key: string, d?: T) => (key === 'OID4VC_AUTO_INIT' ? ('false' as unknown as T) : d),
      } as unknown as ConfigService),
      { findOneBy, save } as unknown as Oid4vcIssuanceSessionRepository,
      { kvList, kvRead } as unknown as VaultService,
      { isConfigured, getToken: jest.fn(async () => 'vault-token') } as unknown as AlgoVaultTokenProvider,
      { allocateForSession: allocate } as unknown as Oid4vcStatusService,
    );

    await service.onModuleInit();
    mapper = captured as OpenId4VciCredentialRequestToCredentialMapper;
    expect(mapper).toBeDefined();
  });

  function issue(configurationId: string, issuanceMetadata: Record<string, unknown>) {
    return mapper({
      credentialConfigurationIds: [configurationId],
      issuanceSession: { id: 'credo-session-1', issuanceMetadata },
      holderBinding: { method: 'did', didUrl: HOLDER_DID_KEY },
    } as never);
  }

  /** Registers a `jwt_vc_json` configuration as if it came from Vault KV. */
  function withDynamicJwtVcConfiguration() {
    isConfigured.mockReturnValue(true);
    kvList.mockResolvedValue(['legacy-jwt-vc']);
    kvRead.mockResolvedValue({ format: 'jwt_vc_json' });
  }

  describe('SD-JWT VC', () => {
    it('embeds the allocated status entry and records where it lives', async () => {
      const signed = (await issue('device-attestation-credential', {
        _holderDidKey: HOLDER_DID_KEY,
        tier: 'gold',
      })) as never as { payload: Record<string, unknown>; disclosureFrame: { _sd: string[] } };

      expect(signed.payload).toMatchObject({
        vct: 'device-attestation-credential',
        tier: 'gold',
        status: { status_list: { uri: LIST_URI, idx: 7 } },
      });

      expect(allocate).toHaveBeenCalledWith('credo-session-1');
      expect(save).not.toHaveBeenCalled();
    });

    it('keeps `status` out of the disclosure frame', async () => {
      const signed = (await issue('device-attestation-credential', {
        _holderDidKey: HOLDER_DID_KEY,
        tier: 'gold',
      })) as never as { disclosureFrame: { _sd: string[] } };

      // `status` is reserved by SD-JWT VC; listing it in `_sd` makes the
      // library throw "Cannot disclose protected field" and fails issuance.
      expect(signed.disclosureFrame._sd).toEqual(['tier']);
    });

    it('does not let an issuanceMetadata claim shadow the status pointer', async () => {
      const signed = (await issue('device-attestation-credential', {
        _holderDidKey: HOLDER_DID_KEY,
        status: { status_list: { uri: 'https://attacker.example/list', idx: 0 } },
      })) as never as { payload: Record<string, unknown>; disclosureFrame: { _sd: string[] } };

      expect(signed.payload.status).toEqual({ status_list: { uri: LIST_URI, idx: 7 } });
      expect(signed.disclosureFrame._sd).toEqual([]);
    });

    it('issues nothing when the status entry cannot be recorded', async () => {
      allocate.mockRejectedValue(new Error('Session write failed'));

      await expect(issue('device-attestation-credential', { _holderDidKey: HOLDER_DID_KEY })).rejects.toThrow(
        /Session write failed/,
      );
    });

    it('issues nothing when allocation fails', async () => {
      allocate.mockRejectedValue(new Error('Allocation unavailable'));

      await expect(issue('device-attestation-credential', { _holderDidKey: HOLDER_DID_KEY })).rejects.toThrow(
        /Allocation unavailable/,
      );
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('W3C JWT VC', () => {
    // Credo hardcodes 'Verifying credential status is not supported for JWT
    // VCs', so a `credentialStatus` here would make verification fail rather
    // than check anything. This branch must stay status-free.
    it('is left untouched by status list support', async () => {
      withDynamicJwtVcConfiguration();

      const signed = (await issue('legacy-jwt-vc', {
        _holderDidKey: HOLDER_DID_KEY,
        tier: 'gold',
      })) as never as { credential: Record<string, unknown> };

      const asJson = JSON.parse(JSON.stringify(signed.credential));
      expect(asJson.credentialStatus).toBeUndefined();
      expect(asJson.status).toBeUndefined();

      // Pins existing behaviour, and is not an endorsement of it: Credo's
      // `W3cCredentialSubject` only maps `id` and `claims`, so the `tier`
      // claim passed through `issuanceMetadata` is silently dropped. That is
      // a pre-existing defect in this branch, untouched by status list
      // support — see REVOCATION_PLAN.md §10.
      expect(asJson.credentialSubject).toEqual({ id: HOLDER_DID_KEY });

      expect(allocate).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });
  });
});

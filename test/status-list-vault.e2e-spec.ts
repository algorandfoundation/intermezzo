import { randomUUID } from 'crypto';
import * as crypto from 'crypto';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { SDJwtVcInstance } from '@sd-jwt/sd-jwt-vc';
import { Oid4vcAgentProvider } from '../src/oid4vc/agent/oid4vc-agent.provider';
import { AlgoVaultTokenProvider } from '../src/oid4vc/algo/algo-vault-token.provider';
import { Oid4vcConfig } from '../src/oid4vc/oid4vc.config';
import { Oid4vcIssuanceSessionRepository } from '../src/oid4vc/sessions/vault-repository';
import { Oid4vcStatusService } from '../src/oid4vc/status/oid4vc-status.service';
import { StatusListRepository } from '../src/oid4vc/status/status-list.repository';
import { VaultService } from '../src/vault/vault.service';

// Run only against a disposable dev Vault. Each run creates and removes its own
// KV/transit mounts; it never reads the application's .env or credentials.
const url = process.env.STATUS_LIST_VAULT_URL;
(url ? describe : describe.skip)('Status lists with real Vault KV and transit', () => {
  const token = process.env.STATUS_LIST_VAULT_TOKEN!;
  const mount = `status-check-${randomUUID()}`;
  const transit = `${mount}-transit`;
  let services: Oid4vcStatusService[];
  let sessions: Oid4vcIssuanceSessionRepository;
  let vault: VaultService;
  let issuer: string;
  let publicKey: crypto.KeyObject;
  const createdMounts: string[] = [];

  async function api(path: string, method = 'GET', body?: object) {
    const response = await fetch(`${url}/v1/${path}`, {
      method,
      headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`Vault ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }

  beforeAll(async () => {
    if (!token) throw new Error('STATUS_LIST_VAULT_TOKEN is required');
    await api(`sys/mounts/${mount}`, 'POST', { type: 'kv', options: { version: '2' } });
    createdMounts.push(mount);
    await api(`sys/mounts/${transit}`, 'POST', { type: 'transit' });
    createdMounts.push(transit);
    await api(`${transit}/keys/manager`, 'POST', { type: 'ed25519' });
    const key = await api(`${transit}/keys/manager`);
    const raw = Buffer.from(key.data.keys['1'].public_key, 'base64');
    publicKey = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
      format: 'der',
      type: 'spki',
    });
    issuer = `did:algo:testnet:app:1:${raw.toString('hex')}`;
    const configService = new ConfigService({
      VAULT_BASE_URL: url,
      VAULT_KV_MOUNT: mount,
      VAULT_TRANSIT_MANAGERS_PATH: transit,
    });
    vault = new VaultService(new HttpService(), configService);
    const tokens = { getToken: async () => token } as unknown as AlgoVaultTokenProvider;
    sessions = new Oid4vcIssuanceSessionRepository(vault, tokens);
    services = Array.from(
      { length: 2 },
      () =>
        new Oid4vcStatusService(
          new Oid4vcConfig(configService),
          new StatusListRepository(vault, tokens),
          sessions,
          {
            ensureIssuerDid: async () => ({ did: issuer, verificationMethodId: `${issuer}#keys-1` }),
          } as unknown as Oid4vcAgentProvider,
          vault,
          tokens,
        ),
    );
  }, 30_000);

  afterAll(async () => {
    for (const name of createdMounts.reverse()) await api(`sys/mounts/${name}`, 'DELETE');
  });

  it('allocates concurrently, verifies transit signatures, and measures a small synthetic workload', async () => {
    const entries: Awaited<ReturnType<Oid4vcStatusService['allocateForSession']>>[] = [];
    const issuanceMs: number[] = [];
    let retries = 0;
    const started = performance.now();
    await Promise.all(
      services.map(async (service, worker) => {
        for (let i = 0; i < 100; i++) {
          const id = `${worker}-${i}`;
          const start = performance.now();
          await sessions.save({ id, credoIssuanceSessionId: id });
          for (let attempt = 0; ; attempt++) {
            try {
              entries.push(await service.allocateForSession(id));
              break;
            } catch (error) {
              if (!(error instanceof ServiceUnavailableException) || attempt >= 9) throw error;
              retries++;
            }
          }
          issuanceMs.push(performance.now() - start);
        }
      }),
    );
    const issuanceElapsed = performance.now() - started;
    expect(new Set(entries.map((e) => `${e.listId}/${e.idx}`)).size).toBe(200);
    const session = await sessions.findOneById('0-0');
    const entry = session!.statusEntries![0];
    const sdjwt = new SDJwtVcInstance({
      signAlg: 'EdDSA',
      signer: async (data) => {
        const signature = await vault.sign('manager', transit, new TextEncoder().encode(data), token);
        return Buffer.from((signature as unknown as string).split(':')[2], 'base64').toString('base64url');
      },
      verifier: (data, signature) =>
        crypto.verify(null, Buffer.from(data), publicKey, Buffer.from(signature, 'base64url')),
      hasher: (data, alg) => crypto.createHash(alg.replace('-', '')).update(Buffer.from(data)).digest(),
      hashAlg: 'sha-256',
      saltGenerator: (length) => crypto.randomBytes(length).toString('hex'),
      statusListFetcher: () => services[0].getStatusListJwt(entry.listId),
    });
    const credential = await sdjwt.issue({
      iss: issuer,
      vct: 'device-attestation-credential',
      status: {
        status_list: { uri: `http://localhost:3000/v1/credential/status/list/${entry.listId}`, idx: entry.idx },
      },
    });
    await sdjwt.verify(credential); // Warm the signed-list cache.
    const verificationMs: number[] = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      await sdjwt.verify(credential);
      verificationMs.push(performance.now() - start);
    }
    await services[1].revokeBySessionId('0-0');
    await expect(sdjwt.verify(credential)).rejects.toThrow('Status is not valid');
    await services[1].reactivateBySessionId('0-0');
    await expect(sdjwt.verify(credential)).resolves.toBeDefined();
    const percentiles = (values: number[]) => {
      values.sort((a, b) => a - b);
      return {
        p50Ms: +values[Math.floor(values.length * 0.5)].toFixed(2),
        p95Ms: +values[Math.floor(values.length * 0.95)].toFixed(2),
      };
    };
    console.log(
      JSON.stringify({
        workload: 'local dev Vault; 200 session creations + allocations, 2 workers; 200 warm SD-JWT verifications',
        allocation: { ...percentiles(issuanceMs), perSecond: +(200_000 / issuanceElapsed).toFixed(2), retries },
        verification: percentiles(verificationMs),
      }),
    );
  }, 120_000);
});

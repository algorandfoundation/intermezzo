import express from 'express';
import type { Request, Response } from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';
import crypto from 'crypto';
import { decodeTransaction } from '@algorandfoundation/algokit-utils/transact';
import { AlgorandEncoder } from '@algorandfoundation/algo-models';

type AppRoleCreds = {
  role?: string;
  secret?: string;
  source: { roleFromFile: boolean; secretFromFile: boolean };
};

const VAULT_BASE_URL = process.env.VAULT_BASE_URL || 'http://vault:8200';
const VAULT_NAMESPACE = process.env.VAULT_NAMESPACE;
const PORT = parseInt(process.env.PORT || '3001', 10);

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

// Support Docker secrets: check multiple paths for secret files
function readSecretFile(name: string): string | undefined {
  const paths = [`/run/secrets/${name}`, `/secrets/${name}`, `./.secrets/${name}`];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
    } catch (e) {
      // ignore
    }
  }
  return undefined;
}

function algorandAddressFromPubKeyBase64(pubB64: string): string {
  const pub = Buffer.from(pubB64, 'base64');
  // checksum: last 4 bytes of sha512/256(pub)
  const sha = crypto.createHash('sha512-256');
  sha.update(pub);
  const digest = sha.digest();
  const checksum = digest.slice(-4);
  const addrBytes = Buffer.concat([pub, checksum]);
  // base32 encode without padding (RFC4648, alphabet A-Z2-7)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < addrBytes.length; i++) {
    value = (value << 8) | addrBytes[i];
    bits += 8;
    while (bits >= 5) {
      const index = (value >> (bits - 5)) & 31;
      bits -= 5;
      output += alphabet[index];
    }
  }
  if (bits > 0) {
    const index = (value << (5 - bits)) & 31;
    output += alphabet[index];
  }
  return output;
}

// Vault transit expects standard base64. Some clients send base64url.
function normalizeBase64(input: string): string {
  let out = input;
  if (/[-_]/.test(out)) out = out.replace(/-/g, '+').replace(/_/g, '/');
  while (out.length % 4 !== 0) out += '=';
  return out;
}

// Lazy-read AppRole credentials so the service can start before secrets exist.
function getAppRoleCreds(): AppRoleCreds {
  const roleFromFile = readSecretFile('pawn_sponsor_approle_role_id') || readSecretFile('VAULT_SPONSOR_ROLE_ID');
  const secretFromFile = readSecretFile('pawn_sponsor_approle_secret_id') || readSecretFile('VAULT_SPONSOR_SECRET_ID');
  const role = roleFromFile || process.env.VAULT_SPONSOR_ROLE_ID || process.env.VAULT_SERVICE_ROLE_ID;
  const secret = secretFromFile || process.env.VAULT_SPONSOR_SECRET_ID || process.env.VAULT_SERVICE_SECRET_ID;
  return { role, secret, source: { roleFromFile: !!roleFromFile, secretFromFile: !!secretFromFile } };
}

let cachedToken: string | null = null;
let cachedExpiry = 0; // epoch ms
let renewTimer: NodeJS.Timeout | null = null;

async function appRoleLogin(roleId: string, secretId: string) {
  const url = `${VAULT_BASE_URL}/v1/auth/approle/login`;
  const resp = await axios.post(url, { role_id: roleId, secret_id: secretId });
  return resp.data.auth;
}

function scheduleRenew(leaseSeconds: number) {
  if (renewTimer) clearTimeout(renewTimer);
  const renewMs = Math.max(10_000, Math.floor(leaseSeconds * 0.8) * 1000);
  renewTimer = setTimeout(() => {
    void renewToken();
  }, renewMs);
}

async function renewToken() {
  if (!cachedToken) return await ensureToken();
  try {
    const url = `${VAULT_BASE_URL}/v1/auth/token/renew-self`;
    const headers: Record<string, string> = { 'X-Vault-Token': cachedToken };
    if (VAULT_NAMESPACE) headers['X-Vault-Namespace'] = VAULT_NAMESPACE;
    const resp = await axios.post(url, {}, { headers });
    const lease = resp.data.auth?.lease_duration || 0;
    cachedExpiry = Date.now() + lease * 1000;
    scheduleRenew(lease);
    console.log('Sponsor: token renewed');
  } catch (err) {
    console.warn('Sponsor: token renewal failed, re-login', (err as any)?.message || err);
    await ensureToken();
  }
}

async function ensureToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;
  const creds = getAppRoleCreds();
  if (!creds.role || !creds.secret) throw new Error('Sponsor AppRole not configured (VAULT_SPONSOR_ROLE_ID/SECRET_ID)');
  try {
    const roleMask = creds.role ? `${creds.role.slice(0, 4)}...${creds.role.slice(-4)}` : 'missing';
    const secretMask = creds.secret ? `${creds.secret.slice(0, 4)}...${creds.secret.slice(-4)}` : 'missing';
    console.log(`Sponsor: using AppRole (role:${roleMask}, secret:${secretMask}) source:`, creds.source);
  } catch (e) {
    // ignore logging errors
  }
  const auth = await appRoleLogin(creds.role!, creds.secret!);
  cachedToken = auth.client_token;
  const lease = auth.lease_duration || 0;
  if (lease > 0) {
    cachedExpiry = Date.now() + lease * 1000;
    scheduleRenew(lease);
  } else {
    cachedExpiry = Date.now() + 45 * 60 * 1000; // fallback
    scheduleRenew(45 * 60);
  }
  console.log('Sponsor: obtained service token');
  return cachedToken!;
}

app.post('/sign', async (req: Request, res: Response) => {
  let url = '';
  try {
    const { key, transit_path, input_b64 } = req.body as { key?: string; transit_path?: string; input_b64?: string };
    if (!key || !transit_path || !input_b64) return res.status(400).json({ error: 'missing key | transit_path | input_b64' });

    // Normalize base64url->base64 (Vault transit expects standard base64 input)
    const normInputB64 = normalizeBase64(input_b64);
    const bytesToSign = Buffer.from(normInputB64, 'base64');

    // Validate tx intent here (Sponsor is the policy gate).
    // If Sponsor rejects, Pawn should surface the returned error.
    try {
      const txn = decodeTransaction(Uint8Array.from(bytesToSign));

      // 1) fee check
      if (txn.fee !== 2000n) {
        return res.status(400).json({ error: 'invalid fee', details: String(txn.fee) });
      }

      // 2) amount check (payment transactions)
      const amount = txn.payment?.amount ?? (txn as any).amount ?? 0n;
      // Allow either 0 microAlgo (no-op) or 100000 microAlgo (funding).
      if (amount !== 0n && amount !== 100_000n) {
        return res.status(400).json({ error: 'invalid amount', details: String(amount) });
      }

      // 3) sender check: sender must match the sponsor key this service signs with
      const pubFromFile = readSecretFile('sponsor_public_key_base64') || readSecretFile('sponsor_pub_b64');
      if (pubFromFile) {
        const sponsorAddr = algorandAddressFromPubKeyBase64(pubFromFile);
        const senderAddr = new AlgorandEncoder().encodeAddress(Buffer.from(txn.sender.publicKey as Uint8Array));
        if (senderAddr !== sponsorAddr) {
          return res.status(400).json({ error: 'invalid sender', details: `${senderAddr} !== ${sponsorAddr}` });
        }
      }
    } catch (e) {
      return res.status(400).json({ error: 'invalid transaction bytes', details: String(e) });
    }

    // Diagnostic: detect base64url vs base64 and log a short sample
    try {
      const isBase64Url = /[-_]/.test(input_b64);
      const buf = Buffer.from(normInputB64, 'base64');
      console.debug('Sponsor /sign received input - len=%d bytes isBase64Url=%s sample=%s', buf.length, isBase64Url, buf.slice(0, 16).toString('hex'));
    } catch (e) {
      console.debug('Sponsor /sign diagnostic parse failed', (e as any)?.message || e);
    }

    const token = await ensureToken();

    url = `${VAULT_BASE_URL}/v1/${transit_path}/sign/${key}`;
    const headers: Record<string, string> = { 'X-Vault-Token': token, 'Content-Type': 'application/json' };
    if (VAULT_NAMESPACE) headers['X-Vault-Namespace'] = VAULT_NAMESPACE;

    const resp = await axios.post(url, { input: normInputB64 }, { headers });
    const signature = resp.data.data.signature;
    return res.json({ signature });
  } catch (err) {
    const status = (err as any)?.response?.status;
    console.error('Sponsor /sign error', status || '', (err as any)?.response?.data || (err as any)?.message || err);
    if ((err as any)?.response?.status === 403) {
      try {
        console.log('Sponsor: retrying sign after re-login');
        cachedToken = null;
        const token2 = await ensureToken();
        const headers2: Record<string, string> = { 'X-Vault-Token': token2, 'Content-Type': 'application/json' };
        if (VAULT_NAMESPACE) headers2['X-Vault-Namespace'] = VAULT_NAMESPACE;
        const input = normalizeBase64((req.body as any).input_b64);
        const resp2 = await axios.post(url, { input }, { headers: headers2 });
        const signature2 = resp2.data.data.signature;
        return res.json({ signature: signature2, retried: true });
      } catch (err2) {
        console.error('Sponsor /sign retry error', (err2 as any)?.response?.data || (err2 as any)?.message || err2);
        return res.status(500).json({ error: 'sign failed after retry', details: (err2 as any)?.response?.data || (err2 as any)?.message });
      }
    }

    return res.status(500).json({ error: 'sign failed', details: (err as any)?.response?.data || (err as any)?.message });
  }
});

app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

app.get('/info', async (_req: Request, res: Response) => {
  try {
    const addrFromFile = readSecretFile('sponsor_address');
    const pubFromFile = readSecretFile('sponsor_public_key_base64') || readSecretFile('sponsor_pub_b64');
    if (addrFromFile || pubFromFile) {
      const address = addrFromFile || (pubFromFile ? algorandAddressFromPubKeyBase64(pubFromFile) : undefined);
      return res.json({ address: address, public_key_base64: pubFromFile || null });
    }

    const token = await ensureToken();
    const url = `${VAULT_BASE_URL}/v1/pawn/managers/keys/sponsor`;
    const headers: Record<string, string> = { 'X-Vault-Token': token };
    if (VAULT_NAMESPACE) headers['X-Vault-Namespace'] = VAULT_NAMESPACE;
    const resp = await axios.get(url, { headers });
    const pub_b64 = resp?.data?.data?.keys?.['1']?.public_key;
    if (!pub_b64) return res.status(500).json({ error: 'public key not available' });
    const address = algorandAddressFromPubKeyBase64(pub_b64);
    return res.json({ address, public_key_base64: pub_b64 });
  } catch (err) {
    console.error('Sponsor /info error', (err as any)?.response?.data || (err as any)?.message || err);
    return res.status(500).json({ error: 'failed to read sponsor info' });
  }
});

app.listen(PORT, () => console.log(`Sponsor listening on ${PORT}`));

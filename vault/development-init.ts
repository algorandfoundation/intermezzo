import * as crypto from 'crypto';
import * as fs from 'fs';
import axios from 'axios';
import assert from 'assert';
import { Address } from '@algorandfoundation/algokit-utils';

// Constants
const VAULT_BASE_URL = 'http://vault:8200';
const VAULT_INIT_ENDPOINT = '/v1/sys/init';
const VAULT_UNSEAL_ENDPOINT = '/v1/sys/unseal';
const VAULT_MOUNTS_ENDPOINT = '/v1/sys/mounts';
const VAULT_TRANSIT_USERS_PATH = 'pawn/users';
const VAULT_TRANSIT_MANAGERS_PATH = 'pawn/managers';
// Custom secrets engine for Algorand post-quantum (Falcon-1024) accounts —
// Vault has no native Falcon support. Built by scripts/build_vault_plugin.sh
// into the `plugin_directory` the vault container bind-mounts.
const VAULT_PQ_PLUGIN_NAME = 'algorand-pq';
const VAULT_PQ_PLUGIN_BINARY = 'vault-plugin-algorand-pq';
const VAULT_PQ_PLUGIN_FILE = `volumes/vault/plugins/${VAULT_PQ_PLUGIN_BINARY}`;
const VAULT_PQ_PLUGIN_VERSION = fs.readFileSync('vault/plugin/VERSION', 'utf8').trim();
const VAULT_PQ_USERS_PATH = 'pawn/pq-users';
const VAULT_MANAGER_KEY = 'manager';
const VAULT_SEAL_KEYS_FILE = 'vault-seal-keys.json';

const MANAGERS_ROLE_AND_SECRET_KEYS_FILE = 'manager-role-and-secrets.json';
const MANAGER_ADDRESS_FILE = 'manager-address.txt';
const USERS_ROLE_AND_SECRET_KEYS_FILE = 'user-role-and-secrets.json';
const ENV_FILE = '.env';
const ENV_TEMPLATE_FILE = '.env.template';
const USERS_POLICY_NAME = 'pawn_users_policy';
const USERS_APP_ROLE_NAME = 'pawn_users_approle';
const MANAGERS_POLICY_NAME = 'pawn_managers_policy';
const MANAGERS_APP_ROLE_NAME = 'pawn_managers_approle';

// Vault `/v1/sys/health` status codes — see
// https://developer.hashicorp.com/vault/api-docs/system/health
type VaultHealth = {
  initialized: boolean;
  sealed: boolean;
};

// Query Vault's health endpoint to determine the actual server state, rather
// than inferring it from the local presence of `vault-seal-keys.json`. The
// health endpoint intentionally returns non-2xx codes for not-initialized /
// sealed / standby — we explicitly accept any status so we can read the body.
async function getVaultHealth(): Promise<VaultHealth> {
  // Vault may not be listening yet when this script first runs (the container
  // is up but the HTTP server hasn't bound the port). Retry transient
  // connection errors for up to ~60s before giving up.
  const maxAttempts = 60;
  const delayMs = 1000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.get(`${VAULT_BASE_URL}/v1/sys/health`, {
        validateStatus: () => true,
        timeout: 2000,
      });
      return {
        initialized: !!response.data?.initialized,
        sealed: !!response.data?.sealed,
      };
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      const isTransient =
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'EAI_AGAIN' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT';
      if (!isTransient) throw error;
      if (attempt === 1 || attempt % 5 === 0) {
        console.log(`Waiting for Vault to be reachable (attempt ${attempt}/${maxAttempts})...`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// Function to initialize Vault
async function initVault() {
  try {
    // Initialize Vault
    const response = await axios.post(`${VAULT_BASE_URL}${VAULT_INIT_ENDPOINT}`, {
      secret_shares: 1,
      secret_threshold: 1,
    });

    // Save seal keys to file
    fs.writeFileSync(VAULT_SEAL_KEYS_FILE, JSON.stringify(response.data));

    // Unseal Vault
    await unsealVault(response.data.keys[0], response.data.root_token);

    // Initialize transit engine
    await initUsersTransitEngine(response.data.root_token);
    await initManagersTransitEngine(response.data.root_token);

    console.log('Vault Token:', response.data.root_token);

    return response.data;
  } catch (error) {
    console.error('Failed to initialize Vault:', error);
    throw error;
  }
}

// Function to unseal Vault
async function unsealVault(key: string, token: string) {
  try {
    // Unseal Vault
    const response = await axios.post(
      `${VAULT_BASE_URL}${VAULT_UNSEAL_ENDPOINT}`,
      {
        secret_shares: 1,
        key,
      },
      {
        headers: {
          'X-Vault-Token': token,
        },
      },
    );

    // Check if Vault is unsealed
    if (response.data.sealed) {
      throw new Error('Vault is not unsealed');
    }

    console.log('Vault is unsealed');
  } catch (error) {
    console.error('Failed to unseal Vault:', error);
  }
}

// Function to initialize transit engine
async function initUsersTransitEngine(token: string) {
  try {
    // Get mounts
    const mountsResponse = await axios.get(`${VAULT_BASE_URL}${VAULT_MOUNTS_ENDPOINT}`, {
      headers: {
        'X-Vault-Token': token,
      },
    });

    console.log('Mounts:', JSON.stringify(mountsResponse.data));

    // Mount transit engine
    const mountResponse = await axios.post(
      `${VAULT_BASE_URL}${VAULT_MOUNTS_ENDPOINT}/${VAULT_TRANSIT_USERS_PATH}`,
      {
        type: 'transit',
        config: {
          force_no_cache: true,
        },
      },
      {
        headers: {
          'X-Vault-Token': token,
        },
      },
    );

    console.log('Mount transit engine response:', JSON.stringify(mountResponse.data));
  } catch (error) {
    console.error('Failed to initialize transit engine:', error);
  }
}

// Idempotently mount the KV-v2 secret engine at `secret/`. The service
// reads/writes operational state (e.g. DID app id, OID4VC sessions)
// via `VaultService.kv*`, which always targets `secret/data/...` and
// `secret/metadata/...`. Vault returns 400 with `path is already in
// use` if the mount exists — we treat that as success.
async function initKvSecretEngine(token: string) {
  try {
    const mountResponse = await axios.post(
      `${VAULT_BASE_URL}${VAULT_MOUNTS_ENDPOINT}/secret`,
      {
        type: 'kv',
        options: { version: '2' },
      },
      {
        headers: {
          'X-Vault-Token': token,
        },
      },
    );
    console.log('Mount kv-v2 secret engine response status:', mountResponse.status);
  } catch (error: any) {
    const status = error?.response?.status;
    const message: string = error?.response?.data?.errors?.[0] ?? '';
    if (status === 400 && message.includes('path is already in use')) {
      console.log('PASS: kv-v2 secret engine already mounted at secret/');
      return;
    }
    console.error('Failed to mount kv-v2 secret engine:', error);
    throw error;
  }
}

// Idempotently register the Algorand PQ plugin in Vault's plugin catalog and
// mount it at `pawn/pq-users`. Vault verifies the binary against the registered
// sha256, so the catalog entry is re-upserted (and the plugin reloaded) on every
// run — a rebuilt binary is picked up without resetting the dev vault.
async function registerAndMountPqPlugin(token: string) {
  if (!fs.existsSync(VAULT_PQ_PLUGIN_FILE)) {
    console.warn(
      `SKIP: PQ plugin binary not found at '${VAULT_PQ_PLUGIN_FILE}'. ` +
        `Run './scripts/build_vault_plugin.sh' then re-run this script to enable ${VAULT_PQ_USERS_PATH}.`,
    );
    return;
  }

  const headers = { 'X-Vault-Token': token };
  const digest = crypto.createHash('sha256').update(fs.readFileSync(VAULT_PQ_PLUGIN_FILE)).digest();
  const sha256 = digest.toString('hex');
  const expectedSha256Values = new Set([sha256, digest.toString('base64')]);

  await axios.put(
    `${VAULT_BASE_URL}/v1/sys/plugins/catalog/secret/${VAULT_PQ_PLUGIN_NAME}`,
    { sha256, command: VAULT_PQ_PLUGIN_BINARY, version: VAULT_PQ_PLUGIN_VERSION },
    { headers },
  );
  console.log(`Registered plugin '${VAULT_PQ_PLUGIN_NAME}' ${VAULT_PQ_PLUGIN_VERSION} (sha256 ${sha256})`);

  try {
    await axios.post(
      `${VAULT_BASE_URL}${VAULT_MOUNTS_ENDPOINT}/${VAULT_PQ_USERS_PATH}`,
      { type: VAULT_PQ_PLUGIN_NAME, plugin_version: VAULT_PQ_PLUGIN_VERSION },
      { headers },
    );
    console.log(`Mounted '${VAULT_PQ_PLUGIN_NAME}' at ${VAULT_PQ_USERS_PATH}`);
  } catch (error: any) {
    const status = error?.response?.status;
    const message: string = error?.response?.data?.errors?.[0] ?? '';
    if (status !== 400 || !message.includes('path is already in use')) {
      // Vault puts the real reason (checksum mismatch, plugin exec/handshake
      // failure) in `errors`; the raw AxiosError dump elides it.
      console.error(`Failed to mount PQ secrets engine (${status}):`, JSON.stringify(error?.response?.data?.errors));
      throw error;
    }
    console.log(`PASS: PQ secrets engine already mounted at ${VAULT_PQ_USERS_PATH}/`);
    await axios.post(
      `${VAULT_BASE_URL}${VAULT_MOUNTS_ENDPOINT}/${VAULT_PQ_USERS_PATH}/tune`,
      { plugin_version: VAULT_PQ_PLUGIN_VERSION },
      { headers },
    );
    await axios.post(`${VAULT_BASE_URL}/v1/sys/plugins/reload/backend`, { plugin: VAULT_PQ_PLUGIN_NAME }, { headers });
    console.log(`Reloaded plugin '${VAULT_PQ_PLUGIN_NAME}'`);
  }

  const catalogResponse = await axios.get(`${VAULT_BASE_URL}/v1/sys/plugins/catalog/secret/${VAULT_PQ_PLUGIN_NAME}`, {
    headers,
    params: { version: VAULT_PQ_PLUGIN_VERSION },
  });
  const catalog = catalogResponse.data?.data ?? catalogResponse.data;
  assert.strictEqual(catalog.version, VAULT_PQ_PLUGIN_VERSION);
  assert(expectedSha256Values.has(catalog.sha256), 'Vault catalog SHA does not match the plugin binary');

  const mountResponse = await axios.get(`${VAULT_BASE_URL}${VAULT_MOUNTS_ENDPOINT}/${VAULT_PQ_USERS_PATH}`, {
    headers,
  });
  const mount = mountResponse.data?.data ?? mountResponse.data;
  assert.strictEqual(mount.plugin_version, VAULT_PQ_PLUGIN_VERSION);
  assert.strictEqual(mount.running_plugin_version, VAULT_PQ_PLUGIN_VERSION);
  assert(expectedSha256Values.has(mount.running_sha256), 'Running plugin SHA does not match the plugin binary');
  console.log(`PASS: '${VAULT_PQ_PLUGIN_NAME}' ${VAULT_PQ_PLUGIN_VERSION} is registered and running`);
}

// Function to initialize manager transit engine
async function initManagersTransitEngine(token: string) {
  try {
    // Get mounts
    const mountsResponse = await axios.get(`${VAULT_BASE_URL}${VAULT_MOUNTS_ENDPOINT}`, {
      headers: {
        'X-Vault-Token': token,
      },
    });

    console.log('Mounts:', JSON.stringify(mountsResponse.data));

    // Mount transit engine
    const mountResponse = await axios.post(
      `${VAULT_BASE_URL}${VAULT_MOUNTS_ENDPOINT}/${VAULT_TRANSIT_MANAGERS_PATH}`,
      {
        type: 'transit',
        config: {
          force_no_cache: true,
        },
      },
      {
        headers: {
          'X-Vault-Token': token,
        },
      },
    );

    console.log('Mount transit engine response:', JSON.stringify(mountResponse.data));
  } catch (error) {
    console.error('Failed to initialize transit engine:', error);
  }
}

// Function to create ACL policies in Vault
async function createACLPolicies(token: string) {
  try {
    // Define the ACL policies
    const policies = {
      // https://developer.hashicorp.com/vault/api-docs/secret/transit

      [USERS_POLICY_NAME]: {
        path: {
          // USER
          // -------
          // 1) allow /keys/* path
          // 2) but exclude config paths like /keys/*/config
          [`${VAULT_TRANSIT_USERS_PATH}/keys/*`]: {
            capabilities: ['create', 'read', 'update'],
          },
          [`${VAULT_TRANSIT_USERS_PATH}/keys/+/+`]: {
            capabilities: ['deny'],
          },
          // PQ (Falcon-1024) accounts — custom secrets engine. It has no
          // sub-paths, so no `keys/+/+` deny is needed.
          [`${VAULT_PQ_USERS_PATH}/keys/*`]: {
            capabilities: ['create', 'read', 'update'],
          },
        },
      },
      [MANAGERS_POLICY_NAME]: {
        path: {
          // MANAGER
          // -------
          // 1) allow /keys/* path
          // 2) but exclude config paths like /keys/*/config
          [`${VAULT_TRANSIT_MANAGERS_PATH}/keys/*`]: {
            capabilities: ['create', 'read', 'update'],
          },
          [`${VAULT_TRANSIT_MANAGERS_PATH}/keys/+/+`]: {
            capabilities: ['deny'],
          },
          // 3 allow /sign path
          [`${VAULT_TRANSIT_MANAGERS_PATH}/sign/*`]: {
            capabilities: ['create', 'read', 'update'],
          },

          // USER
          // -------
          // 1) allow /keys/* path
          // 2) but exclude config paths like /keys/*/config
          [`${VAULT_TRANSIT_USERS_PATH}/keys/*`]: {
            capabilities: ['create', 'read', 'update'],
          },
          [`${VAULT_TRANSIT_USERS_PATH}/keys/+/+`]: {
            capabilities: ['deny'],
          },
          // 3) allow list users
          [`${VAULT_TRANSIT_USERS_PATH}/keys`]: {
            capabilities: ['list'],
          },
          // 4 allow /sign path
          [`${VAULT_TRANSIT_USERS_PATH}/sign/*`]: {
            capabilities: ['create', 'read', 'update'],
          },

          // PQ (Falcon-1024) user accounts — custom secrets engine, same
          // create/read/list/sign shape as the transit user paths above.
          [`${VAULT_PQ_USERS_PATH}/keys/*`]: {
            capabilities: ['create', 'read', 'update'],
          },
          [`${VAULT_PQ_USERS_PATH}/keys`]: {
            capabilities: ['list'],
          },
          [`${VAULT_PQ_USERS_PATH}/sign/*`]: {
            capabilities: ['create', 'read', 'update'],
          },

          // KV-v2 (`secret/` mount) — operational state the service
          // owns, namespaced under `intermezzo/`. Both `data/` (versions)
          // and `metadata/` (list/delete) paths are required for full
          // KV-v2 read/write/list/delete via `VaultService.kv*`.
          [`secret/data/intermezzo/*`]: {
            capabilities: ['create', 'read', 'update', 'delete'],
          },
          [`secret/metadata/intermezzo/*`]: {
            capabilities: ['list', 'read', 'delete'],
          },
        },
      },
    };

    // Upsert the ACL policies. We always PUT (Vault treats this as
    // upsert) so existing dev vaults pick up policy changes — e.g.
    // newly granted `secret/data/intermezzo/*` capabilities — without
    // needing a full reset.
    for (const [policyName, policy] of Object.entries(policies)) {
      const policyExists = await checkACLPoliciesExists(policyName, token);
      await axios.put(
        `${VAULT_BASE_URL}/v1/sys/policies/acl/${policyName}`,
        {
          policy: JSON.stringify(policy),
        },
        {
          headers: {
            'X-Vault-Token': token,
          },
        },
      );
      console.log(policyExists ? `ACL policy '${policyName}' updated` : `ACL policy '${policyName}' created`);
    }
  } catch (error) {
    console.error('Failed to create ACL policies:', error);
  }
}

async function checkACLPoliciesExists(policyName: string, token: string): Promise<boolean> {
  try {
    await axios.get(`${VAULT_BASE_URL}/v1/sys/policies/acl/${policyName}`, {
      headers: {
        'X-Vault-Token': token,
      },
    });
    return true; // Policy exists if the GET request is successful
  } catch (error: any) {
    if (error.response && error.response.status === 404) {
      return false; // Policy does not exist if 404 is returned
    }
    console.error(`Failed to check ACL policy '${policyName}':`, error);
    return false; // Assume policy does not exist or error during check
  }
}
async function enableAppRoleIfNotEnabledAuth(root_token: string) {
  try {
    const response = await axios.post(
      `${VAULT_BASE_URL}/v1/sys/auth/approle`,
      {
        type: 'approle',
      },
      {
        headers: {
          'X-Vault-Token': root_token,
        },
      },
    );

    if (response.status === 204 || response.status === 200) {
      console.log('AppRole authentication enabled successfully');
    } else {
      throw new Error(`Unexpected response status: ${response.status}`);
    }
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 400 &&
      error.response.data.errors[0].includes('path is already in use')
    ) {
      console.log('PASS: AppRole authentication is already enabled');
    } else {
      console.error('Failed to enable AppRole authentication:', error);
    }
  }
}

// Function to generate AppRoles for the ACL policies
async function checkAppRoleExists(roleName: string, root_token: string): Promise<boolean> {
  try {
    await axios.get(`${VAULT_BASE_URL}/v1/auth/approle/role/${roleName}`, {
      headers: {
        'X-Vault-Token': root_token,
      },
    });
    return true; // Role exists if the GET request is successful
  } catch (error: any) {
    if (error.response && error.response.status === 404) {
      return false; // Role does not exist if 404 is returned
    }
    console.error(`Failed to check AppRole '${roleName}':`, error);
    return false; // Assume role does not exist or error during check
  }
}

async function getOrCreateAppRoles(root_token: string) {
  try {
    const appRoles = [
      {
        name: USERS_APP_ROLE_NAME,
        policies: [USERS_POLICY_NAME],
      },
      {
        name: MANAGERS_APP_ROLE_NAME,
        policies: [MANAGERS_POLICY_NAME],
      },
    ];

    for (const appRole of appRoles) {
      const roleExists = await checkAppRoleExists(appRole.name, root_token);
      if (!roleExists) {
        await axios.post(
          `${VAULT_BASE_URL}/v1/auth/approle/role/${appRole.name}`,
          {
            policies: appRole.policies,
            token_type: 'batch',
          },
          {
            headers: {
              'X-Vault-Token': root_token,
            },
          },
        );
        console.log(`AppRole '${appRole.name}' created successfully`);
      } else {
        console.log(`PASS: AppRole '${appRole.name}' already exists`);
      }
    }
  } catch (error) {
    console.error('Failed to create or check AppRoles:', error);
  }
}

async function logRoleIdAndSecretId(
  role_name: string,
  token: string,
  store_file_name: string,
): Promise<{ role_id: string; secret_id: string } | undefined> {
  try {
    // Get role_id
    const roleIdResponse = await axios.get(`${VAULT_BASE_URL}/v1/auth/approle/role/${role_name}/role-id`, {
      headers: {
        'X-Vault-Token': token,
      },
    });
    const role_id = roleIdResponse.data.data.role_id;

    // Get secret_id
    const secretIdResponse = await axios.post(
      `${VAULT_BASE_URL}/v1/auth/approle/role/${role_name}/secret-id`,
      {},
      {
        headers: {
          'X-Vault-Token': token,
        },
      },
    );
    const secret_id = secretIdResponse.data.data.secret_id;

    fs.writeFileSync(
      store_file_name,
      JSON.stringify({
        role_id,
        secret_id,
      }),
    );

    console.log(`\n${role_name}' - Role ID:    ->\t`, role_id);
    console.log(`'${role_name}' - Secret ID: ->\t`, secret_id);
    console.log(
      `You can get vault token ('auth.client_token') using \n\nPOST http://localhost:8200/v1/auth/approle/login\n{\n  "role_id": "${role_id}",\n  "secret_id": "${secret_id}"\n}\n`,
    );
    return { role_id, secret_id };
  } catch (error) {
    console.error(`Failed to login with AppRole '${role_name}':`, error);
    return undefined;
  }
}

// Ensure `.env` exists by seeding it from `.env.template` when missing.
// The application reads its runtime configuration from `.env`, and the
// manager AppRole credentials this script provisions need to land there
// so the service can authenticate to Vault without a manual copy step.
function ensureEnvFile(): void {
  if (fs.existsSync(ENV_FILE)) return;
  if (!fs.existsSync(ENV_TEMPLATE_FILE)) {
    console.warn(`'${ENV_TEMPLATE_FILE}' not found — skipping '${ENV_FILE}' seeding.`);
    return;
  }
  fs.copyFileSync(ENV_TEMPLATE_FILE, ENV_FILE);
  console.log(`Seeded '${ENV_FILE}' from '${ENV_TEMPLATE_FILE}'.`);
}

// Parse `.env` into a flat key/value map. Comments and blank lines are
// skipped; surrounding single/double quotes on values are stripped so
// callers see the raw value the application would observe at runtime.
function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

// Fetch the network's `genesis-id` / `genesis-hash` directly from the
// configured algod node and persist them into `.env`. Without this step
// the operator has to copy the values from `goal node status` (or the
// LocalNet docker logs) by hand every time the sandbox is re-created —
// and a stale `GENESIS_HASH` produces opaque algod `transaction <id>:
// bad genesis hash` rejections at submit time.
async function fetchAndPersistGenesis(): Promise<void> {
  const env = readEnvFile();
  const scheme = env.NODE_HTTP_SCHEME || 'http';
  // The script runs on the host, so prefer NODE_HOST as written; fall
  // back to localhost if the file uses the in-container default.
  const host = env.NODE_HOST || 'localhost';
  const port = env.NODE_PORT || '4001';
  const token = env.NODE_TOKEN || '';
  const url = `${scheme}://${host}:${port}/v2/transactions/params`;
  try {
    const response = await axios.get(url, {
      headers: { 'X-Algo-API-Token': token },
    });
    const genesisId: string | undefined = response.data?.['genesis-id'];
    const genesisHash: string | undefined = response.data?.['genesis-hash'];
    if (!genesisId || !genesisHash) {
      console.warn(`algod at ${url} did not return genesis-id/genesis-hash — leaving '${ENV_FILE}' values unchanged.`);
      return;
    }
    updateEnvFile({ GENESIS_ID: genesisId, GENESIS_HASH: genesisHash });
    console.log(`Fetched genesis from ${url}: id='${genesisId}'`);
  } catch (error: any) {
    const detail = error?.response?.status ? `HTTP ${error.response.status}` : (error?.message ?? error);
    console.warn(`Failed to fetch genesis from ${url} (${detail}); leaving '${ENV_FILE}' values unchanged.`);
  }
}

// Replace `KEY=...` entries in `.env` with the provided values. Keys that
// are missing from the file are appended. Existing comments / ordering are
// preserved so the file remains readable after subsequent script runs.
function updateEnvFile(updates: Record<string, string>): void {
  if (!fs.existsSync(ENV_FILE)) {
    console.warn(`'${ENV_FILE}' not found — cannot persist updates: ${Object.keys(updates).join(', ')}`);
    return;
  }
  const original = fs.readFileSync(ENV_FILE, 'utf8');
  const lines = original.split(/\r?\n/);
  const remaining = new Set(Object.keys(updates));
  const next = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    remaining.delete(key);
    return `${key}=${updates[key]}`;
  });
  for (const key of remaining) {
    next.push(`${key}=${updates[key]}`);
  }
  fs.writeFileSync(ENV_FILE, next.join('\n'));
  console.log(`Updated '${ENV_FILE}' with: ${Object.keys(updates).join(', ')}`);
}

async function getOrCreateManager(token: string) {
  const url: string = `${VAULT_BASE_URL}/v1/${VAULT_TRANSIT_MANAGERS_PATH}/keys/${VAULT_MANAGER_KEY}`;
  const response = await axios.post(
    url,
    {
      type: 'ed25519',
      derived: false,
      allow_deletion: false,
    },
    {
      headers: { 'X-Vault-Token': token },
    },
  );
  assert(response.status == 200);

  const publicKey = new Address(Buffer.from(response.data.data.keys['1'].public_key, 'base64')).toString();
  // Persist the manager Algorand address so external tooling (e.g. CI) can
  // prefund it from a LocalNet dispenser without having to re-derive it.
  fs.writeFileSync(MANAGER_ADDRESS_FILE, publicKey);
  console.log('Manager public key: \n', publicKey);
}

// Main function
async function main() {
  // Decide what to do based on Vault's actual server state, not on the
  // local presence of `vault-seal-keys.json`. Inferring from the file alone
  // is fragile: if Vault file storage was persisted from a previous run
  // (e.g. `volumes/vault/file/`) but the seal-keys file isn't on disk,
  // `POST /v1/sys/init` returns 400 "Vault is already initialized" and the
  // script crashes downstream trying to read `sealKeys.root_token`.
  const health = await getVaultHealth();
  const sealKeysFileExists = fs.existsSync(VAULT_SEAL_KEYS_FILE);

  let sealKeys: any;
  if (!health.initialized) {
    // Fresh Vault — initialize and persist seal keys.
    sealKeys = await initVault();
  } else if (sealKeysFileExists) {
    // Already initialized and we have the seal keys locally — just unseal
    // (idempotent if already unsealed) and proceed.
    sealKeys = JSON.parse(fs.readFileSync(VAULT_SEAL_KEYS_FILE).toString());
    if (health.sealed) {
      await unsealVault(sealKeys.keys[0], sealKeys.root_token);
    }
  } else {
    // Initialized but seal keys are missing — we cannot unseal or
    // authenticate. This usually means stale Vault file storage was
    // carried over from a previous run. Surface a clear error instead of
    // crashing on `undefined.root_token`.
    throw new Error(
      `Vault is already initialized but '${VAULT_SEAL_KEYS_FILE}' is not present. ` +
        `This typically means stale Vault file storage exists from a previous run. ` +
        `Reset by removing the persisted storage (e.g. 'rm -rf volumes/vault') and ` +
        `recreating the vault container, then re-run this script.`,
    );
  }

  console.log('\n\n------------\nVault Root Token:\n', sealKeys.root_token, '\n------------\n\n');

  // Idempotently ensure the KV-v2 secret engine is mounted on every
  // run. The transit engines are mounted by `initVault` on first-init;
  // KV-v2 is mounted here so existing dev vaults (initialized before
  // this script learned about KV) pick it up without a full reset.
  await initKvSecretEngine(sealKeys.root_token);
  await registerAndMountPqPlugin(sealKeys.root_token);
  await createACLPolicies(sealKeys.root_token);
  await enableAppRoleIfNotEnabledAuth(sealKeys.root_token);
  await getOrCreateAppRoles(sealKeys.root_token);
  // Seed `.env` from `.env.template` before we have credentials so the
  // file is always present when the service starts; the AppRole values
  // below then overwrite the placeholder `VAULT_ROLE_ID` / `VAULT_SECRET_ID`
  // entries in-place.
  ensureEnvFile();
  console.log('\n\n\nUSER SECRETS\n-----');
  await logRoleIdAndSecretId(USERS_APP_ROLE_NAME, sealKeys.root_token, USERS_ROLE_AND_SECRET_KEYS_FILE);
  console.log('\n\n\nMANAGER SECRETS\n-----');
  const managerCreds = await logRoleIdAndSecretId(
    MANAGERS_APP_ROLE_NAME,
    sealKeys.root_token,
    MANAGERS_ROLE_AND_SECRET_KEYS_FILE,
  );
  // Persist the manager AppRole into `.env` — this is the AppRole the
  // service (and the OID4VC subsystem, which reuses it) authenticates
  // with at runtime.
  if (managerCreds) {
    updateEnvFile({
      VAULT_ROLE_ID: managerCreds.role_id,
      VAULT_SECRET_ID: managerCreds.secret_id,
    });
  }
  // Refresh `GENESIS_ID` / `GENESIS_HASH` from the live algod node so
  // signed transactions pick up the current LocalNet genesis (these
  // change every time the sandbox is reset).
  await fetchAndPersistGenesis();
  console.log('\n\n\nMANAGER ALGORAND PUBLIC ADDRESS\n------');
  await getOrCreateManager(sealKeys.root_token);
}

// Run main function
main().catch((error) => {
  console.error('Vault development init failed:', error);
  process.exit(1);
});

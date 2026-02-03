import * as fs from 'fs';
import axios from 'axios';
import assert from 'assert';
import { AlgorandEncoder } from '@algorandfoundation/algo-models';

// Constants
const VAULT_BASE_URL = 'http://vault:8200';
const VAULT_INIT_ENDPOINT = '/v1/sys/init';
const VAULT_UNSEAL_ENDPOINT = '/v1/sys/unseal';
const VAULT_MOUNTS_ENDPOINT = '/v1/sys/mounts';
const VAULT_TRANSIT_USERS_PATH = 'pawn/users';
const VAULT_TRANSIT_MANAGERS_PATH = 'pawn/managers';
const VAULT_MANAGER_KEY = 'manager';
const VAULT_SEAL_KEYS_FILE = 'vault-seal-keys.json';

const MANAGERS_ROLE_AND_SECRET_KEYS_FILE = 'manager-role-and-secrets.json';
const USERS_ROLE_AND_SECRET_KEYS_FILE = 'user-role-and-secrets.json';
const USERS_POLICY_NAME = 'pawn_users_policy';
const USERS_APP_ROLE_NAME = 'pawn_users_approle';
const MANAGERS_POLICY_NAME = 'pawn_managers_policy';
const MANAGERS_APP_ROLE_NAME = 'pawn_managers_approle';
const SPONSOR_POLICY_NAME = 'pawn_sponsor_policy';
const SPONSOR_APP_ROLE_NAME = 'pawn_sponsor_approle';
const SPONSOR_ROLE_AND_SECRET_KEYS_FILE = 'sponsor-role-and-secrets.json';
const SECRETS_DIR = '.secrets';

// Function to initialize Vault
async function initVault() {
  try {
    // If Vault is already initialized, avoid calling /sys/init which returns 400.
    try {
      const sealStatus = await axios.get(`${VAULT_BASE_URL}/v1/sys/seal-status`);
      if (sealStatus.data && sealStatus.data.initialized) {
        console.log('Vault already initialized (detected via /sys/seal-status)');
        if (fs.existsSync(VAULT_SEAL_KEYS_FILE)) {
          const existing = JSON.parse(fs.readFileSync(VAULT_SEAL_KEYS_FILE).toString());
          console.log(`Loaded existing ${VAULT_SEAL_KEYS_FILE}`);
          return existing;
        }
        throw new Error('Vault already initialized but no local vault-seal-keys.json found.');
      }
    } catch (err) {
      // If seal-status endpoint is not reachable, continue to attempt init and let init errors surface
    }

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
    // Provide better diagnostics for common Vault init failures (e.g. already initialized)
    if (axios.isAxiosError(error) && error.response) {
      console.error('Failed to initialize Vault: received response', error.response.status, error.response.data);
      // If Vault is already initialized, try to use local seal file if present
      const msg = JSON.stringify(error.response.data || {});
      if (msg.includes('already initialized') || msg.includes('already initialized')) {
        console.log('Vault reports it is already initialized. Checking for local', VAULT_SEAL_KEYS_FILE);
        if (fs.existsSync(VAULT_SEAL_KEYS_FILE)) {
          try {
            const existing = JSON.parse(fs.readFileSync(VAULT_SEAL_KEYS_FILE).toString());
            console.log(`Loaded existing ${VAULT_SEAL_KEYS_FILE}`);
            return existing;
          } catch (err) {
            console.error('Failed to parse existing seal keys file:', err);
            throw error;
          }
        }

        throw new Error('Vault is already initialized but no local vault-seal-keys.json found. Copy the seal keys file from the Vault host into this container or re-run init from the host.');
      }
    }

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
        },
      },
      [SPONSOR_POLICY_NAME]: {
        path: {
          // Sponsor should only be able to sign with a single sponsor key
          // transit sign operations generally require the `update` capability
          // allow both create and update so sign operations succeed
          [`${VAULT_TRANSIT_MANAGERS_PATH}/sign/sponsor`]: {
            capabilities: ['create', 'update'],
          },
          // allow reading the public key for address derivation if needed
          [`${VAULT_TRANSIT_MANAGERS_PATH}/keys/sponsor`]: {
            capabilities: ['read'],
          },
        },
      },
    };

    // Create the ACL policies
    for (const [policyName, policy] of Object.entries(policies)) {
      const policyExists = await checkACLPoliciesExists(policyName, token);
      if (!policyExists) {
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
        console.log(`ACL policy '${policyName}' created successfully`);
      } else {
        console.log(`PASS: ACL policy '${policyName}' already exists`);
      }
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
      {
        name: SPONSOR_APP_ROLE_NAME,
        policies: [SPONSOR_POLICY_NAME],
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

async function getOrCreateSponsorKey(token: string) {
  try {
    const url: string = `${VAULT_BASE_URL}/v1/${VAULT_TRANSIT_MANAGERS_PATH}/keys/sponsor`;
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
    if (response.status === 200) {
      console.log('Sponsor key created or already exists');
    }
    // try to read the key to obtain the public key for the address
    try {
      const readResp = await axios.get(url, { headers: { 'X-Vault-Token': token } });
      const pub = readResp.data?.data?.keys?.['1']?.public_key;
      if (pub) {
        const publicKey = new AlgorandEncoder().encodeAddress(Buffer.from(pub, 'base64'));
        console.log('Sponsor public key: \n', publicKey);
        try {
          if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR, { recursive: true });
          fs.writeFileSync(`${SECRETS_DIR}/sponsor_public_key_base64`, pub);
          fs.writeFileSync(`${SECRETS_DIR}/sponsor_address`, publicKey);
          console.log(`Wrote sponsor public key and address to ${SECRETS_DIR}/`);
        } catch (err) {
          console.error('Failed to write sponsor helper files:', err?.message || err);
        }
      } else {
        console.log('Sponsor key exists but public key not available in response');
      }
    } catch (err) {
      console.log('PASS/INFO: unable to read sponsor key after create:', err?.response?.data || err?.message || err);
    }
  } catch (error: any) {
    // If create failed because key already exists, attempt to read it
    console.log('PASS/INFO: sponsor key create check (create may have failed if already exists):', error?.response?.data || error?.message || error);
    try {
      const readUrl: string = `${VAULT_BASE_URL}/v1/${VAULT_TRANSIT_MANAGERS_PATH}/keys/sponsor`;
      const readResp = await axios.get(readUrl, { headers: { 'X-Vault-Token': token } });
      const pub = readResp.data?.data?.keys?.['1']?.public_key;
      if (pub) {
        const publicKey = new AlgorandEncoder().encodeAddress(Buffer.from(pub, 'base64'));
        console.log('Sponsor public key: \n', publicKey);
        try {
          if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR, { recursive: true });
          fs.writeFileSync(`${SECRETS_DIR}/sponsor_public_key_base64`, pub);
          fs.writeFileSync(`${SECRETS_DIR}/sponsor_address`, publicKey);
          console.log(`Wrote sponsor public key and address to ${SECRETS_DIR}/`);
        } catch (err) {
          console.error('Failed to write sponsor helper files:', err?.message || err);
        }
      } else {
        console.log('Sponsor key exists but public key not available in response');
      }
    } catch (err) {
      console.log('PASS/INFO: sponsor key read fallback failed:', err?.response?.data || err?.message || err);
    }
  }
}

async function logRoleIdAndSecretId(role_name: string, token: string, store_file_name: string) {
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

    // Also write individual secret files for Docker secrets consumption
    try {
      if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR, { recursive: true });
      // file names are simple and safe to reference when creating docker secrets
      fs.writeFileSync(`${SECRETS_DIR}/${role_name}_role_id`, role_id);
      fs.writeFileSync(`${SECRETS_DIR}/${role_name}_secret_id`, secret_id);
      console.log(`Wrote Docker-secret helper files to ${SECRETS_DIR}/`);
    } catch (err) {
      console.error('Failed to write secret helper files:', err?.message || err);
    }

    console.log(`\n${role_name}' - Role ID:    ->\t`, role_id);
    console.log(`'${role_name}' - Secret ID: ->\t`, secret_id);
    console.log(
      `You can get vault token ('auth.client_token') using \n\nPOST http://localhost:8200/v1/auth/approle/login\n{\n  "role_id": "${role_id}",\n  "secret_id": "${secret_id}"\n}\n`,
    );
  } catch (error) {
    console.error(`Failed to login with AppRole '${role_name}':`, error);
  }
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

  const publicKey = new AlgorandEncoder().encodeAddress(Buffer.from(response.data.data.keys['1'].public_key, 'base64'));
  console.log('Manager public key: \n', publicKey);
}

// Main function
async function main() {
  let sealKeys: any;
  // Check if Vault seal keys file exists
  if (!fs.existsSync(VAULT_SEAL_KEYS_FILE)) {
    sealKeys = await initVault();
  } else {
    try {
      sealKeys = JSON.parse(fs.readFileSync(VAULT_SEAL_KEYS_FILE).toString());
      await unsealVault(sealKeys.keys[0], sealKeys.root_token);
    } catch (error) {
      console.error('Failed to unseal Vault:', error);
      // TODO raise error
    }
  }

  if (!sealKeys || !sealKeys.root_token) {
    console.error('\nERROR: vault init/unseal did not produce a root token.\nsealKeys:', sealKeys);
    process.exit(1);
  }

  console.log('\n\n------------\nVault Root Token:\n', sealKeys.root_token, '\n------------\n\n');

  await createACLPolicies(sealKeys.root_token);
  await enableAppRoleIfNotEnabledAuth(sealKeys.root_token);
  await getOrCreateAppRoles(sealKeys.root_token);
  console.log('\n\n\nUSER SECRETS\n-----');
  await logRoleIdAndSecretId(USERS_APP_ROLE_NAME, sealKeys.root_token, USERS_ROLE_AND_SECRET_KEYS_FILE);
  console.log('\n\n\nMANAGER SECRETS\n-----');
  await logRoleIdAndSecretId(MANAGERS_APP_ROLE_NAME, sealKeys.root_token, MANAGERS_ROLE_AND_SECRET_KEYS_FILE);
  console.log('\n\n\nSPONSOR SECRETS\n-----');
  await logRoleIdAndSecretId(SPONSOR_APP_ROLE_NAME, sealKeys.root_token, SPONSOR_ROLE_AND_SECRET_KEYS_FILE);
  console.log('\n\n\nMANAGER ALGORAND PUBLIC ADDRESS\n------');
  await getOrCreateManager(sealKeys.root_token);
  // Ensure sponsor key exists for limited signing
  await getOrCreateSponsorKey(sealKeys.root_token);
}

// Run main function
main();

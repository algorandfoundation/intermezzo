import { Controller, Logger } from "@nestjs/common"

import { ConfigService } from "@nestjs/config"
import { Crafter } from "@algorandfoundation/algo-models/dist/types/crafter.role"
import { AlgorandEncoder, AlgorandTransactionCrafter } from "@algorandfoundation/algo-models"
import { ChainService } from "../chain/chain.service"
import { VaultService } from "../vault/vault.service"
import { AuthService } from "../auth/auth.service"

@Controller()
export class WalletCLI {
    private latestVaultToken: string

	constructor(
        private readonly authService: AuthService,
        private readonly vaultService: VaultService,
        private readonly chainService: ChainService,
        private readonly configService: ConfigService) {}

	/**
	 *
	 * @param token
	 * @returns
	 */
	async login(roleId: string, secretId: string): Promise<boolean> {

        try {
		    const authResponse: string = await this.authService.signInWithRole(roleId, secretId)
            this.latestVaultToken = authResponse
            return true
        } catch (error) {
            Logger.error("Failed to login to Vault", error)
            return false
        }
	}

	/**
	 *
	 * @returns
	 */
	async getAddress(keyPath: string = process.env.VAULT_TRANSIT_MANAGERS_PATH, keyName: string = process.env.VAULT_MANAGER_KEY): Promise<string> {
		const publicKey: Buffer = await this.vaultService.getKey(keyName, keyPath, this.latestVaultToken)
		return new AlgorandEncoder().encodeAddress(publicKey)
	}

	/**
	 *
	 */
	async sign(data: Uint8Array, keyPath: string = process.env.VAULT_TRANSIT_MANAGERS_PATH, keyName: string = process.env.VAULT_MANAGER_KEY): Promise<Uint8Array> {
		//TODO: prompt new auth method

		// const string: string = (await this.walletService.rawSign(Buffer.from(data), "test")).toString()

        const string: string = (await this.vaultService.sign(keyName, keyPath, Buffer.from(data), this.latestVaultToken)).toString()

		// split vault specific prefixes vault:${version}:signature
		const signature = string.split(":")[2]

		// vault default base64 decode
		const decoded: Buffer = Buffer.from(signature, "base64")

		// return as Uint8Array
		return new Uint8Array(decoded)
	}

	/**
	 *
	 * @param txn
	 * @returns
	 */
	async submitTransaction(txn: Uint8Array): Promise<TruncatedPostTransactionsResponse> {
		return this.chainService.submitTransaction(txn)
	}

    /**
     * Get last round number from Algorand node
     */
    async getLastRound(): Promise<bigint> {
        return this.chainService.getLastRound()
    }

	/**
     * 
     * @returns 
     */
	craft(): Crafter {
		return new AlgorandTransactionCrafter(this.configService.get('GENESIS_ID'), this.configService.get('GENESIS_HASH'))
	}
}

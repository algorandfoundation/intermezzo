import { repl } from "@nestjs/core"
import { WalletCLIModule } from "./wallet/wallet.cli.module"

async function bootstrap() {
	// load .env vars
	const { config } = await import("dotenv")
	config()

	// If CLI_USE_LOCAL_VAULT is set to true, use local vault
	if (process.env.CLI_USE_LOCAL_VAULT === "true") {
		process.env.VAULT_BASE_URL = process.env.VAULT_LOCAL_URL
	}
	

	await repl(WalletCLIModule)
}
bootstrap()

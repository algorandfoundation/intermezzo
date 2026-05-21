import { AgentContext, CredoError, InjectionSymbols, Module } from '@credo-ts/core';
import type { DependencyManager } from '@credo-ts/core';
import { AskarStorageService } from '@credo-ts/askar';
import { AskarModuleConfig, type AskarModuleConfigOptions } from '@credo-ts/askar/build/AskarModuleConfig';
import { AskarStoreSymbol, importAskar } from '@credo-ts/askar/build/utils/importAskar';
import { assertAskarWallet } from '@credo-ts/askar/build/utils/assertAskarWallet';

import { VaultAskarWallet } from '../../../libs/credo-vault-wallet';

/**
 * Drop-in replacement for `@credo-ts/askar`'s `AskarModule` that registers
 * {@link VaultAskarWallet} at `InjectionSymbols.Wallet` instead of the stock
 * `AskarWallet`. Everything else (storage service, store handle registration,
 * Askar library import) is identical to the upstream module.
 *
 * We reimplement (rather than subclass `AskarModule`) because `AskarModule`
 * unconditionally `dependencyManager.registerContextScoped(InjectionSymbols.Wallet, AskarWallet)`
 * and throws if the Wallet token is already registered, which makes
 * subclass-override impossible without forking.
 *
 * Multi-tenant `ProfilePerWallet` is not supported here on purpose — the
 * OID4VC subsystem runs as a single agent.
 */
export class Oid4vcAskarModule implements Module {
  public readonly config: AskarModuleConfig;

  constructor(config: AskarModuleConfigOptions) {
    this.config = new AskarModuleConfig(config);
  }

  public register(dependencyManager: DependencyManager): void {
    dependencyManager.registerInstance(AskarModuleConfig, this.config);

    // Validate the Askar native binding is loadable up-front, mirroring
    // AskarModule.register so the failure mode is "fails on construction"
    // rather than "fails on first wallet open".
    importAskar(this.config.ariesAskar);

    if (dependencyManager.isRegistered(InjectionSymbols.Wallet)) {
      throw new CredoError(
        'Oid4vcAskarModule: there is an instance of Wallet already registered. Did you also register AskarModule? Use Oid4vcAskarModule on its own.',
      );
    }
    dependencyManager.registerContextScoped(InjectionSymbols.Wallet, VaultAskarWallet);

    if (dependencyManager.isRegistered(InjectionSymbols.StorageService)) {
      throw new CredoError('Oid4vcAskarModule: there is an instance of StorageService already registered.');
    }
    dependencyManager.registerSingleton(InjectionSymbols.StorageService, AskarStorageService);
  }

  public async initialize(agentContext: AgentContext): Promise<void> {
    // Make sure the wallet is one of the Askar wallets (our subclass passes
    // because VaultAskarWallet extends AskarWallet).
    assertAskarWallet(agentContext.wallet);
    const wallet = agentContext.wallet as unknown as { store: unknown };
    agentContext.dependencyManager.registerInstance(AskarStoreSymbol, wallet.store);
  }
}

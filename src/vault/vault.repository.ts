import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { VaultService } from './vault.service';
import { AlgoVaultTokenProvider } from '../oid4vc/algo/algo-vault-token.provider';

export interface BaseEntity {
  [key: string]: unknown;
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A simple CRUD repository backed by Vault KV-v2.
 *
 * Since Vault KV doesn't support complex queries, we support:
 * 1. CRUD by `id`.
 * 2. `list()` by enumerating the KV folder.
 * 3. A single secondary index (e.g. mapping Credo session ID -> our ID).
 */
export class VaultRepository<T extends BaseEntity> {
  protected readonly logger = new Logger(VaultRepository.name);

  constructor(
    protected readonly vault: VaultService,
    protected readonly tokenProvider: AlgoVaultTokenProvider,
    protected readonly folder: string,
    protected readonly indexField?: keyof T,
  ) {}

  create(data: Partial<T>): T {
    return data as T;
  }

  async save(entity: Partial<T>): Promise<T> {
    const id = entity.id || crypto.randomUUID();
    const now = new Date();
    const existing = entity.id ? await this.findOneById(entity.id) : null;

    const data = {
      ...existing,
      ...entity,
      id,
      createdAt: existing ? new Date(existing.createdAt) : now,
      updatedAt: now,
    } as T;

    const token = await this.tokenProvider.getToken();
    await this.vault.kvWrite(`${this.folder}/records/${id}`, data as any, token);

    // Update secondary index if configured
    if (this.indexField && data[this.indexField]) {
      const indexValue = String(data[this.indexField]);
      // If the indexed field changed between versions, remove the stale index entry
      // so that lookups by the old value no longer resolve to this id.
      if (existing && existing[this.indexField] !== undefined) {
        const oldIndexValue = String(existing[this.indexField]);
        if (oldIndexValue !== indexValue) {
          await this.vault.kvDelete(`${this.folder}/index/${String(this.indexField)}/${oldIndexValue}`, token);
        }
      }
      await this.vault.kvWrite(`${this.folder}/index/${String(this.indexField)}/${indexValue}`, { id } as any, token);
    }

    return data;
  }

  async findOneById(id: string): Promise<T | null> {
    const token = await this.tokenProvider.getToken();
    const data = await this.vault.kvRead<T>(`${this.folder}/records/${id}`, token);
    if (!data) return null;
    return this.mapDates(data);
  }

  async findOneBy(criteria: Partial<T>): Promise<T | null> {
    if (criteria.id) return this.findOneById(criteria.id);
    if (this.indexField && criteria[this.indexField]) {
      return this.findOneByIndex(String(criteria[this.indexField]));
    }
    return null;
  }

  async findOneByIndex(value: string): Promise<T | null> {
    if (!this.indexField) return null;
    const token = await this.tokenProvider.getToken();
    const mapping = await this.vault.kvRead<{ id: string }>(
      `${this.folder}/index/${String(this.indexField)}/${value}`,
      token,
    );
    if (!mapping) return null;
    return this.findOneById(mapping.id);
  }

  async find(options?: { order?: Record<string, 'ASC' | 'DESC'> }): Promise<T[]> {
    const token = await this.tokenProvider.getToken();
    const keys = await this.vault.kvList(`${this.folder}/records`, token);
    const results: T[] = [];
    // Sequential reads to avoid overwhelming Vault/Node, though could be parallelised
    for (const key of keys) {
      const item = await this.findOneById(key);
      if (item) results.push(item);
    }

    if (options?.order) {
      const field = Object.keys(options.order)[0];
      const direction = options.order[field];
      results.sort((a, b) => {
        const valA = (a as any)[field];
        const valB = (b as any)[field];
        // Push undefined to the end regardless of direction so ordering is deterministic.
        if (valA === undefined && valB === undefined) return 0;
        if (valA === undefined) return 1;
        if (valB === undefined) return -1;
        if (valA === valB) return 0;
        if (direction === 'ASC') {
          return valA > valB ? 1 : -1;
        } else {
          return valA < valB ? 1 : -1;
        }
      });
    }

    return results;
  }

  async update(criteria: Partial<T>, partial: Partial<T>): Promise<{ affected: number }> {
    let affected = 0;
    if (criteria.id) {
      const existing = await this.findOneById(criteria.id);
      if (existing) {
        await this.save({ ...existing, ...partial });
        affected = 1;
      }
    } else if (this.indexField && criteria[this.indexField]) {
      const existing = await this.findOneByIndex(String(criteria[this.indexField]));
      if (existing) {
        await this.save({ ...existing, ...partial });
        affected = 1;
      }
    } else {
      // Fallback to slow scan if needed? For now we only support indexed lookups for update
      this.logger.warn('Update called without id or indexed field; scan not implemented');
    }
    return { affected };
  }

  private mapDates(data: T): T {
    return {
      ...data,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    };
  }
}

/**
 * JSON file that holds pool accounts: credentials, display metadata and
 * cumulative stats. Written atomically (temp file + rename) with owner-only
 * permissions, because it holds refresh tokens and client secrets in plain
 * text, exactly as kiro-cli's own SQLite database does.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KiroCredentials } from '../kiro/model/credentials.js';
import { getLogger } from '../shared/logger.js';

/** How the account entered the pool. `kiro-cli` keeps its credential in kiro-cli's SQLite. */
export type AccountSource = 'builder-id' | 'idc' | 'import' | 'kiro-cli';

export interface AccountStats {
  requests: number;
  failures: number;
  credits: number;
  lastUsedAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface AccountQuota {
  current: number;
  limit: number;
  checkedAt: string;
}

export interface StoredAccount {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  source: AccountSource;
  startUrl?: string;
  /** Empty for `kiro-cli` accounts: their credential lives in SQLite. */
  credentials: KiroCredentials;
  email?: string;
  subscription?: string;
  quota?: AccountQuota;
  /** Why the pool disabled the account on its own (cleared when re-enabled). */
  disabledReason?: string;
  stats: AccountStats;
}

interface StoreFile {
  version: 1;
  accounts: StoredAccount[];
}

const SAVE_DEBOUNCE_MS = 2_000;

export function newAccountId(): string {
  return crypto.randomBytes(4).toString('hex');
}

export function emptyStats(): AccountStats {
  return { requests: 0, failures: 0, credits: 0 };
}

export class AccountStore {
  readonly filePath: string;
  #accounts: StoredAccount[] = [];
  #timer: NodeJS.Timeout | undefined;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.#accounts = [];
      return;
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<StoreFile>;
    if (!Array.isArray(raw.accounts)) {
      throw new Error(`accounts file ${this.filePath} has no "accounts" array`);
    }
    this.#accounts = raw.accounts.map((a) => ({ ...a, stats: { ...emptyStats(), ...a.stats } }));
  }

  list(): readonly StoredAccount[] {
    return this.#accounts;
  }

  get(id: string): StoredAccount | undefined {
    return this.#accounts.find((a) => a.id === id);
  }

  add(account: StoredAccount): void {
    this.#accounts.push(account);
    this.saveNow();
  }

  remove(id: string): boolean {
    const before = this.#accounts.length;
    this.#accounts = this.#accounts.filter((a) => a.id !== id);
    if (this.#accounts.length === before) return false;
    this.saveNow();
    return true;
  }

  /** Coalesce frequent stat updates into one write. */
  scheduleSave(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    this.#timer.unref();
  }

  saveNow(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const data: StoreFile = { version: 1, accounts: this.#accounts };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      getLogger().error({
        msg: 'account store write failed',
        file: this.filePath,
        error: String(e),
      });
    }
  }
}

/**
 * Account pool: several Kiro accounts behind one gateway.
 *
 * Each account is a `SingleTokenManager` (same lazy refresh and refresh-lock
 * behaviour as single-credential mode) whose refreshed credential is written
 * to the JSON `AccountStore`. An optional kiro-cli SQLite credential joins the
 * pool as one more account and keeps writing back to SQLite.
 *
 * ## Selection
 *
 * 1. Stickiness: a conversation (`affinityKey`, the Kiro root conversation id)
 *    stays on the account that served it first. The upstream prefix cache is
 *    per account, so moving a long session costs a full uncached prompt.
 * 2. A new conversation goes to the usable account picked least recently,
 *    which spreads sessions round-robin.
 * 3. An account that is disabled, cooling down, or excluded by the executor
 *    (it already failed this request) is skipped; a sticky conversation whose
 *    account became unusable moves once and sticks to the new account.
 *
 * ## Cooldowns
 *
 * Account-scoped failures reported by the executor cool the account down:
 * 429 for `Retry-After` (default 60 s), quota exhausted for 6 h or until a
 * quota refresh shows headroom, unauthorized for 10 min. A refresh token the
 * OIDC service rejects as invalid disables the account until it logs in again.
 */

import type { LoadedCredentials } from '../kiro/credentials-loader.js';
import type { KiroCredentials } from '../kiro/model/credentials.js';
import type { UsageLimitsResponse } from '../kiro/model/usage-limits.js';
import { ProviderError } from '../kiro/provider-error.js';
import {
  type CredentialPersistence,
  RefreshTokenInvalidError,
  SingleTokenManager,
  sqlitePersistence,
} from '../kiro/token-manager.js';
import type {
  AccountOutcome,
  AcquireOptions,
  CallContext,
  TokenSource,
} from '../kiro/token-source.js';
import type { Config } from '../model/config.js';
import { getLogger } from '../shared/logger.js';
import { getRequestContext } from '../shared/request-context.js';
import {
  type AccountSource,
  type AccountStore,
  emptyStats,
  newAccountId,
  type StoredAccount,
} from './account-store.js';

const KIRO_CLI_ACCOUNT_ID = 'kiro-cli';
const AFFINITY_TTL_MS = 6 * 3_600_000;
const AFFINITY_MAX = 10_000;
const COOLDOWN = {
  rateLimitedDefaultS: 60,
  rateLimitedMaxS: 3_600,
  quotaMs: 6 * 3_600_000,
  unauthorizedMs: 10 * 60_000,
  refreshFailedMs: 5 * 60_000,
};

interface Slot {
  account: StoredAccount;
  manager: SingleTokenManager;
  cooldownUntil: number;
  cooldownReason?: string;
  lastPickedAt: number;
}

export interface AccountView {
  id: string;
  name: string;
  enabled: boolean;
  source: AccountSource;
  createdAt: string;
  startUrl?: string;
  region?: string;
  email?: string;
  subscription?: string;
  quota?: StoredAccount['quota'];
  disabledReason?: string;
  status: 'ok' | 'cooling' | 'disabled';
  cooldownUntil?: string;
  cooldownReason?: string;
  tokenExpiresAt?: string;
  hasRefreshToken: boolean;
  stats: StoredAccount['stats'];
}

export interface NewAccount {
  name?: string;
  source: Exclude<AccountSource, 'kiro-cli'>;
  startUrl?: string;
  credentials: KiroCredentials;
}

export class AccountPool implements TokenSource {
  readonly #config: Config;
  readonly #store: AccountStore;
  readonly #slots = new Map<string, Slot>();
  readonly #affinity = new Map<string, { id: string; at: number }>();

  constructor(config: Config, store: AccountStore, kiroCli?: LoadedCredentials) {
    this.#config = config;
    this.#store = store;
    for (const account of store.list()) {
      if (account.source === KIRO_CLI_ACCOUNT_ID) continue;
      this.#slots.set(account.id, this.#makeSlot(account, this.#storePersistence(account.id)));
    }
    if (kiroCli) this.#attachKiroCli(kiroCli);
  }

  config(): Config {
    return this.#config;
  }

  failoverCapacity(): number {
    let n = 0;
    for (const s of this.#slots.values()) if (s.account.enabled) n++;
    return Math.max(n, 1);
  }

  async acquireContext(opts: AcquireOptions = {}): Promise<CallContext> {
    const skip = new Set(opts.exclude ?? []);
    let lastError: unknown;
    while (true) {
      const slot = this.#pick(opts.affinityKey, skip);
      if (!slot) {
        if (lastError) throw lastError;
        throw this.#noAccountError(skip);
      }
      try {
        const ctx = await slot.manager.acquireContext();
        slot.lastPickedAt = Date.now();
        if (opts.affinityKey) this.#setAffinity(opts.affinityKey, slot.account.id);
        const reqCtx = getRequestContext();
        if (reqCtx) reqCtx.accountId = slot.account.id;
        return { ...ctx, accountId: slot.account.id };
      } catch (e) {
        lastError = e;
        this.#onRefreshFailure(slot, e);
        skip.add(slot.account.id);
      }
    }
  }

  async forceRefreshToken(accountId?: string): Promise<void> {
    const slot = accountId ? this.#slots.get(accountId) : undefined;
    if (!slot) throw new Error(`unknown pool account: ${accountId}`);
    await slot.manager.forceRefreshToken();
  }

  /** `/kiro/usage`: the usage of the first usable account. */
  async getUsageLimits(): Promise<UsageLimitsResponse> {
    const slot = this.#pick(undefined, new Set());
    if (!slot) throw this.#noAccountError(new Set());
    return slot.manager.getUsageLimits();
  }

  reportOutcome(accountId: string | undefined, outcome: AccountOutcome): void {
    const slot = accountId ? this.#slots.get(accountId) : undefined;
    if (!slot) return;
    const { stats } = slot.account;
    const now = Date.now();
    if (outcome.kind === 'success') {
      stats.requests++;
      stats.lastUsedAt = new Date(now).toISOString();
      if (slot.cooldownUntil <= now) slot.cooldownReason = undefined;
      this.#store.scheduleSave();
      return;
    }
    stats.failures++;
    stats.lastErrorAt = new Date(now).toISOString();
    switch (outcome.kind) {
      case 'rate_limited': {
        const s = Math.min(
          outcome.retryAfterSeconds ?? COOLDOWN.rateLimitedDefaultS,
          COOLDOWN.rateLimitedMaxS,
        );
        this.#cool(slot, now + s * 1000, 'rate limited (429)');
        break;
      }
      case 'quota_exhausted':
        this.#cool(slot, now + COOLDOWN.quotaMs, 'quota exhausted');
        break;
      case 'unauthorized':
        this.#cool(slot, now + COOLDOWN.unauthorizedMs, 'upstream rejected the credential');
        break;
    }
    stats.lastError = slot.cooldownReason;
    this.#store.scheduleSave();
  }

  /** Credits billed upstream for a request this account served. */
  recordCredits(accountId: string, credits: number): void {
    const slot = this.#slots.get(accountId);
    if (!slot || !Number.isFinite(credits)) return;
    slot.account.stats.credits += credits;
    if (slot.account.quota) slot.account.quota.current += credits;
    this.#store.scheduleSave();
  }

  /** Sum of the last known quotas of enabled accounts (for the metering plugin). */
  aggregateQuota(): { limit: number; current: number } {
    let limit = 0;
    let current = 0;
    for (const s of this.#slots.values()) {
      if (!s.account.enabled || !s.account.quota) continue;
      limit += s.account.quota.limit;
      current += s.account.quota.current;
    }
    return { limit, current };
  }

  // ==========================================================================
  // Admin operations
  // ==========================================================================

  list(): AccountView[] {
    const now = Date.now();
    return [...this.#slots.values()].map((s) => {
      const creds = s.manager.credentials();
      const cooling = s.cooldownUntil > now;
      return {
        id: s.account.id,
        name: s.account.name,
        enabled: s.account.enabled,
        source: s.account.source,
        createdAt: s.account.createdAt,
        startUrl: s.account.startUrl,
        region: creds.region,
        email: s.account.email,
        subscription: s.account.subscription,
        quota: s.account.quota,
        disabledReason: s.account.disabledReason,
        status: !s.account.enabled ? 'disabled' : cooling ? 'cooling' : 'ok',
        cooldownUntil: cooling ? new Date(s.cooldownUntil).toISOString() : undefined,
        cooldownReason: cooling ? s.cooldownReason : undefined,
        tokenExpiresAt: creds.expiresAt,
        hasRefreshToken: Boolean(creds.refreshToken),
        stats: s.account.stats,
      };
    });
  }

  has(id: string): boolean {
    return this.#slots.has(id);
  }

  /** Add an account and verify it with one token refresh. Returns its id. */
  async addAccount(input: NewAccount): Promise<{ id: string; verified: boolean; error?: string }> {
    const id = newAccountId();
    const account: StoredAccount = {
      id,
      name: input.name?.trim() || `account-${id}`,
      enabled: true,
      createdAt: new Date().toISOString(),
      source: input.source,
      startUrl: input.startUrl,
      credentials: { ...input.credentials },
      stats: emptyStats(),
    };
    this.#store.add(account);
    const slot = this.#makeSlot(account, this.#storePersistence(id));
    this.#slots.set(id, slot);
    try {
      await slot.manager.acquireContext();
      await this.refreshQuota(id).catch(() => undefined);
      return { id, verified: true };
    } catch (e) {
      this.#onRefreshFailure(slot, e);
      return { id, verified: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  update(id: string, patch: { name?: string; enabled?: boolean }): boolean {
    const slot = this.#slots.get(id);
    if (!slot) return false;
    if (patch.name?.trim()) slot.account.name = patch.name.trim();
    if (patch.enabled !== undefined) {
      slot.account.enabled = patch.enabled;
      if (patch.enabled) {
        slot.account.disabledReason = undefined;
        slot.cooldownUntil = 0;
        slot.cooldownReason = undefined;
      }
    }
    this.#store.saveNow();
    return true;
  }

  /** Remove an account. The kiro-cli account can only be disabled. */
  remove(id: string): boolean {
    const slot = this.#slots.get(id);
    if (!slot || slot.account.source === KIRO_CLI_ACCOUNT_ID) return false;
    this.#slots.delete(id);
    for (const [k, v] of this.#affinity) if (v.id === id) this.#affinity.delete(k);
    return this.#store.remove(id);
  }

  /** Query the upstream quota (and account email) of one account. */
  async refreshQuota(id: string): Promise<StoredAccount['quota']> {
    const slot = this.#slots.get(id);
    if (!slot) throw new Error(`unknown pool account: ${id}`);
    const raw = await slot.manager.getUsageLimits();
    const b = raw.usageBreakdownList?.[0];
    const quota = {
      limit: b?.usageLimitWithPrecision ?? b?.usageLimit ?? 0,
      current: b?.currentUsageWithPrecision ?? b?.currentUsage ?? 0,
      checkedAt: new Date().toISOString(),
    };
    slot.account.quota = quota;
    if (raw.userInfo?.email) slot.account.email = raw.userInfo.email;
    if (raw.subscriptionInfo?.subscriptionTitle) {
      slot.account.subscription = raw.subscriptionInfo.subscriptionTitle;
    }
    if (quota.limit > 0 && quota.current >= quota.limit) {
      const resetAt = (b?.nextDateReset ?? raw.nextDateReset ?? 0) * 1000;
      this.#cool(
        slot,
        resetAt > Date.now() ? resetAt : Date.now() + COOLDOWN.quotaMs,
        'quota exhausted',
      );
    } else if (slot.cooldownReason === 'quota exhausted') {
      slot.cooldownUntil = 0;
      slot.cooldownReason = undefined;
    }
    this.#store.saveNow();
    return quota;
  }

  /** Refresh every enabled account once (startup self-check). */
  async warmup(): Promise<void> {
    await Promise.all(
      [...this.#slots.values()]
        .filter((s) => s.account.enabled)
        .map(async (s) => {
          try {
            await s.manager.acquireContext();
            await this.refreshQuota(s.account.id).catch(() => undefined);
          } catch (e) {
            this.#onRefreshFailure(s, e);
          }
        }),
    );
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  #pick(affinityKey: string | undefined, skip: ReadonlySet<string>): Slot | undefined {
    const now = Date.now();
    const usable = (s: Slot) =>
      s.account.enabled && s.cooldownUntil <= now && !skip.has(s.account.id);
    if (affinityKey) {
      const hit = this.#affinity.get(affinityKey);
      const slot = hit && now - hit.at < AFFINITY_TTL_MS ? this.#slots.get(hit.id) : undefined;
      if (slot && usable(slot)) return slot;
    }
    let best: Slot | undefined;
    for (const s of this.#slots.values()) {
      if (usable(s) && (!best || s.lastPickedAt < best.lastPickedAt)) best = s;
    }
    return best;
  }

  #setAffinity(key: string, id: string): void {
    this.#affinity.delete(key);
    this.#affinity.set(key, { id, at: Date.now() });
    if (this.#affinity.size > AFFINITY_MAX) {
      const oldest = this.#affinity.keys().next().value;
      if (oldest !== undefined) this.#affinity.delete(oldest);
    }
  }

  #cool(slot: Slot, until: number, reason: string): void {
    slot.cooldownUntil = Math.max(slot.cooldownUntil, until);
    slot.cooldownReason = reason;
    getLogger().warn({
      msg: 'pool account cooling down',
      account: slot.account.id,
      reason,
      until: new Date(slot.cooldownUntil).toISOString(),
    });
  }

  #onRefreshFailure(slot: Slot, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    slot.account.stats.failures++;
    slot.account.stats.lastError = message.slice(0, 300);
    slot.account.stats.lastErrorAt = new Date().toISOString();
    if (e instanceof RefreshTokenInvalidError) {
      slot.account.enabled = false;
      slot.account.disabledReason = 'refresh token rejected — log this account in again';
      getLogger().warn({ msg: 'pool account disabled', account: slot.account.id, error: message });
      this.#store.saveNow();
      return;
    }
    this.#cool(slot, Date.now() + COOLDOWN.refreshFailedMs, 'token refresh failed');
    this.#store.scheduleSave();
  }

  #noAccountError(skip: ReadonlySet<string>): ProviderError {
    const now = Date.now();
    let soonest = Number.POSITIVE_INFINITY;
    for (const s of this.#slots.values()) {
      if (s.account.enabled && !skip.has(s.account.id) && s.cooldownUntil > now) {
        soonest = Math.min(soonest, s.cooldownUntil);
      }
    }
    if (Number.isFinite(soonest)) {
      return new ProviderError(
        { kind: 'rate_limited', status: 429, retryAfterSeconds: Math.ceil((soonest - now) / 1000) },
        '',
        'all pool accounts are cooling down',
      );
    }
    return new ProviderError({ kind: 'transient', status: 503 }, '', 'no usable pool account');
  }

  #makeSlot(account: StoredAccount, persistence: CredentialPersistence): Slot {
    return {
      account,
      manager: new SingleTokenManager(this.#config, account.credentials, persistence),
      cooldownUntil: 0,
      lastPickedAt: 0,
    };
  }

  #storePersistence(id: string): CredentialPersistence {
    const self: CredentialPersistence = {
      save: (credentials) => {
        const account = this.#store.get(id);
        if (!account) return;
        account.credentials = { ...credentials };
        this.#store.saveNow();
      },
      // A pool account has no external writer, so a re-read never yields a newer credential.
      reload: () => undefined,
    };
    return self;
  }

  #attachKiroCli(loaded: LoadedCredentials): void {
    let account = this.#store.get(KIRO_CLI_ACCOUNT_ID);
    if (!account) {
      account = {
        id: KIRO_CLI_ACCOUNT_ID,
        name: 'kiro-cli (SQLite)',
        enabled: true,
        createdAt: new Date().toISOString(),
        source: 'kiro-cli',
        credentials: {},
        stats: emptyStats(),
      };
      this.#store.add(account);
    }
    const slot: Slot = {
      account,
      manager: new SingleTokenManager(
        this.#config,
        loaded.credentials,
        sqlitePersistence(loaded.source),
      ),
      cooldownUntil: 0,
      lastPickedAt: 0,
    };
    this.#slots.set(KIRO_CLI_ACCOUNT_ID, slot);
  }
}

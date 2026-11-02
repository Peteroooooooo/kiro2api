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
 * 1. Soft stickiness: a conversation (`affinityKey`, the Kiro root conversation
 *    id) stays on the account that served it first. The upstream prefix cache is
 *    per account, so moving a long session costs a full uncached prompt.
 * 2. …unless that account already has `poolMaxInflight` requests in flight
 *    (default 4). Then this one request spills to the least-loaded account while
 *    the conversation keeps its home: a main agent plus parallel subagents share
 *    one root id, and piling all of them onto one account is what trips the
 *    per-user `USER_REQUEST_RATE_EXCEEDED` limit.
 * 3. A new conversation goes to the usable account with the fewest requests in
 *    flight, ties broken by least recently picked (round-robin).
 * 4. An account that is disabled, cooling down, cooling for the requested model,
 *    or excluded by the executor (it already failed this request) is skipped; a
 *    sticky conversation whose account became unusable moves and sticks to the
 *    new account.
 * 5. An account whose plan does not offer the requested model (its
 *    ListAvailableModels list, refreshed at startup, on "查额度" and every few
 *    hours) is skipped too. If no enabled account offers it, the request fails
 *    with `model_unavailable` without reaching the upstream.
 *
 * In-flight counting needs a request context: the lease lives on it and is
 * released when the HTTP response closes (index.ts), so a stream counts until
 * its last byte. Calls outside a request (startup, tests) are not counted.
 *
 * ## Cooldowns
 *
 * Account-scoped failures reported by the executor cool the account down:
 *
 * - 429 (per-user / credit rate): upstream `Retry-After` when given, else an
 *   adaptive 5 s → 10 s → 20 s … capped at `poolCooldownMaxS` (default 120),
 *   reset by the next success. A flat 60 s used to bench an account that was
 *   fine again seconds later and turn one 429 into a minute of gateway 429s.
 * - Model capacity (429 `INSUFFICIENT_MODEL_CAPACITY`, 5xx
 *   `MODEL_TEMPORARILY_UNAVAILABLE`): only that model on that account, 15 s.
 * - Quota exhausted 6 h or until a quota refresh shows headroom; unauthorized
 *   10 min. A refresh token the OIDC service rejects as invalid disables the
 *   account until it logs in again.
 *
 * ## When nothing is usable
 *
 * If the earliest recovery is within `poolWaitMs` (default 8 s) the gateway
 * waits for it — nothing has been sent downstream yet, so the client never sees
 * it. Otherwise it answers 429 with a Retry-After equal to that recovery time,
 * instead of a 429 the client retries straight into again.
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
import { getRequestContext, type RequestContext } from '../shared/request-context.js';
import { noteAccountAttempt } from '../shared/request-log.js';
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
  /** First adaptive step for a 429 without Retry-After; doubles per consecutive 429. */
  rateLimitedBaseS: 5,
  rateLimitedDefaultMaxS: 120,
  /** Hard cap, also for an upstream Retry-After. */
  rateLimitedMaxS: 3_600,
  capacityMs: 15_000,
  quotaMs: 6 * 3_600_000,
  unauthorizedMs: 10 * 60_000,
  refreshFailedMs: 5 * 60_000,
};
const DEFAULT_MAX_INFLIGHT = 4;
const DEFAULT_WAIT_MS = 8_000;
/** Slack added to a wait so the cooldown has really expired when we wake. */
const WAIT_SLACK_MS = 20;

interface Slot {
  account: StoredAccount;
  manager: SingleTokenManager;
  cooldownUntil: number;
  cooldownReason?: string;
  lastPickedAt: number;
  /** Requests currently holding a lease on this account. */
  inflight: number;
  /** Consecutive account-scoped 429s; drives the adaptive cooldown, reset by a success. */
  strikes: number;
  /** Per-model capacity cooldowns: upstream model id → until (epoch ms). */
  modelCooldowns: Map<string, number>;
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
  /** Models cooling on this account after a capacity error: model id → until (ISO). */
  modelCooldowns?: Record<string, string>;
  /** Requests in flight on this account right now. */
  inflight: number;
  tokenExpiresAt?: string;
  hasRefreshToken: boolean;
  /** Upstream ids of the models the account's plan offers; absent until first queried. */
  models?: readonly string[];
  stats: StoredAccount['stats'];
}

export interface NewAccount {
  name?: string;
  source: Exclude<AccountSource, 'kiro-cli'>;
  startUrl?: string;
  credentials: KiroCredentials;
}

export interface ExportedAccount {
  name: string;
  email?: string;
  subscription?: string;
  source: AccountSource;
  startUrl?: string;
  credentials: Omit<KiroCredentials, 'accessToken' | 'expiresAt'>;
}

/** Name given to an account added without one, until its email is known. */
export function placeholderName(id: string): string {
  return `account-${id}`;
}

/** Whether the account may serve `model`; an account whose list is not known yet is not filtered. */
function offers(slot: Slot, model: string | undefined): boolean {
  const models = slot.account.models;
  return !model || !models || models.includes(model);
}

/** Until when `model` cools on this account after a capacity error (0 = not cooling). */
function modelCooldownUntil(slot: Slot, model: string | undefined): number {
  return model ? (slot.modelCooldowns.get(model) ?? 0) : 0;
}

function modelCooling(slot: Slot, model: string | undefined, now: number): boolean {
  return modelCooldownUntil(slot, model) > now;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AccountPool implements TokenSource {
  readonly #config: Config;
  readonly #store: AccountStore;
  readonly #slots = new Map<string, Slot>();
  readonly #affinity = new Map<string, { id: string; at: number }>();
  readonly #renameListeners: ((id: string, from: string, to: string) => void)[] = [];

  constructor(config: Config, store: AccountStore, kiroCli?: LoadedCredentials) {
    this.#config = config;
    this.#store = store;
    let renamed = false;
    for (const account of store.list()) {
      if (account.source === KIRO_CLI_ACCOUNT_ID) continue;
      if (account.email && account.name === placeholderName(account.id)) {
        account.name = account.email;
        renamed = true;
      }
      this.#slots.set(account.id, this.#makeSlot(account, this.#storePersistence(account.id)));
    }
    if (renamed) store.saveNow();
    if (kiroCli) this.#attachKiroCli(kiroCli);
  }

  /** Called after an account's display name changes (admin rename, or placeholder → email). */
  onRename(listener: (id: string, from: string, to: string) => void): void {
    this.#renameListeners.push(listener);
  }

  config(): Config {
    return this.#config;
  }

  failoverCapacity(model?: string): number {
    let n = 0;
    for (const s of this.#slots.values()) if (s.account.enabled && offers(s, model)) n++;
    return Math.max(n, 1);
  }

  async acquireContext(opts: AcquireOptions = {}): Promise<CallContext> {
    const skip = new Set(opts.exclude ?? []);
    const waitBudget = this.#config.poolWaitMs ?? DEFAULT_WAIT_MS;
    const waitDeadline = Date.now() + waitBudget;
    let waited = 0;
    let lastError: unknown;
    while (true) {
      const picked = this.#pick(opts.affinityKey, skip, opts.model);
      if (!picked) {
        if (lastError) throw lastError;
        // Everything is cooling: if the earliest recovery is close, wait for it
        // here (nothing has gone downstream yet) instead of answering a 429 the
        // client would retry straight into.
        const recovery = this.#soonestRecovery(skip, opts.model);
        const now = Date.now();
        if (recovery !== undefined && recovery + WAIT_SLACK_MS <= waitDeadline) {
          const ms = Math.max(recovery - now, 0) + WAIT_SLACK_MS;
          waited += ms;
          await sleep(ms);
          continue;
        }
        if (waited > 0) {
          getLogger().info({ msg: 'pool wait gave up', waited_ms: waited, model: opts.model });
        }
        throw this.#noAccountError(skip, opts.model);
      }
      const { slot, spilled } = picked;
      try {
        const ctx = await slot.manager.acquireContext();
        slot.lastPickedAt = Date.now();
        if (opts.affinityKey && !spilled) this.#setAffinity(opts.affinityKey, slot.account.id);
        const reqCtx = getRequestContext();
        if (reqCtx) {
          reqCtx.accountId = slot.account.id;
          this.#lease(reqCtx, slot);
        }
        noteAccountAttempt(slot.account.id);
        if (waited > 0 || spilled) {
          getLogger().info({
            msg: spilled ? 'pool request spilled off its sticky account' : 'pool wait succeeded',
            account: slot.account.id,
            waited_ms: waited > 0 ? waited : undefined,
            inflight: slot.inflight,
          });
        }
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
    const slot = this.#pick(undefined, new Set())?.slot;
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
      slot.strikes = 0;
      if (slot.cooldownUntil <= now) slot.cooldownReason = undefined;
      this.#store.scheduleSave();
      return;
    }
    stats.failures++;
    stats.lastErrorAt = new Date(now).toISOString();
    switch (outcome.kind) {
      case 'rate_limited': {
        const cap = this.#config.poolCooldownMaxS ?? COOLDOWN.rateLimitedDefaultMaxS;
        const adaptive = Math.min(COOLDOWN.rateLimitedBaseS * 2 ** slot.strikes, cap);
        const s = Math.min(outcome.retryAfterSeconds ?? adaptive, COOLDOWN.rateLimitedMaxS);
        slot.strikes++;
        const why = outcome.reason ? `rate limited (429 ${outcome.reason})` : 'rate limited (429)';
        this.#cool(slot, now + s * 1000, why);
        break;
      }
      case 'capacity': {
        const reason = `model capacity${outcome.model ? ` (${outcome.model})` : ''}`;
        if (outcome.model) {
          const until = now + COOLDOWN.capacityMs;
          slot.modelCooldowns.set(outcome.model, until);
          getLogger().warn({
            msg: 'pool account model cooling down',
            account: slot.account.id,
            model: outcome.model,
            until: new Date(until).toISOString(),
          });
        }
        stats.lastError = reason;
        this.#store.scheduleSave();
        return;
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
      const models = [...s.modelCooldowns].filter(([, until]) => until > now);
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
        modelCooldowns:
          models.length > 0
            ? Object.fromEntries(models.map(([m, until]) => [m, new Date(until).toISOString()]))
            : undefined,
        inflight: s.inflight,
        tokenExpiresAt: creds.expiresAt,
        hasRefreshToken: Boolean(creds.refreshToken),
        models: s.account.models,
        stats: s.account.stats,
      };
    });
  }

  has(id: string): boolean {
    return this.#slots.has(id);
  }

  nameOf(id: string): string | undefined {
    return this.#slots.get(id)?.account.name;
  }

  /**
   * Accounts with their current credentials, in a shape `parseImport` reads back
   * (`{ accounts: [{ name, email, startUrl, credentials }] }`). The access token
   * is left out: it is short-lived and the importing side refreshes anyway.
   * Unknown ids are skipped; no ids = every account, disabled ones included.
   */
  exportAccounts(ids?: readonly string[]): ExportedAccount[] {
    const slots = ids
      ? ids.map((id) => this.#slots.get(id)).filter((s): s is Slot => s !== undefined)
      : [...this.#slots.values()];
    return slots.map((s) => {
      const { accessToken: _access, expiresAt: _expires, ...credentials } = s.manager.credentials();
      return {
        name: s.account.name,
        email: s.account.email,
        subscription: s.account.subscription,
        source: s.account.source,
        startUrl: s.account.startUrl,
        credentials,
      };
    });
  }

  /** Add an account and verify it with one token refresh. Returns its id. */
  async addAccount(input: NewAccount): Promise<{ id: string; verified: boolean; error?: string }> {
    const id = newAccountId();
    const account: StoredAccount = {
      id,
      name: input.name?.trim() || placeholderName(id),
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
      await this.refreshAccount(id).catch(() => undefined);
      return { id, verified: true };
    } catch (e) {
      this.#onRefreshFailure(slot, e);
      return { id, verified: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  update(id: string, patch: { name?: string; enabled?: boolean }): boolean {
    const slot = this.#slots.get(id);
    if (!slot) return false;
    const before = slot.account.name;
    const name = patch.name?.trim();
    if (name) slot.account.name = name;
    if (patch.enabled !== undefined) {
      slot.account.enabled = patch.enabled;
      if (patch.enabled) {
        slot.account.disabledReason = undefined;
        slot.cooldownUntil = 0;
        slot.cooldownReason = undefined;
        slot.strikes = 0;
        slot.modelCooldowns.clear();
      }
    }
    this.#store.saveNow();
    if (slot.account.name !== before) this.#emitRename(slot, before);
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

  /** Quota and model list together (the admin "查额度" action, startup, a new account). */
  async refreshAccount(id: string): Promise<StoredAccount['quota']> {
    const [quota] = await Promise.all([
      this.refreshQuota(id),
      this.refreshModels(id).catch(() => undefined),
    ]);
    return quota;
  }

  /**
   * Query which models the account's plan offers. Requests for other models
   * skip the account; until the first successful query it is not filtered.
   */
  async refreshModels(id: string): Promise<readonly string[]> {
    const slot = this.#slots.get(id);
    if (!slot) throw new Error(`unknown pool account: ${id}`);
    let models: string[];
    try {
      models = [...new Set(await slot.manager.listAvailableModels())].sort();
    } catch (e) {
      getLogger().warn({
        msg: 'pool account model list query failed',
        account: id,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
    const before = slot.account.models;
    if (!before || before.join('\n') !== models.join('\n')) {
      getLogger().info({
        msg: 'pool account models updated',
        account: id,
        count: models.length,
        added: before ? models.filter((m) => !before.includes(m)) : undefined,
        removed: before?.filter((m) => !models.includes(m)),
      });
    }
    slot.account.models = models;
    slot.account.modelsCheckedAt = new Date().toISOString();
    this.#store.saveNow();
    return models;
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
    const before = slot.account.name;
    if (raw.userInfo?.email) {
      slot.account.email = raw.userInfo.email;
      if (before === placeholderName(id)) slot.account.name = raw.userInfo.email;
    }
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
    if (slot.account.name !== before) this.#emitRename(slot, before);
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
            await this.refreshAccount(s.account.id).catch(() => undefined);
          } catch (e) {
            this.#onRefreshFailure(s, e);
          }
        }),
    );
  }

  /** Re-read the model list of every enabled account (plans change without notice). */
  async refreshAllModels(): Promise<void> {
    await Promise.all(
      [...this.#slots.values()]
        .filter((s) => s.account.enabled)
        .map((s) => this.refreshModels(s.account.id).catch(() => undefined)),
    );
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  #pick(
    affinityKey: string | undefined,
    skip: ReadonlySet<string>,
    model?: string,
  ): { slot: Slot; spilled: boolean } | undefined {
    const now = Date.now();
    const usable = (s: Slot) =>
      s.account.enabled &&
      s.cooldownUntil <= now &&
      !skip.has(s.account.id) &&
      offers(s, model) &&
      !modelCooling(s, model, now);
    const maxInflight = this.#config.poolMaxInflight ?? DEFAULT_MAX_INFLIGHT;
    const full = (s: Slot) => maxInflight > 0 && s.inflight >= maxInflight;

    let best: Slot | undefined;
    for (const s of this.#slots.values()) {
      if (!usable(s)) continue;
      if (
        !best ||
        s.inflight < best.inflight ||
        (s.inflight === best.inflight && s.lastPickedAt < best.lastPickedAt)
      ) {
        best = s;
      }
    }

    if (affinityKey) {
      const hit = this.#affinity.get(affinityKey);
      const home = hit && now - hit.at < AFFINITY_TTL_MS ? this.#slots.get(hit.id) : undefined;
      if (home && usable(home)) {
        // Over the in-flight cap and someone else has room: spill this one
        // request, keep the conversation's home (spilled=true → no re-pin).
        if (full(home) && best && best !== home && best.inflight < home.inflight) {
          return { slot: best, spilled: true };
        }
        return { slot: home, spilled: false };
      }
    }
    return best ? { slot: best, spilled: false } : undefined;
  }

  /** Count this request against `slot` until its response closes; moves on failover. */
  #lease(reqCtx: RequestContext, slot: Slot): void {
    reqCtx.poolLease?.release();
    let released = false;
    slot.inflight++;
    reqCtx.poolLease = {
      accountId: slot.account.id,
      release: () => {
        if (released) return;
        released = true;
        slot.inflight = Math.max(0, slot.inflight - 1);
      },
    };
  }

  /** Earliest moment an account that could serve `model` stops cooling, if any. */
  #soonestRecovery(skip: ReadonlySet<string>, model?: string): number | undefined {
    const now = Date.now();
    let soonest = Number.POSITIVE_INFINITY;
    for (const s of this.#slots.values()) {
      if (!s.account.enabled || skip.has(s.account.id) || !offers(s, model)) continue;
      const until = Math.max(s.cooldownUntil, modelCooldownUntil(s, model));
      if (until > now) soonest = Math.min(soonest, until);
    }
    return Number.isFinite(soonest) ? soonest : undefined;
  }

  #setAffinity(key: string, id: string): void {
    this.#affinity.delete(key);
    this.#affinity.set(key, { id, at: Date.now() });
    if (this.#affinity.size > AFFINITY_MAX) {
      const oldest = this.#affinity.keys().next().value;
      if (oldest !== undefined) this.#affinity.delete(oldest);
    }
  }

  #emitRename(slot: Slot, from: string): void {
    for (const listener of this.#renameListeners) {
      try {
        listener(slot.account.id, from, slot.account.name);
      } catch (e) {
        getLogger().warn({ msg: 'account rename listener failed', error: String(e) });
      }
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

  #noAccountError(skip: ReadonlySet<string>, model?: string): ProviderError {
    const now = Date.now();
    const enabled = [...this.#slots.values()].filter((s) => s.account.enabled);
    if (model && enabled.length > 0 && !enabled.some((s) => offers(s, model))) {
      return new ProviderError({ kind: 'model_unavailable', model }, '');
    }
    let soonest = Number.POSITIVE_INFINITY;
    for (const s of enabled) {
      if (!offers(s, model) || skip.has(s.account.id)) continue;
      const until = Math.max(s.cooldownUntil, modelCooldownUntil(s, model));
      if (until > now) soonest = Math.min(soonest, until);
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
      inflight: 0,
      strikes: 0,
      modelCooldowns: new Map(),
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
      inflight: 0,
      strikes: 0,
      modelCooldowns: new Map(),
    };
    this.#slots.set(KIRO_CLI_ACCOUNT_ID, slot);
  }
}

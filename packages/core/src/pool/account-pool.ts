/**
 * Account pool: several Kiro accounts behind one gateway.
 *
 * Each account is a `SingleTokenManager` (same lazy refresh and refresh-lock
 * behaviour as single-credential mode) whose refreshed credential is written
 * to the JSON `AccountStore`. An optional kiro-cli SQLite credential joins the
 * pool as one more account and keeps writing back to SQLite.
 *
 * ## Rule: throttles wait, only account faults switch
 *
 * A 429 (per-user rate, `INSUFFICIENT_MODEL_CAPACITY`) or a 5xx capacity answer
 * is a throttle, not a broken account. Switching accounts on it buys nothing —
 * on 11-02/11-03 the second account refused the same model within a second —
 * and costs the conversation its per-account prompt cache. So a throttle puts a
 * short back-off **hold** on the account (or on that model on the account) and
 * the request waits it out and retries on the **same** account. Only quota
 * exhausted, a rejected credential or a failed refresh moves a conversation.
 *
 * ## Selection
 *
 * 1. Stickiness: a conversation (`affinityKey` = Kiro `conversationId`) stays on
 *    the account that served it first, also while that account is on hold.
 *    Subagents have their own conversationId, so each subagent sticks to one
 *    account of its own instead of hopping per turn.
 * 2. A subagent seen for the first time starts on its root conversation's account
 *    (`rootKey`) when that has fewer than `poolMaxInflight` (default 4) requests
 *    in flight and is not on hold; otherwise it is placed like a new conversation.
 * 3. A new conversation goes to an account with no hold, fewest requests in
 *    flight, ties broken by least recently picked. If every account is on hold it
 *    takes the one that frees up first and waits.
 * 4. Disabled / hard-cooling accounts (quota, credential), accounts the executor
 *    excluded, and accounts whose plan lacks the model (ListAvailableModels) are
 *    skipped. If no enabled account offers the model: `model_unavailable`, nothing
 *    is sent upstream.
 *
 * In-flight counting needs a request context: the lease lives on it and is
 * released when the HTTP response closes (index.ts), so a stream counts until
 * its last byte. Calls outside a request (startup, tests) are not counted.
 *
 * ## Holds (throttles)
 *
 * Upstream `Retry-After` when given, else 2 s → 4 s → 8 s → capped at
 * `poolBackoffMaxS` (default 15), each with ±25 % jitter so waiting requests do
 * not wake together and hit the upstream in a burst. Every request for that
 * account/model waits for the same hold. A success resets the step.
 *
 * A request waits at most `poolThrottleWaitMs` (default 45 s) in total, before
 * any byte goes downstream; past that it answers 429 with a Retry-After of the
 * remaining hold.
 *
 * ## Hard cooldowns (account faults)
 *
 * Unauthorized 10 min; token refresh failure 5 min. A refresh token the OIDC
 * service rejects as invalid disables the account until it logs in again.
 *
 * ## Quota used up: auto-disable, auto re-enable
 *
 * An account is used up when the monthly plan and every active extra grant are.
 * The upstream quota query is the judge: when it says so, the account is
 * disabled with `autoEnableAt` = the upstream reset (`nextDateReset`), persisted.
 * Billed credits since the last query (`sinceCheck`) only trigger such a query
 * once they push the estimate over the limit (one in flight per account). A
 * request rejected as quota exhausted disables at once (last known reset, else
 * 6 h) and queries for the real reset time. At `autoEnableAt` a sweep turns the
 * account back on and queries again; still used up = disabled again until the
 * next reset. Accounts disabled by hand have no `autoEnableAt` and are never
 * turned on by the pool; enabling or disabling by hand clears it.
 */

import type { LoadedCredentials } from '../kiro/credentials-loader.js';
import type { KiroCredentials } from '../kiro/model/credentials.js';
import type { UsageBreakdown, UsageLimitsResponse } from '../kiro/model/usage-limits.js';
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
import { noteAccountAttempt, noteThrottleWait } from '../shared/request-log.js';
import {
  type AccountSource,
  type AccountStore,
  type ExtraQuota,
  emptyStats,
  newAccountId,
  type StoredAccount,
} from './account-store.js';

/**
 * Active bonus / free-trial credits of a usage breakdown, summed. Upstream timestamps are
 * seconds. Grants that are not ACTIVE or already expired are left out.
 */
export function extraQuotaOf(
  b: UsageBreakdown | undefined,
  now = Date.now(),
): ExtraQuota | undefined {
  if (!b) return undefined;
  type Grant = { limit: number; current: number; expiresAt?: number; status?: string };
  const grants: Grant[] = (b.bonuses ?? []).map((x) => ({
    limit: x.usageLimit,
    current: x.currentUsage,
    expiresAt: x.expiresAt,
    status: x.status,
  }));
  const t = b.freeTrialInfo;
  if (t) {
    grants.push({
      limit: t.usageLimitWithPrecision ?? t.usageLimit,
      current: t.currentUsageWithPrecision ?? t.currentUsage,
      expiresAt: t.freeTrialExpiry,
      status: t.freeTrialStatus,
    });
  }
  let limit = 0;
  let current = 0;
  let earliest: number | undefined;
  for (const g of grants) {
    if (g.status !== undefined && g.status !== 'ACTIVE') continue;
    if (g.expiresAt !== undefined && g.expiresAt * 1000 <= now) continue;
    if (!(g.limit > 0)) continue;
    limit += g.limit;
    current += Number.isFinite(g.current) ? g.current : 0;
    if (g.expiresAt !== undefined && (earliest === undefined || g.expiresAt < earliest))
      earliest = g.expiresAt;
  }
  if (limit <= 0) return undefined;
  return {
    limit,
    current,
    ...(earliest !== undefined ? { expiresAt: new Date(earliest * 1000).toISOString() } : {}),
  };
}

/** Credits left on the active extra grants of a snapshot (0 when none or expired). */
function extraLeft(q: NonNullable<StoredAccount['quota']>, now: number): number {
  const x = q.extra;
  if (!x || (x.expiresAt && Date.parse(x.expiresAt) <= now)) return 0;
  return Math.max(0, x.limit - x.current);
}

/** True when the upstream snapshot says neither the monthly plan nor any active extra grant has credits left. */
function quotaExhausted(q: StoredAccount['quota'], now = Date.now()): boolean {
  if (!q || !(q.limit > 0) || q.current < q.limit) return false;
  return extraLeft(q, now) <= 0;
}

/**
 * Estimate only: the snapshot plus the credits billed since it reach the plan plus the
 * remaining extra. Never disables by itself; it triggers an upstream quota query.
 */
function quotaEstimateExhausted(q: StoredAccount['quota'], now = Date.now()): boolean {
  if (!q || !(q.limit > 0)) return false;
  return q.current + (q.sinceCheck ?? 0) >= q.limit + extraLeft(q, now);
}

const QUOTA_DISABLED_REASON = 'quota used up (monthly plan and extra credits)';

const KIRO_CLI_ACCOUNT_ID = 'kiro-cli';
const AFFINITY_TTL_MS = 6 * 3_600_000;
const AFFINITY_MAX = 10_000;
const QUOTA = {
  /** Auto re-enable after this when the upstream gave no reset time. */
  fallbackMs: 6 * 3_600_000,
  /** The reset time has passed but the upstream still says used up: look again after this. */
  recheckMs: 15 * 60_000,
  /** Least gap between two estimate-triggered quota queries of one account. */
  estimateGapMs: 30_000,
  sweepMs: 60_000,
};
const COOLDOWN = {
  unauthorizedMs: 10 * 60_000,
  refreshFailedMs: 5 * 60_000,
};
const BACKOFF = {
  /** First back-off step after a throttle without Retry-After; doubles per consecutive throttle. */
  baseMs: 2_000,
  defaultMaxS: 15,
  /** Hard cap, also for an upstream Retry-After. */
  retryAfterMaxMs: 3_600_000,
  /** ± fraction of random jitter on each step. */
  jitter: 0.25,
};
const DEFAULT_MAX_INFLIGHT = 4;
const DEFAULT_THROTTLE_WAIT_MS = 45_000;
/** Slack added to a wait so the hold has really expired when we wake. */
const WAIT_SLACK_MS = 20;
/** Random extra per waiter, so requests waiting on one hold do not retry together. */
const WAITER_SPREAD_MS = 400;

/** A back-off hold after a throttle: requests wait for it, the account stays in rotation. */
interface Hold {
  until: number;
  /** Consecutive throttles; drives the back-off step, reset by a success. */
  strikes: number;
  reason?: string;
}

interface Slot {
  account: StoredAccount;
  manager: SingleTokenManager;
  /** Hard cooldown (credential): the account is out of rotation until then. */
  cooldownUntil: number;
  cooldownReason?: string;
  lastPickedAt: number;
  /** Requests currently holding a lease on this account. */
  inflight: number;
  /** Account-wide hold after a per-user / credit-rate 429. */
  hold: Hold;
  /** Per-model holds after a capacity answer: upstream model id → hold. */
  modelHolds: Map<string, Hold>;
  /** Last estimate-triggered quota query (ms), to space them out. */
  estimateCheckAt: number;
}

export interface ThrottleView {
  /** Upstream model id; absent = the whole account. */
  model?: string;
  until: string;
  reason?: string;
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
  /** Only for accounts the pool disabled because the quota ran out: when it turns them back on. */
  autoEnableAt?: string;
  status: 'ok' | 'cooling' | 'disabled';
  cooldownUntil?: string;
  cooldownReason?: string;
  /** Back-off holds after throttles (account-wide and per model); the account stays in rotation. */
  throttles?: ThrottleView[];
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

/** Until when requests for `model` on this account must wait (0 = no hold). */
function holdUntil(slot: Slot, model: string | undefined): number {
  const modelHold = model ? (slot.modelHolds.get(model)?.until ?? 0) : 0;
  return Math.max(slot.hold.until, modelHold);
}

/** Hard cooldown over, enabled, offers the model, not excluded. Holds do not count here. */
function inRotation(slot: Slot, model: string | undefined, skip: ReadonlySet<string>, now: number) {
  return (
    slot.account.enabled &&
    slot.cooldownUntil <= now &&
    !skip.has(slot.account.id) &&
    offers(slot, model)
  );
}

function newHold(): Hold {
  return { until: 0, strikes: 0 };
}

/** Next back-off step: Retry-After if the upstream gave one, else 2 s · 2^strikes (capped), jittered. */
function backoffMs(strikes: number, capS: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) {
    return Math.min(retryAfterSeconds * 1000, BACKOFF.retryAfterMaxMs);
  }
  const base = Math.min(BACKOFF.baseMs * 2 ** strikes, capS * 1000);
  const jitter = 1 + (Math.random() * 2 - 1) * BACKOFF.jitter;
  return Math.round(base * jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Picked {
  slot: Slot;
  /**
   * sticky = the conversation's own account; new = first placement; moved = its
   * account left rotation (re-pinned); spilled = home is full, this request only.
   */
  how: 'sticky' | 'new' | 'moved' | 'spilled';
}

export class AccountPool implements TokenSource {
  readonly #config: Config;
  readonly #store: AccountStore;
  readonly #slots = new Map<string, Slot>();
  readonly #affinity = new Map<string, { id: string; at: number }>();
  readonly #renameListeners: ((id: string, from: string, to: string) => void)[] = [];
  /** Quota queries the pool started on its own, one per account. */
  readonly #quotaChecks = new Map<string, Promise<void>>();
  #sweepTimer: NodeJS.Timeout | undefined;

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

  throttleBudgetMs(): number {
    return this.#config.poolThrottleWaitMs ?? DEFAULT_THROTTLE_WAIT_MS;
  }

  holdRemainingMs(accountId: string, model?: string): number {
    const slot = this.#slots.get(accountId);
    return slot ? Math.max(0, holdUntil(slot, model) - Date.now()) : 0;
  }

  async acquireContext(opts: AcquireOptions = {}): Promise<CallContext> {
    const skip = new Set(opts.exclude ?? []);
    const deadline = opts.deadline ?? Date.now() + this.throttleBudgetMs();
    let waited = 0;
    let lastError: unknown;
    while (true) {
      const picked = this.#pick(opts, skip);
      if (!picked) {
        if (lastError) throw lastError;
        throw this.#noAccountError(skip, opts.model);
      }
      const { slot, how } = picked;
      // On hold (throttled): wait here, on this account, before anything goes
      // downstream — unless the wait would run past the request's budget.
      const wait = holdUntil(slot, opts.model) - Date.now();
      if (wait > 0) {
        if (getRequestContext()?.closed || Date.now() + wait + WAIT_SLACK_MS > deadline) {
          getLogger().info({
            msg: 'pool throttle wait budget used up',
            account: slot.account.id,
            model: opts.model,
            waited_ms: waited,
            hold_ms: wait,
          });
          throw this.#throttledError(wait);
        }
        // Several requests can wait on one hold; a small per-waiter spread keeps
        // them from all hitting the upstream in the same millisecond.
        const ms = wait + WAIT_SLACK_MS + Math.floor(Math.random() * WAITER_SPREAD_MS);
        waited += ms;
        noteThrottleWait(ms);
        await sleep(ms);
        continue; // re-pick: an admin action may have changed the account meanwhile
      }
      try {
        const ctx = await slot.manager.acquireContext();
        slot.lastPickedAt = Date.now();
        if (opts.affinityKey && how !== 'spilled')
          this.#setAffinity(opts.affinityKey, slot.account.id);
        const reqCtx = getRequestContext();
        if (reqCtx) {
          reqCtx.accountId = slot.account.id;
          this.#lease(reqCtx, slot);
        }
        noteAccountAttempt(slot.account.id);
        if (waited > 0 || how === 'moved' || how === 'spilled') {
          const msg = {
            moved: 'pool conversation moved to another account',
            spilled: 'pool request spilled off its busy sticky account',
            sticky: 'pool wait succeeded',
            new: 'pool wait succeeded',
          }[how];
          getLogger().info({
            msg,
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
    const slot = this.#pick({}, new Set())?.slot;
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
      slot.hold.strikes = 0;
      if (outcome.model) slot.modelHolds.delete(outcome.model);
      if (slot.cooldownUntil <= now) slot.cooldownReason = undefined;
      this.#store.scheduleSave();
      return;
    }
    stats.failures++;
    stats.lastErrorAt = new Date(now).toISOString();
    switch (outcome.kind) {
      case 'rate_limited': {
        const why = outcome.reason ? `rate limited (429 ${outcome.reason})` : 'rate limited (429)';
        this.#hold(slot, slot.hold, outcome, why);
        stats.lastError = why;
        break;
      }
      case 'capacity': {
        const why = `model capacity${outcome.model ? ` (${outcome.model})` : ''}`;
        let hold = slot.hold;
        if (outcome.model) {
          hold = slot.modelHolds.get(outcome.model) ?? newHold();
          slot.modelHolds.set(outcome.model, hold);
        }
        this.#hold(slot, hold, outcome, why, outcome.model);
        stats.lastError = why;
        break;
      }
      case 'quota_exhausted': {
        // The request already proved the account cannot serve: disable now (until the
        // last known reset, else 6 h), then ask the upstream for the real reset time.
        // An account disabled by hand meanwhile stays a manual disable.
        stats.lastError = 'quota exhausted';
        if (!slot.account.enabled && slot.account.autoEnableAt === undefined) break;
        const known = Date.parse(slot.account.quota?.resetsAt ?? '');
        this.#autoDisable(slot, known > now ? known : now + QUOTA.fallbackMs, 'request rejected');
        this.#checkQuota(slot, 'request rejected');
        break;
      }
      case 'unauthorized':
        this.#cool(slot, now + COOLDOWN.unauthorizedMs, 'upstream rejected the credential');
        stats.lastError = slot.cooldownReason;
        break;
    }
    this.#store.scheduleSave();
  }

  /**
   * Credits billed upstream for a request this account served. The quota itself stays the
   * last upstream snapshot, because the billing event does not say which grant (monthly or
   * extra) paid for the request; the credits only add up in `quota.sinceCheck`.
   */
  recordCredits(accountId: string, credits: number): void {
    const slot = this.#slots.get(accountId);
    if (!slot || !Number.isFinite(credits)) return;
    slot.account.stats.credits += credits;
    const q = slot.account.quota;
    if (q) q.sinceCheck = (q.sinceCheck ?? 0) + credits;
    this.#store.scheduleSave();
    const now = Date.now();
    if (
      slot.account.enabled &&
      quotaEstimateExhausted(q, now) &&
      now - slot.estimateCheckAt >= QUOTA.estimateGapMs &&
      !this.#quotaChecks.has(accountId)
    ) {
      slot.estimateCheckAt = now;
      this.#checkQuota(slot, 'billed credits reached the limit');
    }
  }

  /** Wait for the quota queries the pool started on its own (tests, shutdown). */
  async settleQuotaChecks(): Promise<void> {
    while (this.#quotaChecks.size > 0) await Promise.all(this.#quotaChecks.values());
  }

  /**
   * Turn quota-disabled accounts whose `autoEnableAt` has come back on, then query their
   * quota; one still used up is disabled again until the next reset. Accounts without
   * `autoEnableAt` (disabled by hand, or for a credential) are never touched.
   */
  async sweepAutoEnable(now = Date.now()): Promise<void> {
    for (const slot of this.#slots.values()) {
      const at = Date.parse(slot.account.autoEnableAt ?? '');
      if (slot.account.enabled || !(at <= now)) continue;
      getLogger().info({
        msg: 'pool account re-enabled after quota reset',
        account: slot.account.id,
        auto_enable_at: slot.account.autoEnableAt,
      });
      this.#enable(slot);
      this.#store.saveNow();
      this.#checkQuota(slot, 'auto re-enabled');
    }
    await this.settleQuotaChecks();
  }

  /** Run `sweepAutoEnable` every minute (unref'd). */
  startAutoEnable(intervalMs = QUOTA.sweepMs): void {
    if (this.#sweepTimer) return;
    this.#sweepTimer = setInterval(() => void this.sweepAutoEnable(), intervalMs);
    this.#sweepTimer.unref();
  }

  stopAutoEnable(): void {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
  }

  /** Sum of the last upstream quota snapshots of enabled accounts; `extra` is the active bonus / trial credits. */
  aggregateQuota(): {
    limit: number;
    current: number;
    extra: { limit: number; current: number };
    sinceCheck: number;
  } {
    let limit = 0;
    let current = 0;
    let sinceCheck = 0;
    const extra = { limit: 0, current: 0 };
    for (const s of this.#slots.values()) {
      if (!s.account.enabled || !s.account.quota) continue;
      limit += s.account.quota.limit;
      current += s.account.quota.current;
      sinceCheck += s.account.quota.sinceCheck ?? 0;
      if (s.account.quota.extra) {
        extra.limit += s.account.quota.extra.limit;
        extra.current += s.account.quota.extra.current;
      }
    }
    return { limit, current, extra, sinceCheck };
  }

  // ==========================================================================
  // Admin operations
  // ==========================================================================

  list(): AccountView[] {
    const now = Date.now();
    return [...this.#slots.values()].map((s) => {
      const creds = s.manager.credentials();
      const cooling = s.cooldownUntil > now;
      const throttles: ThrottleView[] = [];
      if (s.hold.until > now) {
        throttles.push({ until: new Date(s.hold.until).toISOString(), reason: s.hold.reason });
      }
      for (const [model, h] of s.modelHolds) {
        if (h.until > now) {
          throttles.push({ model, until: new Date(h.until).toISOString(), reason: h.reason });
        }
      }
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
        autoEnableAt: s.account.enabled ? undefined : s.account.autoEnableAt,
        status: !s.account.enabled ? 'disabled' : cooling ? 'cooling' : 'ok',
        cooldownUntil: cooling ? new Date(s.cooldownUntil).toISOString() : undefined,
        cooldownReason: cooling ? s.cooldownReason : undefined,
        throttles: throttles.length > 0 ? throttles : undefined,
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
    if (patch.enabled === true) this.#enable(slot);
    else if (patch.enabled === false) {
      // Disabled by hand: stays off until enabled by hand, whatever disabled it before.
      slot.account.enabled = false;
      slot.account.disabledReason = undefined;
      slot.account.autoEnableAt = undefined;
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
    const extra = extraQuotaOf(b);
    const now = Date.now();
    const resetAt = (b?.nextDateReset ?? raw.nextDateReset ?? 0) * 1000;
    const quota = {
      limit: b?.usageLimitWithPrecision ?? b?.usageLimit ?? 0,
      current: b?.currentUsageWithPrecision ?? b?.currentUsage ?? 0,
      ...(extra ? { extra } : {}),
      sinceCheck: 0,
      checkedAt: new Date(now).toISOString(),
      ...(resetAt > 0 ? { resetsAt: new Date(resetAt).toISOString() } : {}),
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
    // Upstream is the judge. Used up: disable until the reset (a reset time already past
    // means the upstream has not rolled over yet, so look again soon). An account the pool
    // already disabled for quota takes the fresh reset time either way; it is turned back
    // on by the sweep or by hand, not here. Accounts disabled by hand are left alone.
    // Upstream showing credits left on an account a rejected request disabled is a
    // conflict (the snapshot can lag): it then comes back within 6 h at the latest.
    const autoDisabled = !slot.account.enabled && slot.account.autoEnableAt !== undefined;
    if (quotaExhausted(quota, now) && (slot.account.enabled || autoDisabled)) {
      const until =
        resetAt > now ? resetAt : now + (resetAt > 0 ? QUOTA.recheckMs : QUOTA.fallbackMs);
      this.#autoDisable(slot, until, 'upstream quota query');
    } else if (autoDisabled) {
      const until = Math.min(Date.parse(slot.account.autoEnableAt ?? ''), now + QUOTA.fallbackMs);
      slot.account.autoEnableAt = new Date(until).toISOString();
      getLogger().warn({
        msg: 'pool account was rejected for quota but the upstream shows credits left',
        account: id,
        auto_enable_at: slot.account.autoEnableAt,
      });
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

  #pick(opts: AcquireOptions, skip: ReadonlySet<string>): Picked | undefined {
    const now = Date.now();
    const { model } = opts;
    const ok = (s: Slot | undefined): s is Slot => !!s && inRotation(s, model, skip, now);

    // A throttle retry stays on the account it already used.
    const stay = opts.stayOn ? this.#slots.get(opts.stayOn) : undefined;
    if (ok(stay)) return { slot: stay, how: 'sticky' };

    // A known conversation stays home, even while home is on a throttle hold —
    // unless home already carries `poolMaxInflight` requests and another account
    // in rotation is idle-er and not on hold: then this one request spills there
    // (the conversation keeps its home). This only matters when parallel agents
    // share one conversation id (the client did not identify its subagents).
    const maxInflight = this.#config.poolMaxInflight ?? DEFAULT_MAX_INFLIGHT;
    let moved = false;
    if (opts.affinityKey) {
      const home = this.#home(opts.affinityKey, now);
      if (ok(home)) {
        if (maxInflight > 0 && home.inflight >= maxInflight) {
          const spill = this.#leastLoaded(ok, model, now);
          if (
            spill &&
            spill !== home &&
            spill.inflight < home.inflight &&
            holdUntil(spill, model) <= now
          ) {
            return { slot: spill, how: 'spilled' };
          }
        }
        return { slot: home, how: 'sticky' };
      }
      moved = home !== undefined;
    }

    // A new subagent starts on its root conversation's account when that has room.
    if (!moved && opts.rootKey && opts.rootKey !== opts.affinityKey) {
      const root = this.#home(opts.rootKey, now);
      const roomy = (s: Slot) => maxInflight <= 0 || s.inflight < maxInflight;
      if (ok(root) && roomy(root) && holdUntil(root, model) <= now) {
        return { slot: root, how: 'new' };
      }
    }

    const best = this.#leastLoaded(ok, model, now);
    return best ? { slot: best, how: moved ? 'moved' : 'new' } : undefined;
  }

  /**
   * New placement: not on hold first, then fewest in flight, then least recently
   * picked. If every candidate is on hold, the one that frees up first.
   */
  #leastLoaded(ok: (s: Slot) => boolean, model: string | undefined, now: number): Slot | undefined {
    let best: Slot | undefined;
    let bestHold = 0;
    for (const s of this.#slots.values()) {
      if (!ok(s)) continue;
      const h = Math.max(holdUntil(s, model), now);
      if (
        !best ||
        h < bestHold ||
        (h === bestHold &&
          (s.inflight < best.inflight ||
            (s.inflight === best.inflight && s.lastPickedAt < best.lastPickedAt)))
      ) {
        best = s;
        bestHold = h;
      }
    }
    return best;
  }

  #home(key: string, now: number): Slot | undefined {
    const hit = this.#affinity.get(key);
    return hit && now - hit.at < AFFINITY_TTL_MS ? this.#slots.get(hit.id) : undefined;
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

  /**
   * Start (or keep) a back-off hold. A throttle that lands while the hold is
   * still running came from a request sent before it began, so it neither
   * escalates the step nor shortens the hold; an upstream Retry-After can only
   * lengthen it.
   */
  #hold(
    slot: Slot,
    hold: Hold,
    outcome: { retryAfterSeconds?: number },
    reason: string,
    model?: string,
  ): void {
    const now = Date.now();
    const capS = this.#config.poolBackoffMaxS ?? BACKOFF.defaultMaxS;
    const running = hold.until > now;
    if (running && outcome.retryAfterSeconds === undefined) return;
    const ms = backoffMs(hold.strikes, capS, outcome.retryAfterSeconds);
    hold.until = Math.max(hold.until, now + ms);
    hold.reason = reason;
    if (!running) hold.strikes++;
    getLogger().info({
      msg: 'pool account throttled, requests wait on it',
      account: slot.account.id,
      model,
      reason,
      hold_ms: hold.until - now,
      strikes: hold.strikes,
    });
  }

  #throttledError(waitMs: number): ProviderError {
    return new ProviderError(
      {
        kind: 'rate_limited',
        status: 429,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      },
      '',
      'pool throttle wait budget used up',
    );
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

  /** Quota used up: out of rotation until `until`, when the sweep turns it back on. */
  #autoDisable(slot: Slot, until: number, trigger: string): void {
    const wasEnabled = slot.account.enabled;
    slot.account.enabled = false;
    slot.account.disabledReason = QUOTA_DISABLED_REASON;
    slot.account.autoEnableAt = new Date(until).toISOString();
    this.#store.saveNow();
    getLogger().warn({
      msg: wasEnabled ? 'pool account disabled, quota used up' : 'pool account quota re-checked',
      account: slot.account.id,
      trigger,
      auto_enable_at: slot.account.autoEnableAt,
    });
  }

  /** Same clean slate as an admin enable. */
  #enable(slot: Slot): void {
    slot.account.enabled = true;
    slot.account.disabledReason = undefined;
    slot.account.autoEnableAt = undefined;
    slot.cooldownUntil = 0;
    slot.cooldownReason = undefined;
    slot.hold = newHold();
    slot.modelHolds.clear();
  }

  /** Query the upstream quota in the background; one query in flight per account. */
  #checkQuota(slot: Slot, trigger: string): void {
    const id = slot.account.id;
    if (this.#quotaChecks.has(id)) return;
    const run = (async () => {
      try {
        await this.refreshQuota(id);
      } catch (e) {
        getLogger().warn({
          msg: 'pool account quota check failed',
          account: id,
          trigger,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        this.#quotaChecks.delete(id);
      }
    })();
    this.#quotaChecks.set(id, run);
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
      slot.account.autoEnableAt = undefined;
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
    // Only hard cooldowns (credential) and quota-disabled accounts can leave nothing in
    // rotation; answer 429 with the earliest time one of them comes back.
    let soonest = Number.POSITIVE_INFINITY;
    for (const s of this.#slots.values()) {
      if (!offers(s, model) || skip.has(s.account.id)) continue;
      if (s.account.enabled) {
        if (s.cooldownUntil > now) soonest = Math.min(soonest, s.cooldownUntil);
        continue;
      }
      const at = Date.parse(s.account.autoEnableAt ?? '');
      if (at > now) soonest = Math.min(soonest, at);
    }
    if (Number.isFinite(soonest)) {
      return new ProviderError(
        { kind: 'rate_limited', status: 429, retryAfterSeconds: Math.ceil((soonest - now) / 1000) },
        '',
        'no pool account is usable right now',
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
      hold: newHold(),
      modelHolds: new Map(),
      estimateCheckAt: 0,
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
      hold: newHold(),
      modelHolds: new Map(),
      estimateCheckAt: 0,
    };
    this.#slots.set(KIRO_CLI_ACCOUNT_ID, slot);
  }
}

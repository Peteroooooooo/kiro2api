/**
 * The contract between the upstream executor and whatever supplies bearer
 * tokens: a single kiro-cli credential (`SingleTokenManager`) or a pool of
 * accounts (`AccountPool`).
 *
 * The single-credential implementation ignores every option and every
 * outcome report, so the executor can always pass them.
 */

import type { Config } from '../model/config.js';
import type { KiroCredentials } from './model/credentials.js';
import type { UsageLimitsResponse } from './model/usage-limits.js';

/** 一次 API 调用的上下文，绑定一对 credential + access token */
export interface CallContext {
  /** 凭据信息（用于构造请求头） */
  credentials: KiroCredentials;
  /** access token */
  token: string;
  /** Pool account that issued the token; undefined for the single-credential source. */
  accountId?: string;
}

export interface AcquireOptions {
  /**
   * Stable per-conversation key (the Kiro `conversationId`). A pool keeps one
   * conversation on one account so the upstream prefix cache, which is per
   * account, keeps hitting.
   */
  affinityKey?: string;
  /**
   * The conversation's root (`rootConversationId`). A subagent conversation seen
   * for the first time starts on its root's account when that account has room.
   */
  rootKey?: string;
  /** Accounts that already failed this request and must not be picked again. */
  exclude?: ReadonlySet<string>;
  /** Upstream model id; a pool only picks accounts whose plan offers it. */
  model?: string;
  /** Retry of this request on the account it already used: take it again if it is still usable. */
  stayOn?: string;
  /** Epoch ms after which the pool must stop waiting and answer 429. */
  deadline?: number;
}

/**
 * Account-scoped results the executor reports back.
 *
 * `rate_limited` and `capacity` are throttles, not account faults: the pool
 * puts the account (or, for `capacity`, that model on the account) on a short
 * back-off hold and the request waits for it on the same account.
 * `quota_exhausted` / `unauthorized` take the account out of rotation.
 */
export type AccountOutcome =
  | { kind: 'success'; model?: string }
  | { kind: 'rate_limited'; retryAfterSeconds?: number; reason?: string }
  | { kind: 'capacity'; model?: string; retryAfterSeconds?: number }
  | { kind: 'quota_exhausted' }
  | { kind: 'unauthorized' };

export interface TokenSource {
  config(): Config;
  acquireContext(opts?: AcquireOptions): Promise<CallContext>;
  /** Force-refresh the bearer of `accountId` (or the only credential). */
  forceRefreshToken(accountId?: string): Promise<void>;
  getUsageLimits(): Promise<UsageLimitsResponse>;
  /** Number of accounts a request for `model` may fail over across. 1 = no failover. */
  failoverCapacity(model?: string): number;
  reportOutcome(accountId: string | undefined, outcome: AccountOutcome): void;
  /**
   * How long one request may wait inside the gateway for throttles (ms).
   * Absent or 0 = no gateway-side waiting: a throttle goes straight downstream.
   */
  throttleBudgetMs?(): number;
  /** Ms until the back-off hold on `accountId` (for `model`) ends; 0 = none. */
  holdRemainingMs?(accountId: string, model?: string): number;
}

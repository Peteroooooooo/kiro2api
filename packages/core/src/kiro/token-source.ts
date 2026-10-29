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
   * Stable per-conversation key. A pool keeps one conversation on one account
   * so the upstream prefix cache, which is per account, keeps hitting.
   */
  affinityKey?: string;
  /** Accounts that already failed this request and must not be picked again. */
  exclude?: ReadonlySet<string>;
}

/**
 * Account-scoped results the executor reports back. Model-capacity events are
 * not reported: they are upstream-wide, and cooling an account for them would
 * only shrink the pool.
 */
export type AccountOutcome =
  | { kind: 'success' }
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  | { kind: 'quota_exhausted' }
  | { kind: 'unauthorized' };

export interface TokenSource {
  config(): Config;
  acquireContext(opts?: AcquireOptions): Promise<CallContext>;
  /** Force-refresh the bearer of `accountId` (or the only credential). */
  forceRefreshToken(accountId?: string): Promise<void>;
  getUsageLimits(): Promise<UsageLimitsResponse>;
  /** Number of accounts a request may fail over across. 1 = no failover. */
  failoverCapacity(): number;
  reportOutcome(accountId: string | undefined, outcome: AccountOutcome): void;
}

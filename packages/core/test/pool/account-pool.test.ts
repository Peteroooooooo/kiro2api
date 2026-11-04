import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KiroCredentials } from '../../src/kiro/model/credentials.js';
import { ProviderError } from '../../src/kiro/provider-error.js';
import {
  extractAffinityKey,
  extractRootKey,
  RetryExecutor,
} from '../../src/kiro/retry-executor.js';
import { SingleTokenManager } from '../../src/kiro/token-manager.js';
import type { Config } from '../../src/model/config.js';
import { AccountPool, extraQuotaOf } from '../../src/pool/account-pool.js';
import { AccountStore, emptyStats, type StoredAccount } from '../../src/pool/account-store.js';
import { type RequestContext, requestContextStorage } from '../../src/shared/request-context.js';
import { makeRequest, makeStubAxios } from '../helpers/retry-executor-stubs.js';

const config: Config = {
  host: '127.0.0.1',
  port: 8080,
  region: 'us-east-1',
  apiKey: 'test',
  countTokensAuthType: 'x-api-key',
  extractThinking: true,
  autoCaptureProfile: false,
  loginLicense: 'pro',
  loginTimeoutMs: 300_000,
} as Config;

function freshCredentials(token: string): KiroCredentials {
  return {
    accessToken: token,
    refreshToken: `refresh-${token}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    clientId: 'cid',
    clientSecret: 'secret',
    region: 'us-east-1',
  };
}

function account(id: string): StoredAccount {
  return {
    id,
    name: id,
    enabled: true,
    createdAt: new Date().toISOString(),
    source: 'import',
    credentials: freshCredentials(`token-${id}`),
    stats: emptyStats(),
  };
}

function conversation(id: string, root?: string): string {
  return JSON.stringify({ conversationState: { conversationId: id, rootConversationId: root } });
}

function modelConversation(id: string, modelId: string): string {
  return JSON.stringify({
    conversationState: { conversationId: id, currentMessage: { userInputMessage: { modelId } } },
  });
}

/**
 * Run `fn` inside a request context like the HTTP layer does, and hand back the
 * pool lease it took so the test can end the "response".
 */
async function inRequest<T>(fn: () => Promise<T>): Promise<{ ctx: T; release: () => void }> {
  const reqCtx: RequestContext = { reqId: 'test', startTime: Date.now() };
  const ctx = await requestContextStorage.run(reqCtx, fn);
  return { ctx, release: () => reqCtx.poolLease?.release() };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro2api-pool-'));
  file = path.join(dir, 'accounts.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makePool(
  ids: string[],
  overrides: Partial<Config> = {},
): { pool: AccountPool; store: AccountStore } {
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: ids.map(account) }));
  const store = new AccountStore(file);
  store.load();
  return { pool: new AccountPool({ ...config, ...overrides }, store), store };
}

describe('AccountPool selection', () => {
  it('spreads new conversations and keeps each conversation on its first account', async () => {
    const { pool } = makePool(['a', 'b', 'c']);
    const first = await pool.acquireContext({ affinityKey: 'conv-1' });
    const second = await pool.acquireContext({ affinityKey: 'conv-2' });
    const third = await pool.acquireContext({ affinityKey: 'conv-3' });
    expect(new Set([first.accountId, second.accountId, third.accountId]).size).toBe(3);

    for (let i = 0; i < 5; i++) {
      expect((await pool.acquireContext({ affinityKey: 'conv-2' })).accountId).toBe(
        second.accountId,
      );
    }
    expect(first.token).toBe(`token-${first.accountId}`);
  });

  it('keeps a throttled conversation on its account and waits there', async () => {
    const { pool } = makePool(['a', 'b'], { poolThrottleWaitMs: 2_000 });
    const before = await pool.acquireContext({ affinityKey: 'conv' });
    pool.reportOutcome(before.accountId, { kind: 'rate_limited', retryAfterSeconds: 1 });

    const started = Date.now();
    const next = await pool.acquireContext({ affinityKey: 'conv' });
    expect(next.accountId).toBe(before.accountId);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    const view = pool.list().find((a) => a.id === before.accountId);
    expect(view?.status).toBe('ok');
    expect(view?.stats.failures).toBe(1);
  });

  it('moves a conversation whose account ran out of quota, then sticks to the new one', async () => {
    const { pool } = makePool(['a', 'b']);
    const before = await pool.acquireContext({ affinityKey: 'conv' });
    pool.reportOutcome(before.accountId, { kind: 'quota_exhausted' });

    const moved = await pool.acquireContext({ affinityKey: 'conv' });
    expect(moved.accountId).not.toBe(before.accountId);
    expect((await pool.acquireContext({ affinityKey: 'conv' })).accountId).toBe(moved.accountId);
    expect(pool.list().find((a) => a.id === before.accountId)?.status).toBe('cooling');
  });

  it('a new conversation avoids an account on hold', async () => {
    const { pool } = makePool(['a', 'b']);
    pool.reportOutcome('a', { kind: 'rate_limited', retryAfterSeconds: 30 });
    for (let i = 0; i < 3; i++) {
      expect((await pool.acquireContext({ affinityKey: `n${i}` })).accountId).toBe('b');
    }
  });

  it('answers 429 with the earliest recovery time when no account is in rotation', async () => {
    const { pool } = makePool(['a', 'b']);
    pool.reportOutcome('a', { kind: 'unauthorized' });
    pool.reportOutcome('b', { kind: 'quota_exhausted' });

    const err = await pool.acquireContext().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toMatchObject({ kind: 'rate_limited', status: 429 });
    expect(err.kind.retryAfterSeconds).toBeGreaterThan(500);
    expect(err.kind.retryAfterSeconds).toBeLessThanOrEqual(600);
  });

  it('skips disabled accounts and re-enabling clears the cooldown', async () => {
    const { pool } = makePool(['a', 'b']);
    pool.update('a', { enabled: false });
    for (let i = 0; i < 3; i++) expect((await pool.acquireContext()).accountId).toBe('b');
    expect(pool.failoverCapacity()).toBe(1);

    pool.reportOutcome('b', { kind: 'unauthorized' });
    pool.update('b', { enabled: true });
    expect((await pool.acquireContext()).accountId).toBe('b');
  });
});

describe('AccountPool bookkeeping', () => {
  it('records requests and credits per account and persists them', async () => {
    const { pool, store } = makePool(['a']);
    pool.reportOutcome('a', { kind: 'success' });
    pool.recordCredits('a', 1.25);
    pool.recordCredits('a', 0.5);
    store.saveNow();

    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(saved.accounts[0].stats).toMatchObject({ requests: 1, credits: 1.75 });
  });

  it('never exposes secrets in the admin view', () => {
    const { pool } = makePool(['a']);
    const text = JSON.stringify(pool.list());
    expect(text).not.toContain('token-a');
    expect(text).not.toContain('refresh-token-a');
    expect(text).not.toContain('secret');
  });

  it('removes an account from the pool and the file', () => {
    const { pool } = makePool(['a', 'b']);
    expect(pool.remove('a')).toBe(true);
    expect(pool.list().map((a) => a.id)).toEqual(['b']);
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(saved.accounts.map((a: StoredAccount) => a.id)).toEqual(['b']);
  });
});

describe('AccountPool quota refresh', () => {
  it('cools an account whose quota is used up until the reset date, and releases it later', async () => {
    const { pool } = makePool(['a', 'b']);
    const resetAt = Math.floor(Date.now() / 1000) + 86_400;
    const spy = vi.spyOn(SingleTokenManager.prototype, 'getUsageLimits').mockResolvedValue({
      nextDateReset: resetAt,
      usageBreakdownList: [
        {
          currentUsage: 1000,
          currentUsageWithPrecision: 1000,
          usageLimit: 1000,
          usageLimitWithPrecision: 1000,
          bonuses: [],
        },
      ],
    });
    try {
      await pool.refreshQuota('a');
      const view = pool.list().find((x) => x.id === 'a');
      expect(view?.status).toBe('cooling');
      expect(Date.parse(view?.cooldownUntil ?? '')).toBe(resetAt * 1000);
      for (let i = 0; i < 3; i++) expect((await pool.acquireContext()).accountId).toBe('b');

      spy.mockResolvedValue({
        usageBreakdownList: [
          {
            currentUsage: 10,
            currentUsageWithPrecision: 10,
            usageLimit: 1000,
            usageLimitWithPrecision: 1000,
            bonuses: [],
          },
        ],
      });
      await pool.refreshQuota('a');
      expect(pool.list().find((x) => x.id === 'a')?.status).toBe('ok');
    } finally {
      spy.mockRestore();
    }
  });

  const trialBonus = (current: number, expiresAt: number, status = 'ACTIVE') => ({
    bonusType: 'FIRST_UPGRADE_TRIAL',
    currentUsage: current,
    usageLimit: 500,
    status,
    expiresAt,
  });
  const monthlyUsedUp = (bonuses: ReturnType<typeof trialBonus>[]) => ({
    usageBreakdownList: [
      {
        currentUsage: 50,
        currentUsageWithPrecision: 50,
        usageLimit: 50,
        usageLimitWithPrecision: 50,
        bonuses,
      },
    ],
  });

  it('keeps an account in rotation while its extra credits last after the monthly plan is used up', async () => {
    const { pool } = makePool(['a', 'b']);
    const later = Date.now() / 1000 + 86_400 * 365;
    const spy = vi
      .spyOn(SingleTokenManager.prototype, 'getUsageLimits')
      .mockResolvedValue(monthlyUsedUp([trialBonus(120, later)]));
    try {
      const quota = await pool.refreshQuota('a');
      expect(quota?.limit).toBe(50);
      expect(quota?.extra).toMatchObject({ limit: 500, current: 120 });
      expect(Date.parse(quota?.extra?.expiresAt ?? '')).toBe(Math.trunc(later * 1000));
      expect(pool.list().find((x) => x.id === 'a')?.status).toBe('ok');

      spy.mockResolvedValue(monthlyUsedUp([trialBonus(500, later)]));
      await pool.refreshQuota('a');
      expect(pool.list().find((x) => x.id === 'a')?.status).toBe('cooling');
    } finally {
      spy.mockRestore();
    }
  });

  it('ignores extra credits that are expired or not active', () => {
    const now = Date.now();
    const b = monthlyUsedUp([
      trialBonus(0, now / 1000 - 60),
      trialBonus(0, now / 1000 + 60, 'EXPIRED'),
    ]).usageBreakdownList[0];
    expect(extraQuotaOf(b, now)).toBeUndefined();
  });

  it('books locally counted credits past the monthly limit on the extra credits', async () => {
    const { pool } = makePool(['a']);
    const spy = vi.spyOn(SingleTokenManager.prototype, 'getUsageLimits').mockResolvedValue({
      usageBreakdownList: [
        {
          currentUsage: 49,
          currentUsageWithPrecision: 49,
          usageLimit: 50,
          usageLimitWithPrecision: 50,
          bonuses: [trialBonus(0, Date.now() / 1000 + 86_400)],
        },
      ],
    });
    try {
      await pool.refreshQuota('a');
      pool.recordCredits('a', 3);
      const q = pool.list()[0]?.quota;
      expect(q?.current).toBe(50);
      expect(q?.extra?.current).toBe(2);
      expect(pool.aggregateQuota()).toMatchObject({
        limit: 50,
        current: 50,
        extra: { limit: 500, current: 2 },
      });
    } finally {
      spy.mockRestore();
    }
  });
});

const CAPACITY_BODY =
  '{"__type":"com.amazon.kiro.runtimeservice#ThrottlingException","message":"I am experiencing high traffic, please try again shortly.","reason":"INSUFFICIENT_MODEL_CAPACITY"}';
const RATE_BODY =
  '{"__type":"com.amazon.kiro.runtimeservice#ThrottlingException","message":"Too many requests","reason":"USER_REQUEST_RATE_EXCEEDED"}';

function tokensOf(post: ReturnType<typeof makeStubAxios>['post']): string[] {
  return post.mock.calls.map(
    (c) => (c[2] as { headers: Record<string, string> }).headers.Authorization,
  );
}

function authRequest(body: string) {
  return {
    ...makeRequest(body),
    buildHeaders: (_c: KiroCredentials, token: string) => ({ Authorization: `Bearer ${token}` }),
  };
}

describe('RetryExecutor: throttles wait on the same account', () => {
  it('capacity 429 three times then success: 200, one account only', async () => {
    // 回放 11-03:换号后第二个号 1 秒内同样 INSUFFICIENT_MODEL_CAPACITY,换号无用。
    const { pool } = makePool(['a', 'b', 'c'], { poolBackoffMaxS: 1 });
    const { client, post } = makeStubAxios([
      { status: 429, data: CAPACITY_BODY, headers: { 'retry-after': '0' } },
      { status: 429, data: CAPACITY_BODY, headers: { 'retry-after': '0' } },
      { status: 429, data: CAPACITY_BODY, headers: { 'retry-after': '0' } },
      { status: 200, data: 'ok', headers: {} },
    ]);
    const res = await new RetryExecutor(pool, client).execute(
      authRequest(modelConversation('conv', 'opus')),
    );
    expect(res.status).toBe(200);
    expect(post).toHaveBeenCalledTimes(4);
    expect(new Set(tokensOf(post)).size).toBe(1);
    // Nothing is benched: every account is still in rotation.
    expect(pool.list().every((a) => a.status === 'ok')).toBe(true);
  });

  it('per-user rate 429 also retries on the same account after its back-off', async () => {
    const { pool } = makePool(['a', 'b']);
    const { client, post } = makeStubAxios([
      { status: 429, data: RATE_BODY, headers: { 'retry-after': '1' } },
      { status: 200, data: 'ok', headers: {} },
    ]);
    const started = Date.now();
    const res = await new RetryExecutor(pool, client).execute(authRequest(conversation('x')));
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    const [first, second] = tokensOf(post);
    expect(first).toBe(second);
  });

  it('gives up at the wait budget with a 429 carrying Retry-After', async () => {
    const { pool } = makePool(['a', 'b'], { poolThrottleWaitMs: 1_500 });
    const { client, post } = makeStubAxios({ status: 429, data: CAPACITY_BODY, headers: {} });
    const started = Date.now();
    const err = await new RetryExecutor(pool, client)
      .execute(authRequest(modelConversation('conv', 'opus')))
      .catch((e) => e);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind.kind).toBe('rate_limited');
    expect(err.kind.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(new Set(tokensOf(post)).size).toBe(1);
  });

  it('a throttled account does not block other conversations', async () => {
    const { pool } = makePool(['a', 'b'], { poolThrottleWaitMs: 1_000 });
    const home = await pool.acquireContext({ affinityKey: 'busy', model: 'opus' });
    pool.reportOutcome(home.accountId, { kind: 'capacity', model: 'opus', retryAfterSeconds: 30 });
    const started = Date.now();
    const other = await pool.acquireContext({ affinityKey: 'fresh', model: 'opus' });
    expect(Date.now() - started).toBeLessThan(100);
    expect(other.accountId).not.toBe(home.accountId);
    // The held account still serves another model right away.
    expect((await pool.acquireContext({ stayOn: home.accountId, model: 'sonnet' })).accountId).toBe(
      home.accountId,
    );
  });

  it('poolThrottleWaitMs=0 forwards the throttle at once', async () => {
    const { pool } = makePool(['a', 'b'], { poolThrottleWaitMs: 0 });
    const { client, post } = makeStubAxios({ status: 429, data: CAPACITY_BODY, headers: {} });
    const err = await new RetryExecutor(pool, client)
      .execute(makeRequest(modelConversation('conv', 'opus')))
      .catch((e) => e);
    expect(err.kind.kind).toBe('rate_limited');
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('RetryExecutor: account faults switch, once', () => {
  it('quota exhausted moves the request to another account and the conversation follows', async () => {
    const { pool } = makePool(['a', 'b', 'c']);
    const { client, post } = makeStubAxios([
      { status: 402, data: '{"reason":"MONTHLY_REQUEST_COUNT"}', headers: {} },
      { status: 200, data: 'ok', headers: {} },
    ]);
    const res = await new RetryExecutor(pool, client).execute(authRequest(conversation('conv')));
    expect(res.status).toBe(200);
    expect(post).toHaveBeenCalledTimes(2);
    const [first, second] = tokensOf(post);
    expect(first).not.toBe(second);

    const served = pool.list().find((a) => a.stats.requests === 1);
    expect(pool.list().filter((a) => a.status === 'cooling')).toHaveLength(1);
    expect((await pool.acquireContext({ affinityKey: 'conv' })).accountId).toBe(served?.id);
  });

  it('gives up after every account had a fault and surfaces the last error', async () => {
    const { pool } = makePool(['a', 'b']);
    const { client, post } = makeStubAxios({ status: 402, data: '{}', headers: {} });
    const err = await new RetryExecutor(pool, client)
      .execute(makeRequest(conversation('x')))
      .catch((e) => e);
    expect(err.kind.kind).toBe('quota_exhausted');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('keeps in-flight counts exact across a failover', async () => {
    const { pool } = makePool(['a', 'b']);
    const { client } = makeStubAxios([
      { status: 402, data: '{}', headers: {} },
      { status: 200, data: 'ok', headers: {} },
    ]);
    const executor = new RetryExecutor(pool, client);
    const { release } = await inRequest(() => executor.execute(makeRequest(conversation('x'))));
    expect(pool.list().reduce((n, a) => n + a.inflight, 0)).toBe(1);
    release();
    expect(pool.list().reduce((n, a) => n + a.inflight, 0)).toBe(0);
  });
});

describe('AccountPool back-off holds', () => {
  const holdMs = (pool: AccountPool, model?: string) => {
    const t = pool.list()[0]?.throttles?.find((x) => x.model === model);
    return t ? Date.parse(t.until) - Date.now() : 0;
  };

  it('starts around 2 s, doubles per throttle after the hold ran out, and a success resets it', () => {
    const { pool } = makePool(['a']);
    pool.reportOutcome('a', { kind: 'rate_limited' });
    expect(holdMs(pool)).toBeGreaterThan(1_400);
    expect(holdMs(pool)).toBeLessThanOrEqual(2_500);

    // A throttle while the hold is running neither escalates nor extends it.
    const before = holdMs(pool);
    pool.reportOutcome('a', { kind: 'rate_limited' });
    expect(holdMs(pool)).toBeLessThanOrEqual(before);

    pool.update('a', { enabled: true }); // clears holds
    pool.reportOutcome('a', { kind: 'rate_limited' });
    pool.update('a', { enabled: true });
    expect(pool.list()[0]?.throttles).toBeUndefined();
  });

  it('caps the step at poolBackoffMaxS but an upstream Retry-After wins', () => {
    const { pool } = makePool(['a'], { poolBackoffMaxS: 3 });
    for (let i = 0; i < 6; i++) {
      pool.update('a', { enabled: true });
      pool.reportOutcome('a', { kind: 'rate_limited' });
    }
    expect(holdMs(pool)).toBeLessThanOrEqual(3_000 * 1.25 + 50);
    pool.reportOutcome('a', { kind: 'rate_limited', retryAfterSeconds: 300 });
    expect(holdMs(pool)).toBeGreaterThan(250_000);
  });

  it('a capacity hold is per model and labelled', () => {
    const { pool } = makePool(['a']);
    pool.reportOutcome('a', { kind: 'capacity', model: 'opus' });
    expect(holdMs(pool, 'opus')).toBeGreaterThan(0);
    expect(holdMs(pool)).toBe(0);
    expect(pool.holdRemainingMs('a', 'opus')).toBeGreaterThan(0);
    expect(pool.holdRemainingMs('a', 'sonnet')).toBe(0);
    pool.reportOutcome('a', { kind: 'success', model: 'opus' });
    expect(pool.holdRemainingMs('a', 'opus')).toBe(0);
  });

  it('labels the account hold with the upstream reason', () => {
    const { pool } = makePool(['a']);
    pool.reportOutcome('a', { kind: 'rate_limited', reason: 'USER_REQUEST_RATE_EXCEEDED' });
    expect(pool.list()[0]?.throttles?.[0]?.reason).toContain('USER_REQUEST_RATE_EXCEEDED');
    expect(pool.list()[0]?.status).toBe('ok');
  });
});

describe('AccountPool subagent placement', () => {
  it('a subagent starts on its root account and then keeps its own account', async () => {
    const { pool } = makePool(['a', 'b'], { poolMaxInflight: 2 });
    const root = await inRequest(() =>
      pool.acquireContext({ affinityKey: 'root', rootKey: 'root' }),
    );
    const sub = await inRequest(() =>
      pool.acquireContext({ affinityKey: 'sub1', rootKey: 'root' }),
    );
    expect(sub.ctx.accountId).toBe(root.ctx.accountId);
    // Root account now full (2 in flight): the next new subagent goes elsewhere…
    const sub2 = await inRequest(() =>
      pool.acquireContext({ affinityKey: 'sub2', rootKey: 'root' }),
    );
    expect(sub2.ctx.accountId).not.toBe(root.ctx.accountId);
    // …and stays there on every later turn, even once the root account has room.
    root.release();
    sub.release();
    for (let i = 0; i < 3; i++) {
      expect((await pool.acquireContext({ affinityKey: 'sub2', rootKey: 'root' })).accountId).toBe(
        sub2.ctx.accountId,
      );
    }
  });

  it('extractAffinityKey is the own conversation id, extractRootKey the root', () => {
    expect(extractAffinityKey(conversation('child', 'root-1'))).toBe('child');
    expect(extractRootKey(conversation('child', 'root-1'))).toBe('root-1');
    expect(extractAffinityKey(conversation('main', 'main'))).toBe('main');
  });
});

describe('AccountPool in-flight spill (one shared conversation id)', () => {
  it('spills off a full home only to a quieter account, without re-pinning', async () => {
    const { pool } = makePool(['a', 'b'], { poolMaxInflight: 2 });
    const home = await inRequest(() => pool.acquireContext({ affinityKey: 'root' }));
    await inRequest(() => pool.acquireContext({ affinityKey: 'root' }));
    const spilled = await inRequest(() => pool.acquireContext({ affinityKey: 'root' }));
    expect(spilled.ctx.accountId).not.toBe(home.ctx.accountId);
    home.release();
    const back = await inRequest(() => pool.acquireContext({ affinityKey: 'root' }));
    expect(back.ctx.accountId).toBe(home.ctx.accountId);
  });

  it('stays home when every account is equally busy', async () => {
    const { pool } = makePool(['a', 'b'], { poolMaxInflight: 1 });
    const home = await inRequest(() => pool.acquireContext({ affinityKey: 'root' }));
    await inRequest(() => pool.acquireContext({ affinityKey: 'other' }));
    const next = await inRequest(() => pool.acquireContext({ affinityKey: 'root' }));
    expect(next.ctx.accountId).toBe(home.ctx.accountId);
  });

  it('sends a new conversation to the least-loaded account', async () => {
    const { pool } = makePool(['a', 'b'], { poolMaxInflight: 0 });
    const first = await inRequest(() => pool.acquireContext({ affinityKey: 'c1' }));
    await inRequest(() => pool.acquireContext({ affinityKey: 'c1' }));
    const fresh = await inRequest(() => pool.acquireContext({ affinityKey: 'c2' }));
    expect(fresh.ctx.accountId).not.toBe(first.ctx.accountId);
    expect(pool.list().find((a) => a.id === first.ctx.accountId)?.inflight).toBe(2);
  });
});

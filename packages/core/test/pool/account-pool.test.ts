import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KiroCredentials } from '../../src/kiro/model/credentials.js';
import { ProviderError } from '../../src/kiro/provider-error.js';
import { RetryExecutor } from '../../src/kiro/retry-executor.js';
import { SingleTokenManager } from '../../src/kiro/token-manager.js';
import type { Config } from '../../src/model/config.js';
import { AccountPool } from '../../src/pool/account-pool.js';
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

  it('moves a sticky conversation when its account cools down, then sticks to the new one', async () => {
    const { pool } = makePool(['a', 'b']);
    const before = await pool.acquireContext({ affinityKey: 'conv' });
    pool.reportOutcome(before.accountId, { kind: 'rate_limited', retryAfterSeconds: 30 });

    const moved = await pool.acquireContext({ affinityKey: 'conv' });
    expect(moved.accountId).not.toBe(before.accountId);
    expect((await pool.acquireContext({ affinityKey: 'conv' })).accountId).toBe(moved.accountId);

    const view = pool.list().find((a) => a.id === before.accountId);
    expect(view?.status).toBe('cooling');
    expect(view?.stats.failures).toBe(1);
  });

  it('answers 429 with the earliest recovery time when every account is cooling', async () => {
    const { pool } = makePool(['a', 'b']);
    pool.reportOutcome('a', { kind: 'rate_limited', retryAfterSeconds: 120 });
    pool.reportOutcome('b', { kind: 'quota_exhausted' });

    const err = await pool.acquireContext().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toMatchObject({ kind: 'rate_limited', status: 429 });
    expect(err.kind.retryAfterSeconds).toBeGreaterThan(100);
    expect(err.kind.retryAfterSeconds).toBeLessThanOrEqual(120);
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
});

describe('RetryExecutor failover across pool accounts', () => {
  it('retries a 429 on another account and keeps the conversation there', async () => {
    const { pool } = makePool(['a', 'b']);
    const { client, post } = makeStubAxios([
      { status: 429, data: 'Too many requests', headers: {} },
      { status: 200, data: 'ok', headers: {} },
    ]);
    const executor = new RetryExecutor(pool, client);

    const request = {
      ...makeRequest(conversation('child', 'root-1')),
      buildHeaders: (_c: KiroCredentials, token: string) => ({ Authorization: `Bearer ${token}` }),
    };
    const response = await executor.execute(request);
    expect(response.status).toBe(200);
    expect(post).toHaveBeenCalledTimes(2);

    const tokens = post.mock.calls.map(
      (c) => (c[2] as { headers: Record<string, string> }).headers.Authorization,
    );
    expect(tokens[0]).not.toBe(tokens[1]);

    const limited = pool.list().find((a) => a.status === 'cooling');
    const served = pool.list().find((a) => a.status === 'ok');
    expect(limited?.stats.failures).toBe(1);
    expect(served?.stats.requests).toBe(1);

    // The root conversation id is the affinity key, so a sibling request follows.
    expect((await pool.acquireContext({ affinityKey: 'root-1' })).accountId).toBe(served?.id);
  });

  it('gives up after every account failed and surfaces the last error', async () => {
    const { pool } = makePool(['a', 'b']);
    const { client, post } = makeStubAxios({ status: 429, data: 'Too many requests', headers: {} });
    const executor = new RetryExecutor(pool, client);

    const err = await executor.execute(makeRequest(conversation('x'))).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind.kind).toBe('rate_limited');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('moves a capacity 429 to one other account, cooling only that model', async () => {
    // 回放 11-02:INSUFFICIENT_MODEL_CAPACITY 全落在同一账号,另外两个号一次没试。
    const { pool } = makePool(['a', 'b', 'c']);
    const capacityBody =
      '{"__type":"com.amazon.kiro.runtimeservice#ThrottlingException","message":"I am experiencing high traffic","reason":"INSUFFICIENT_MODEL_CAPACITY"}';
    const { client, post } = makeStubAxios([
      { status: 429, data: capacityBody, headers: {} },
      { status: 200, data: 'ok', headers: {} },
    ]);
    const executor = new RetryExecutor(pool, client);

    const res = await executor.execute(makeRequest(modelConversation('conv', 'opus')));
    expect(res.status).toBe(200);
    expect(post).toHaveBeenCalledTimes(2);

    const views = pool.list();
    const cooled = views.find((a) => a.modelCooldowns?.opus);
    expect(cooled).toBeDefined();
    // Account-level status untouched: it still serves other models.
    expect(cooled?.status).toBe('ok');
    const other = await pool.acquireContext({ model: 'sonnet' });
    expect(other.accountId).toBeDefined();
  });

  it('stops after a second capacity answer instead of walking the whole pool', async () => {
    const { pool } = makePool(['a', 'b', 'c']);
    const capacityBody = '{"reason":"INSUFFICIENT_MODEL_CAPACITY"}';
    const { client, post } = makeStubAxios({ status: 429, data: capacityBody, headers: {} });
    const executor = new RetryExecutor(pool, client);

    const err = await executor
      .execute(makeRequest(modelConversation('conv', 'opus')))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind.kind).toBe('rate_limited');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('honours poolCapacityFailover=false', async () => {
    const { pool } = makePool(['a', 'b'], { poolCapacityFailover: false });
    const { client, post } = makeStubAxios({
      status: 429,
      data: '{"reason":"INSUFFICIENT_MODEL_CAPACITY"}',
      headers: {},
    });
    const executor = new RetryExecutor(pool, client);
    await executor.execute(makeRequest(modelConversation('conv', 'opus'))).catch(() => undefined);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('AccountPool adaptive cooldown', () => {
  it('starts at 5 s, doubles per consecutive 429, and a success resets it', () => {
    const { pool } = makePool(['a']);
    const until = () => Date.parse(pool.list()[0]?.cooldownUntil ?? '') - Date.now();

    pool.reportOutcome('a', { kind: 'rate_limited' });
    expect(until()).toBeGreaterThan(3_000);
    expect(until()).toBeLessThanOrEqual(5_000);

    pool.update('a', { enabled: true }); // clears cooldown and strikes; start over
    pool.reportOutcome('a', { kind: 'rate_limited' }); // 5 s
    pool.reportOutcome('a', { kind: 'rate_limited' }); // 10 s
    expect(until()).toBeGreaterThan(8_000);
    expect(until()).toBeLessThanOrEqual(10_000);

    pool.reportOutcome('a', { kind: 'success' });
    pool.update('a', { enabled: true });
    pool.reportOutcome('a', { kind: 'rate_limited' });
    expect(until()).toBeLessThanOrEqual(5_000);
  });

  it('caps the adaptive cooldown at poolCooldownMaxS but obeys an upstream Retry-After', () => {
    const { pool } = makePool(['a'], { poolCooldownMaxS: 12 });
    const until = () => Date.parse(pool.list()[0]?.cooldownUntil ?? '') - Date.now();
    for (let i = 0; i < 6; i++) pool.reportOutcome('a', { kind: 'rate_limited' });
    expect(until()).toBeLessThanOrEqual(12_000);

    pool.reportOutcome('a', { kind: 'rate_limited', retryAfterSeconds: 300 });
    expect(until()).toBeGreaterThan(250_000);
  });

  it('labels the cooldown with the upstream reason', () => {
    const { pool } = makePool(['a']);
    pool.reportOutcome('a', { kind: 'rate_limited', reason: 'USER_REQUEST_RATE_EXCEEDED' });
    expect(pool.list()[0]?.cooldownReason).toContain('USER_REQUEST_RATE_EXCEEDED');
  });
});

describe('AccountPool in-flight spill', () => {
  it('spills a sticky conversation off its account once it is full, without re-pinning', async () => {
    const { pool } = makePool(['a', 'b'], { poolMaxInflight: 2 });
    const home = await inRequest(() => pool.acquireContext({ affinityKey: 'root' }));
    await inRequest(() => pool.acquireContext({ affinityKey: 'root' }));
    // home now has 2 in flight → the third goes elsewhere.
    const spilled = await inRequest(() => pool.acquireContext({ affinityKey: 'root' }));
    expect(spilled.ctx.accountId).not.toBe(home.ctx.accountId);

    // Releasing frees the home again and the conversation never moved.
    home.release();
    const back = await inRequest(() => pool.acquireContext({ affinityKey: 'root' }));
    expect(back.ctx.accountId).toBe(home.ctx.accountId);
  });

  it('stays on the sticky account when every account is equally busy', async () => {
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

  it('moves the lease to the failover account so in-flight counts stay exact', async () => {
    const { pool } = makePool(['a', 'b']);
    const { client } = makeStubAxios([
      { status: 429, data: 'Too many requests', headers: {} },
      { status: 200, data: 'ok', headers: {} },
    ]);
    const executor = new RetryExecutor(pool, client);
    const { release } = await inRequest(() => executor.execute(makeRequest(conversation('x'))));
    expect(pool.list().reduce((n, a) => n + a.inflight, 0)).toBe(1);
    release();
    expect(pool.list().reduce((n, a) => n + a.inflight, 0)).toBe(0);
  });
});

describe('AccountPool short wait when everything is cooling', () => {
  it('waits out a short cooldown instead of answering 429', async () => {
    // 回放 11-01 11:39:单号 429 后的一分钟里几十个请求被网关当场回 429。
    const { pool } = makePool(['a'], { poolWaitMs: 2_000 });
    pool.reportOutcome('a', { kind: 'rate_limited', retryAfterSeconds: 1 });
    const started = Date.now();
    const ctx = await pool.acquireContext();
    expect(ctx.accountId).toBe('a');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('answers 429 at once with the real recovery time when it is beyond the wait budget', async () => {
    const { pool } = makePool(['a'], { poolWaitMs: 500 });
    pool.reportOutcome('a', { kind: 'rate_limited', retryAfterSeconds: 30 });
    const started = Date.now();
    const err = await pool.acquireContext().catch((e) => e);
    expect(Date.now() - started).toBeLessThan(200);
    expect(err.kind).toMatchObject({ kind: 'rate_limited', status: 429 });
    expect(err.kind.retryAfterSeconds).toBeGreaterThan(25);
  });

  it('counts a model-capacity cooldown in the recovery time', async () => {
    const { pool } = makePool(['a'], { poolWaitMs: 0 });
    pool.reportOutcome('a', { kind: 'capacity', model: 'opus' });
    const err = await pool.acquireContext({ model: 'opus' }).catch((e) => e);
    expect(err.kind).toMatchObject({ kind: 'rate_limited', status: 429 });
    expect(err.kind.retryAfterSeconds).toBeGreaterThan(10);
    expect((await pool.acquireContext({ model: 'sonnet' })).accountId).toBe('a');
  });
});

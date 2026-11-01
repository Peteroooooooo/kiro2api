import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyProviderError } from '../../src/claude/error-mapper.js';
import { _resetKiroClientProfileCacheForTesting } from '../../src/kiro/client-profile.js';
import type { KiroCredentials } from '../../src/kiro/model/credentials.js';
import { ProviderError } from '../../src/kiro/provider-error.js';
import { extractModelId, RetryExecutor } from '../../src/kiro/retry-executor.js';
import { listAvailableModels, SingleTokenManager } from '../../src/kiro/token-manager.js';
import type { Config } from '../../src/model/config.js';
import { AccountPool } from '../../src/pool/account-pool.js';
import { AccountStore, emptyStats, type StoredAccount } from '../../src/pool/account-store.js';
import { makeRequest, makeStubAxios } from '../helpers/retry-executor-stubs.js';

const config = { region: 'us-east-1', apiKey: 'test' } as Config;

const FREE = ['auto', 'claude-haiku-4.5', 'claude-sonnet-4.5'];
const PRO = [...FREE, 'claude-opus-5.5', 'claude-sonnet-5.5'];

function credentials(id: string): KiroCredentials {
  return {
    accessToken: `token-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    region: 'us-east-1',
    profileArn: `arn-${id}`,
  };
}

function account(id: string, models?: string[]): StoredAccount {
  return {
    id,
    name: id,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'import',
    credentials: credentials(id),
    models,
    stats: emptyStats(),
  };
}

function body(model: string, conversationId = 'conv'): string {
  return JSON.stringify({
    conversationState: {
      conversationId,
      currentMessage: { userInputMessage: { content: 'hi', modelId: model } },
    },
  });
}

let dir: string;
let file: string;

function makePool(accounts: StoredAccount[]): AccountPool {
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts }));
  const store = new AccountStore(file);
  store.load();
  return new AccountPool(config, store);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro2api-models-'));
  file = path.join(dir, 'accounts.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('AccountPool model filtering', () => {
  it('only picks accounts whose plan offers the model', async () => {
    const pool = makePool([account('free', FREE), account('pro', PRO)]);
    for (let i = 0; i < 4; i++) {
      const ctx = await pool.acquireContext({ affinityKey: `c${i}`, model: 'claude-opus-5.5' });
      expect(ctx.accountId).toBe('pro');
    }
  });

  it('a model both plans offer still spreads across both accounts', async () => {
    const pool = makePool([account('free', FREE), account('pro', PRO)]);
    const used = new Set<string | undefined>();
    for (let i = 0; i < 2; i++) {
      used.add(
        (await pool.acquireContext({ affinityKey: `h${i}`, model: 'claude-haiku-4.5' })).accountId,
      );
    }
    expect(used).toEqual(new Set(['free', 'pro']));
  });

  it('moves a sticky conversation off an account that lacks the model', async () => {
    const pool = makePool([account('free', FREE), account('pro', PRO)]);
    const first = await pool.acquireContext({ affinityKey: 'conv', model: 'claude-haiku-4.5' });
    expect(first.accountId).toBe('free');
    const next = await pool.acquireContext({ affinityKey: 'conv', model: 'claude-opus-5.5' });
    expect(next.accountId).toBe('pro');
  });

  it('does not filter an account whose model list is not known yet', async () => {
    const pool = makePool([account('unknown')]);
    expect((await pool.acquireContext({ model: 'claude-opus-5.5' })).accountId).toBe('unknown');
  });

  it('fails over only across accounts that offer the model', () => {
    const pool = makePool([account('free', FREE), account('pro1', PRO), account('pro2', PRO)]);
    expect(pool.failoverCapacity('claude-opus-5.5')).toBe(2);
    expect(pool.failoverCapacity('claude-haiku-4.5')).toBe(3);
    expect(pool.failoverCapacity()).toBe(3);
  });

  it('no enabled account offers the model: model_unavailable, nothing sent upstream', async () => {
    const pool = makePool([account('free', FREE), { ...account('pro', PRO), enabled: false }]);
    const { client, post } = makeStubAxios({ status: 200, data: 'ok' });
    const err = await new RetryExecutor(pool, client)
      .execute(makeRequest(body('claude-opus-5.5')))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toEqual({
      kind: 'model_unavailable',
      model: 'claude-opus-5.5',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('accounts that offer the model are all cooling: 429 with their soonest retry', async () => {
    const pool = makePool([account('free', FREE), account('pro', PRO)]);
    pool.reportOutcome('pro', { kind: 'rate_limited', retryAfterSeconds: 30 });
    const err = await pool.acquireContext({ model: 'claude-opus-5.5' }).catch((e) => e);
    expect((err as ProviderError).kind).toMatchObject({ kind: 'rate_limited' });
    expect(((err as ProviderError).kind as { retryAfterSeconds: number }).retryAfterSeconds).toBe(
      30,
    );
  });

  it('refreshModels stores the plan list, which then filters', async () => {
    vi.spyOn(SingleTokenManager.prototype, 'listAvailableModels').mockResolvedValue([
      'claude-sonnet-4.5',
      'auto',
      'auto',
    ]);
    const pool = makePool([account('a')]);
    expect(await pool.refreshModels('a')).toEqual(['auto', 'claude-sonnet-4.5']);
    expect(pool.list()[0]?.models).toEqual(['auto', 'claude-sonnet-4.5']);
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')).accounts[0];
    expect(saved.models).toEqual(['auto', 'claude-sonnet-4.5']);
    expect(typeof saved.modelsCheckedAt).toBe('string');
    const err = await pool.acquireContext({ model: 'claude-opus-5.5' }).catch((e) => e);
    expect((err as ProviderError).kind.kind).toBe('model_unavailable');
  });

  it('a failed query keeps the previous list', async () => {
    vi.spyOn(SingleTokenManager.prototype, 'listAvailableModels').mockRejectedValue(
      new Error('boom'),
    );
    const pool = makePool([account('a', FREE)]);
    await expect(pool.refreshModels('a')).rejects.toThrow('boom');
    expect(pool.list()[0]?.models).toEqual(FREE);
  });
});

describe('extractModelId', () => {
  it('reads the current message model; MCP and malformed bodies have none', () => {
    expect(extractModelId(body('claude-opus-5.5'))).toBe('claude-opus-5.5');
    expect(
      extractModelId(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call' })),
    ).toBeUndefined();
    expect(extractModelId('not json')).toBeUndefined();
  });
});

describe('classifyProviderError: model_unavailable', () => {
  it('maps to a neutral 404 that names neither the backend nor the pool', () => {
    const c = classifyProviderError(
      new ProviderError({ kind: 'model_unavailable', model: 'claude-opus-5.5' }, ''),
    );
    expect(c.status).toBe(404);
    expect(c.errorType).toBe('not_found_error');
    for (const marker of ['Kiro', 'upstream', 'AWS', 'pool', 'account', 'claude-opus-5.5']) {
      expect(c.message).not.toContain(marker);
    }
  });
});

describe('listAvailableModels wire', () => {
  beforeEach(() => _resetKiroClientProfileCacheForTesting());

  it('posts the captured ListAvailableModels shape to the control plane', async () => {
    const post = vi.fn(async () => ({
      status: 200,
      data: { models: [{ modelId: 'auto' }, { modelId: 'claude-sonnet-4.5' }, { other: 1 }] },
      headers: {},
    }));
    vi.spyOn(axios, 'create').mockReturnValue({ post } as unknown as ReturnType<
      typeof axios.create
    >);

    const models = await listAvailableModels(credentials('a'), config, 'tok');
    expect(models).toEqual(['auto', 'claude-sonnet-4.5']);

    const [url, sent, opts] = post.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { headers: Record<string, string | false> },
    ];
    expect(url).toBe('https://management.us-east-1.kiro.dev/');
    expect(sent).toEqual({ origin: 'KIRO_CLI', profileArn: 'arn-a' });
    const h = opts.headers;
    expect(h['x-amz-target']).toBe('KiroControlPlaneBearerService.ListAvailableModels');
    expect(h['user-agent']).toContain('api/kirocontrolplanebearer#1.0.0 m/N,E');
    expect(h['user-agent']).not.toContain('{');
    expect(h.Authorization).toBe('Bearer tok');
    expect(h.host).toBe('management.us-east-1.kiro.dev');
    expect(h['amz-sdk-request']).toBe('attempt=1; max=3');
    expect(h).not.toHaveProperty('x-kiro-attempt');
    expect(h).not.toHaveProperty('x-amzn-kiro-client-attribution');
  });

  it('a non-2xx answer is an error, not an empty list', async () => {
    const post = vi.fn(async () => ({ status: 403, data: { message: 'denied' }, headers: {} }));
    vi.spyOn(axios, 'create').mockReturnValue({ post } as unknown as ReturnType<
      typeof axios.create
    >);
    await expect(listAvailableModels(credentials('a'), config, 'tok')).rejects.toThrow(
      'Failed to list available models',
    );
  });
});

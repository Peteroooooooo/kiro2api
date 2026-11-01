import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageLimitsResponse } from '../../src/kiro/model/usage-limits.js';
import { SingleTokenManager } from '../../src/kiro/token-manager.js';
import type { Config } from '../../src/model/config.js';
import { AccountPool } from '../../src/pool/account-pool.js';
import { AccountStore, emptyStats, type StoredAccount } from '../../src/pool/account-store.js';

const config = { region: 'us-east-1', apiKey: 'test' } as Config;

function stored(id: string, over: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id,
    name: `account-${id}`,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'builder-id',
    credentials: {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      region: 'us-east-1',
    },
    stats: emptyStats(),
    ...over,
  };
}

let dir: string;
let file: string;

function poolOf(accounts: StoredAccount[]): AccountPool {
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts }));
  const store = new AccountStore(file);
  store.load();
  return new AccountPool(config, store);
}

function namesOnDisk(): string[] {
  return (JSON.parse(fs.readFileSync(file, 'utf-8')) as { accounts: StoredAccount[] }).accounts.map(
    (a) => a.name,
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro2api-naming-'));
  file = path.join(dir, 'accounts.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('account display names', () => {
  it('an unnamed account with a known email is shown by its email, and saved that way', () => {
    const pool = poolOf([
      stored('a1', { email: 'a@example.com' }),
      stored('b2'),
      stored('c3', { name: '主号', email: 'c@example.com' }),
    ]);
    expect(pool.list().map((a) => a.name)).toEqual(['a@example.com', 'account-b2', '主号']);
    expect(namesOnDisk()).toEqual(['a@example.com', 'account-b2', '主号']);
  });

  it('the first quota check names an unnamed account after its email', async () => {
    vi.spyOn(SingleTokenManager.prototype, 'getUsageLimits').mockResolvedValue({
      usageBreakdownList: [{ usageLimit: 100, currentUsage: 1 }],
      userInfo: { email: 'b@example.com' },
    } as UsageLimitsResponse);
    const pool = poolOf([stored('b2'), stored('c3', { name: '主号' })]);
    const renames: string[][] = [];
    pool.onRename((id, from, to) => renames.push([id, from, to]));

    await pool.refreshQuota('b2');
    await pool.refreshQuota('c3');

    expect(pool.nameOf('b2')).toBe('b@example.com');
    expect(pool.nameOf('c3')).toBe('主号');
    expect(renames).toEqual([['b2', 'account-b2', 'b@example.com']]);
  });

  it('a rename from the admin page notifies listeners; an unchanged name does not', () => {
    const pool = poolOf([stored('a1', { name: '旧名' })]);
    const renames: string[][] = [];
    pool.onRename((id, from, to) => renames.push([id, from, to]));

    pool.update('a1', { name: '旧名' });
    pool.update('a1', { enabled: false });
    pool.update('a1', { name: ' 新名 ' });

    expect(renames).toEqual([['a1', '旧名', '新名']]);
  });
});

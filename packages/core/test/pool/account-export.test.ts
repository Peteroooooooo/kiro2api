import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/model/config.js';
import { AccountPool } from '../../src/pool/account-pool.js';
import { AccountStore, emptyStats, type StoredAccount } from '../../src/pool/account-store.js';
import type { DeviceLoginManager } from '../../src/pool/device-login.js';
import { parseImport } from '../../src/pool/import-credentials.js';
import { registerAdminRoutes } from '../../src/routes/admin.js';

const config = { region: 'us-east-1', apiKey: 'test' } as Config;
const ADMIN_KEY = 'admin';

function stored(id: string, over: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id,
    name: `name-${id}`,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'import',
    email: `${id}@example.com`,
    credentials: {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      clientId: `cid-${id}`,
      clientSecret: `secret-${id}`,
      region: 'us-east-1',
      profileArn: `arn-${id}`,
    },
    stats: emptyStats(),
    ...over,
  };
}

let dir: string;
let pool: AccountPool;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro2api-export-'));
  const file = path.join(dir, 'accounts.json');
  const accounts = [
    stored('a'),
    stored('b', { enabled: false, source: 'idc', startUrl: 'https://example.awsapps.com/start' }),
  ];
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts }));
  const store = new AccountStore(file);
  store.load();
  pool = new AccountPool(config, store);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('AccountPool.exportAccounts', () => {
  it('exports every account, disabled ones included, without the access token', () => {
    const out = pool.exportAccounts();
    expect(out.map((a) => a.name)).toEqual(['name-a', 'name-b']);
    expect(out[0]).toEqual({
      name: 'name-a',
      email: 'a@example.com',
      subscription: undefined,
      source: 'import',
      startUrl: undefined,
      credentials: {
        refreshToken: 'refresh-a',
        clientId: 'cid-a',
        clientSecret: 'secret-a',
        region: 'us-east-1',
        profileArn: 'arn-a',
      },
    });
  });

  it('exports only the requested ids and skips unknown ones', () => {
    expect(pool.exportAccounts(['b', 'nope']).map((a) => a.name)).toEqual(['name-b']);
  });

  it('round-trips through the import parser with names and Start URL kept', () => {
    const file = JSON.stringify({ exportedAt: 'x', accounts: pool.exportAccounts() }, null, 2);
    const parsed = parseImport(file);
    expect(parsed.errors).toEqual([]);
    expect(parsed.accounts).toEqual([
      {
        name: 'name-a',
        source: 'import',
        startUrl: undefined,
        credentials: {
          refreshToken: 'refresh-a',
          accessToken: undefined,
          expiresAt: undefined,
          clientId: 'cid-a',
          clientSecret: 'secret-a',
          region: 'us-east-1',
          authRegion: undefined,
          apiRegion: undefined,
          profileArn: 'arn-a',
        },
      },
      expect.objectContaining({
        name: 'name-b',
        startUrl: 'https://example.awsapps.com/start',
        credentials: expect.objectContaining({
          refreshToken: 'refresh-b',
          clientSecret: 'secret-b',
        }),
      }),
    ]);
  });

  it('a single exported account keeps its name; the form name overrides it', () => {
    const file = JSON.stringify({ accounts: pool.exportAccounts(['a']) });
    expect(parseImport(file).accounts[0]?.name).toBe('name-a');
    expect(parseImport(file, '新名字').accounts[0]?.name).toBe('新名字');
  });
});

describe('POST /admin/api/accounts/export', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(
      async (instance) =>
        registerAdminRoutes(instance, {
          adminKey: ADMIN_KEY,
          apiKey: 'client',
          pool,
          logins: {} as DeviceLoginManager,
        }),
      { prefix: '/admin' },
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  function post(body: unknown, key = ADMIN_KEY) {
    return app.inject({
      method: 'POST',
      url: '/admin/api/accounts/export',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  it('requires the admin key', async () => {
    expect((await post({}, 'wrong')).statusCode).toBe(401);
  });

  it('exports all accounts by default, never cacheable', async () => {
    const res = await post({});
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(typeof body.exportedAt).toBe('string');
    expect(body.accounts).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('access-a');
  });

  it('exports selected ids; rejects bad input and unknown ids', async () => {
    expect(
      (await post({ ids: ['a'] })).json().accounts.map((a: { name: string }) => a.name),
    ).toEqual(['name-a']);
    expect((await post({ ids: 'a' })).statusCode).toBe(400);
    expect((await post({ ids: [1] })).statusCode).toBe(400);
    expect((await post({ ids: ['nope'] })).statusCode).toBe(404);
  });
});

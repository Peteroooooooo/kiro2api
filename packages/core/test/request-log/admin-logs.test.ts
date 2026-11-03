import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountPool } from '../../src/pool/account-pool.js';
import type { DeviceLoginManager } from '../../src/pool/device-login.js';
import { RequestLogStore } from '../../src/request-log/store.js';
import { registerAdminRoutes } from '../../src/routes/admin.js';

const ADMIN_KEY = 'admin-key';

describe('admin request log API', () => {
  let dir: string;
  let store: RequestLogStore;
  let app: FastifyInstance;

  async function build(withLog: boolean): Promise<void> {
    app = Fastify({ logger: false });
    await app.register(
      async (instance) =>
        registerAdminRoutes(instance, {
          adminKey: ADMIN_KEY,
          apiKey: 'client-key',
          pool: {} as AccountPool,
          logins: {} as DeviceLoginManager,
          requestLog: withLog ? store : undefined,
        }),
      { prefix: '/admin' },
    );
    await app.ready();
  }

  function get(url: string, key = ADMIN_KEY) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlog-admin-'));
    store = new RequestLogStore(path.join(dir, 'requests.db'));
    for (let i = 1; i <= 3; i++) {
      store.insert({
        ts: i * 1000,
        reqId: `r${i}`,
        method: 'POST',
        path: '/claude/v1/messages',
        model: i === 3 ? 'gpt-5.6-sol' : 'claude-opus-5-5',
        stream: true,
        status: i === 2 ? 503 : 200,
        durationMs: 100,
        meteringLost: false,
        emptyAttempts: 0,
        clientDisconnected: false,
        accountId: 'a1',
        accountName: '主号',
        credits: 0.5,
      });
    }
  });
  afterEach(async () => {
    await app.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('requires the admin key', async () => {
    await build(true);
    expect((await get('/admin/api/logs', 'wrong')).statusCode).toBe(401);
  });

  it('lists with filters and paging', async () => {
    await build(true);
    const all = (await get('/admin/api/logs?limit=2')).json();
    expect(all.total).toBe(3);
    expect(all.items.map((i: { reqId: string }) => i.reqId)).toEqual(['r3', 'r2']);
    const errors = (await get('/admin/api/logs?status=error')).json();
    expect(errors.items.map((i: { reqId: string }) => i.reqId)).toEqual(['r2']);
    const model = (await get('/admin/api/logs?model=gpt-5.6-sol&since=500&account=a1')).json();
    expect(model.total).toBe(1);
    // junk paging values fall back to defaults instead of failing
    expect((await get('/admin/api/logs?limit=abc&offset=-5')).json().total).toBe(3);
  });

  it('summary and facets', async () => {
    await build(true);
    const s = (await get('/admin/api/logs/summary?since=2000')).json();
    expect(s).toMatchObject({ requests: 2, failed: 1, credits: 1 });
    expect((await get('/admin/api/logs/facets')).json()).toEqual({
      models: ['claude-opus-5-5', 'gpt-5.6-sol'],
      accounts: [{ id: 'a1', name: '主号' }],
    });
    expect((await get('/admin/api/connection')).json().requestLog).toBe(true);
  });

  it('series and per-account totals', async () => {
    await build(true);
    const s = (await get('/admin/api/logs/series?bucket=5m&since=1000&until=3000')).json();
    expect(s.bucketMs).toBe(300_000);
    expect(s.buckets).toEqual([expect.objectContaining({ start: 0, requests: 2, failed: 1 })]);
    // Minutes east of UTC: +60 shifts the bucket edge one hour back from UTC midnight.
    const day = (await get('/admin/api/logs/series?bucket=day&tz=60')).json();
    expect(day.buckets.map((b: { start: number }) => b.start)).toEqual([-3_600_000]);
    expect((await get('/admin/api/logs/series?tz=junk')).json().bucketMs).toBe(3_600_000);
    const accts = (await get('/admin/api/logs/accounts?model=claude-opus-5-5')).json();
    expect(accts.accounts).toEqual([
      expect.objectContaining({ accountId: 'a1', accountName: '主号', requests: 2, failed: 1 }),
    ]);
  });

  it('reports the log as disabled when there is no store', async () => {
    await build(false);
    expect((await get('/admin/api/logs')).statusCode).toBe(404);
    expect((await get('/admin/api/logs/summary')).statusCode).toBe(404);
    expect((await get('/admin/api/logs/series')).statusCode).toBe(404);
    expect((await get('/admin/api/logs/accounts')).statusCode).toBe(404);
    expect((await get('/admin/api/connection')).json().requestLog).toBe(false);
  });
});

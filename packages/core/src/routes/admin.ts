/**
 * Admin panel for the account pool: `GET /admin` serves the page, and
 * `/admin/api/*` is the JSON API it calls, guarded by the admin key
 * (`x-api-key` or `Authorization: Bearer`). The page itself is public; it
 * holds no data until the browser supplies the key.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { MODELS } from '../claude/models-catalog.js';
import type { AccountPool } from '../pool/account-pool.js';
import type { DeviceLoginManager } from '../pool/device-login.js';
import { parseImport } from '../pool/import-credentials.js';
import type { RequestLogFilter, RequestLogStore } from '../request-log/store.js';
import { createApiKeyAuthHook } from '../shared/auth-hook.js';
import { ADMIN_PAGE_HTML } from './admin-page.js';

export interface AdminRouteDeps {
  adminKey: string;
  /** Client API key, shown on the page so clients (e.g. New API) can be configured. */
  apiKey: string;
  pool: AccountPool;
  logins: DeviceLoginManager;
  /** Absent when the request log is off (`KIRO2CLAUDE_REQUEST_LOG_DAYS=0` or the file could not be opened). */
  requestLog?: RequestLogStore;
}

type LogQuery = {
  Querystring: {
    since?: string;
    until?: string;
    account?: string;
    model?: string;
    status?: string;
    q?: string;
    limit?: string;
    offset?: string;
  };
};

function intParam(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = v === undefined || v === '' ? Number.NaN : Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : fallback;
}

function logFilter(q: LogQuery['Querystring']): RequestLogFilter {
  const time = (v: string | undefined) => {
    const n = v === undefined || v === '' ? Number.NaN : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    since: time(q.since),
    until: time(q.until),
    accountId: q.account || undefined,
    model: q.model || undefined,
    status: q.status === 'ok' || q.status === 'error' ? q.status : undefined,
    q: q.q?.trim() ? q.q.trim().slice(0, 200) : undefined,
  };
}

type IdParams = { Params: { id: string } };

function fail(reply: FastifyReply, status: number, error: unknown): FastifyReply {
  return reply
    .status(status)
    .send({ error: error instanceof Error ? error.message : String(error) });
}

function optString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`${field} must be a string`);
  return v;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminRouteDeps,
): Promise<void> {
  const { pool, logins } = deps;

  app.get('/', async (_request, reply) => {
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer');
    return ADMIN_PAGE_HTML;
  });

  await app.register(
    async (api) => {
      api.addHook('preHandler', createApiKeyAuthHook(deps.adminKey));
      api.addHook('onSend', async (_request, reply, payload) => {
        reply.header('cache-control', 'no-store');
        return payload;
      });

      api.get('/status', async () => {
        const accounts = pool.list();
        const count = (s: string) => accounts.filter((a) => a.status === s).length;
        return {
          accounts: accounts.length,
          ok: count('ok'),
          cooling: count('cooling'),
          disabled: count('disabled'),
          quota: pool.aggregateQuota(),
        };
      });

      api.get('/connection', async () => ({
        apiKey: deps.apiKey,
        models: MODELS.map((m) => m.id),
        requestLog: deps.requestLog !== undefined,
      }));

      api.get<LogQuery>('/logs', async (request, reply) => {
        if (!deps.requestLog) return fail(reply, 404, 'request log is disabled');
        const q = request.query ?? {};
        const limit = intParam(q.limit, 50, 1, 200);
        const offset = intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        return deps.requestLog.list(logFilter(q), limit, offset);
      });

      api.get<LogQuery>('/logs/summary', async (request, reply) => {
        if (!deps.requestLog) return fail(reply, 404, 'request log is disabled');
        return deps.requestLog.summary(logFilter(request.query ?? {}));
      });

      api.get<LogQuery & { Querystring: { bucket?: string; tz?: string } }>(
        '/logs/series',
        async (request, reply) => {
          if (!deps.requestLog) return fail(reply, 404, 'request log is disabled');
          const q = request.query ?? {};
          const bucket = q.bucket === 'day' ? 86_400_000 : q.bucket === '5m' ? 300_000 : 3_600_000;
          // Minutes east of UTC, as the browser's -getTimezoneOffset().
          const tzMinutes = intParam(q.tz, 0, -14 * 60, 14 * 60);
          return {
            bucketMs: bucket,
            buckets: deps.requestLog.series(logFilter(q), bucket, tzMinutes * 60_000),
          };
        },
      );

      api.get<LogQuery>('/logs/accounts', async (request, reply) => {
        if (!deps.requestLog) return fail(reply, 404, 'request log is disabled');
        return { accounts: deps.requestLog.byAccount(logFilter(request.query ?? {})) };
      });

      api.get('/logs/facets', async (_request, reply) => {
        if (!deps.requestLog) return fail(reply, 404, 'request log is disabled');
        return deps.requestLog.facets();
      });

      api.get('/accounts', async () => ({ accounts: pool.list() }));

      // POST so the response (plain-text credentials) is never a cacheable GET.
      api.post<{ Body: { ids?: unknown } }>('/accounts/export', async (request, reply) => {
        const ids = request.body?.ids;
        if (ids !== undefined && !(Array.isArray(ids) && ids.every((x) => typeof x === 'string'))) {
          return fail(reply, 400, 'ids must be an array of account ids');
        }
        const accounts = pool.exportAccounts(ids);
        if (ids && accounts.length === 0) return fail(reply, 404, 'account not found');
        request.log.info({ msg: 'accounts exported', count: accounts.length });
        return { exportedAt: new Date().toISOString(), accounts };
      });

      api.post<{ Body: { text?: unknown; name?: unknown } }>(
        '/accounts/import',
        async (request, reply) => {
          let parsed: ReturnType<typeof parseImport>;
          try {
            const text = optString(request.body?.text, 'text');
            if (!text) return fail(reply, 400, 'text is required');
            parsed = parseImport(text, optString(request.body?.name, 'name'));
          } catch (e) {
            return fail(reply, 400, e);
          }
          const results = [];
          for (const account of parsed.accounts) {
            results.push(await pool.addAccount(account));
          }
          if (results.length === 0) return fail(reply, 400, parsed.errors.join('; '));
          return { results, errors: parsed.errors };
        },
      );

      api.patch<IdParams & { Body: { name?: unknown; enabled?: unknown } }>(
        '/accounts/:id',
        async (request, reply) => {
          const { name, enabled } = request.body ?? {};
          if (enabled !== undefined && typeof enabled !== 'boolean') {
            return fail(reply, 400, 'enabled must be a boolean');
          }
          let patchName: string | undefined;
          try {
            patchName = optString(name, 'name');
          } catch (e) {
            return fail(reply, 400, e);
          }
          if (!pool.update(request.params.id, { name: patchName, enabled })) {
            return fail(reply, 404, 'account not found');
          }
          // A disabled account is skipped by the startup and periodic model queries.
          if (enabled === true) void pool.refreshModels(request.params.id).catch(() => undefined);
          return { ok: true };
        },
      );

      api.delete<IdParams>('/accounts/:id', async (request, reply) => {
        if (!pool.has(request.params.id)) return fail(reply, 404, 'account not found');
        if (!pool.remove(request.params.id)) {
          return fail(reply, 400, 'the kiro-cli account comes from SQLite; disable it instead');
        }
        return { ok: true };
      });

      api.post<IdParams>('/accounts/:id/quota', async (request, reply) => {
        if (!pool.has(request.params.id)) return fail(reply, 404, 'account not found');
        try {
          return { quota: await pool.refreshAccount(request.params.id) };
        } catch (e) {
          return fail(reply, 502, e);
        }
      });

      api.post('/accounts/quota', async () => {
        const results = await Promise.all(
          pool.list().map(async (a) => {
            try {
              await pool.refreshAccount(a.id);
              return { id: a.id, ok: true };
            } catch (e) {
              return { id: a.id, ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          }),
        );
        return { results };
      });

      api.post<{ Body: { startUrl?: unknown; region?: unknown; name?: unknown } }>(
        '/login/start',
        async (request, reply) => {
          try {
            const body = request.body ?? {};
            return await logins.start({
              startUrl: optString(body.startUrl, 'startUrl'),
              region: optString(body.region, 'region'),
              name: optString(body.name, 'name'),
            });
          } catch (e) {
            return fail(reply, 400, e);
          }
        },
      );

      api.get<IdParams>('/login/:id', async (request, reply) => {
        const session = logins.get(request.params.id);
        return session ?? fail(reply, 404, 'login session not found');
      });

      api.delete<IdParams>('/login/:id', async (request, reply) => {
        return logins.cancel(request.params.id)
          ? { ok: true }
          : fail(reply, 404, 'login session not found');
      });
    },
    { prefix: '/api' },
  );
}

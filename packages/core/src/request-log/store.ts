/**
 * SQLite store behind the admin request log. One row per model request,
 * metadata only (no bodies). Rows older than the retention window are pruned
 * at startup and hourly.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RequestLogDraft } from '../shared/request-log.js';

export interface RequestLogEntry {
  id: number;
  ts: number;
  reqId: string;
  method: string;
  path: string;
  model?: string;
  stream: boolean;
  thinking?: string;
  effort?: string;
  accountId?: string;
  accountName?: string;
  /** Names of every account tried, in order; only set when the request switched accounts. */
  accountsTried?: string[];
  status: number;
  durationMs: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextTokens?: number;
  credits?: number;
  meteringLost: boolean;
  stopReason?: string;
  toolNames?: string[];
  emptyAttempts: number;
  errorType?: string;
  errorMessage?: string;
  errorDetail?: string;
  clientDisconnected: boolean;
  clientIp?: string;
  userAgent?: string;
}

export type NewRequestLogEntry = Omit<RequestLogEntry, 'id'>;

export interface RequestLogFilter {
  since?: number;
  until?: number;
  accountId?: string;
  model?: string;
  /** `ok` = no error recorded and status < 400; `error` = the rest. */
  status?: 'ok' | 'error';
  /** Substring match on request id, client IP and User-Agent. */
  q?: string;
}

export interface RequestLogSummary {
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits: number;
  avgDurationMs?: number;
  avgTtftMs?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  req_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  model TEXT,
  stream INTEGER NOT NULL,
  thinking TEXT,
  effort TEXT,
  account_id TEXT,
  account_name TEXT,
  accounts_tried TEXT,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  ttft_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  context_tokens INTEGER,
  credits REAL,
  metering_lost INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  tool_names TEXT,
  empty_attempts INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  error_message TEXT,
  error_detail TEXT,
  client_disconnected INTEGER NOT NULL DEFAULT 0,
  client_ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts);
CREATE INDEX IF NOT EXISTS requests_account_ts ON requests (account_id, ts);
CREATE INDEX IF NOT EXISTS requests_model_ts ON requests (model, ts);
`;

const FAILED_SQL = '(status >= 400 OR error_type IS NOT NULL)';

type Row = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function jsonList(v: unknown): string[] | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : undefined;
  } catch {
    return undefined;
  }
}

function fromRow(r: Row): RequestLogEntry {
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    reqId: String(r.req_id),
    method: String(r.method),
    path: String(r.path),
    model: str(r.model),
    stream: r.stream === 1,
    thinking: str(r.thinking),
    effort: str(r.effort),
    accountId: str(r.account_id),
    accountName: str(r.account_name),
    accountsTried: jsonList(r.accounts_tried),
    status: Number(r.status),
    durationMs: Number(r.duration_ms),
    ttftMs: num(r.ttft_ms),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    cacheWriteTokens: num(r.cache_write_tokens),
    contextTokens: num(r.context_tokens),
    credits: num(r.credits),
    meteringLost: r.metering_lost === 1,
    stopReason: str(r.stop_reason),
    toolNames: jsonList(r.tool_names),
    emptyAttempts: Number(r.empty_attempts ?? 0),
    errorType: str(r.error_type),
    errorMessage: str(r.error_message),
    errorDetail: str(r.error_detail),
    clientDisconnected: r.client_disconnected === 1,
    clientIp: str(r.client_ip),
    userAgent: str(r.user_agent),
  };
}

function where(filter: RequestLogFilter): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.since !== undefined) {
    parts.push('ts >= ?');
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    parts.push('ts < ?');
    params.push(filter.until);
  }
  if (filter.accountId) {
    parts.push('account_id = ?');
    params.push(filter.accountId);
  }
  if (filter.model) {
    parts.push('model = ?');
    params.push(filter.model);
  }
  if (filter.status === 'ok') parts.push(`NOT ${FAILED_SQL}`);
  if (filter.status === 'error') parts.push(FAILED_SQL);
  if (filter.q) {
    const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    parts.push(
      "(req_id LIKE ? ESCAPE '\\' OR client_ip LIKE ? ESCAPE '\\' OR user_agent LIKE ? ESCAPE '\\')",
    );
    params.push(like, like, like);
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

export class RequestLogStore {
  readonly filePath: string;
  readonly #db: Database.Database;
  readonly #insert: Database.Statement;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.#db = new Database(this.filePath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = NORMAL');
    this.#db.exec(SCHEMA);
    this.#insert = this.#db.prepare(`
      INSERT INTO requests (
        ts, req_id, method, path, model, stream, thinking, effort, account_id, account_name,
        accounts_tried, status, duration_ms, ttft_ms, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, context_tokens, credits, metering_lost,
        stop_reason, tool_names, empty_attempts, error_type, error_message, error_detail,
        client_disconnected, client_ip, user_agent
      ) VALUES (
        @ts, @reqId, @method, @path, @model, @stream, @thinking, @effort, @accountId, @accountName,
        @accountsTried, @status, @durationMs, @ttftMs, @inputTokens, @outputTokens,
        @cacheReadTokens, @cacheWriteTokens, @contextTokens, @credits, @meteringLost,
        @stopReason, @toolNames, @emptyAttempts, @errorType, @errorMessage, @errorDetail,
        @clientDisconnected, @clientIp, @userAgent
      )`);
  }

  insert(e: NewRequestLogEntry): void {
    this.#insert.run({
      ts: e.ts,
      reqId: e.reqId,
      method: e.method,
      path: e.path,
      model: e.model ?? null,
      stream: e.stream ? 1 : 0,
      thinking: e.thinking ?? null,
      effort: e.effort ?? null,
      accountId: e.accountId ?? null,
      accountName: e.accountName ?? null,
      accountsTried: e.accountsTried ? JSON.stringify(e.accountsTried) : null,
      status: e.status,
      durationMs: e.durationMs,
      ttftMs: e.ttftMs ?? null,
      inputTokens: e.inputTokens ?? null,
      outputTokens: e.outputTokens ?? null,
      cacheReadTokens: e.cacheReadTokens ?? null,
      cacheWriteTokens: e.cacheWriteTokens ?? null,
      contextTokens: e.contextTokens ?? null,
      credits: e.credits ?? null,
      meteringLost: e.meteringLost ? 1 : 0,
      stopReason: e.stopReason ?? null,
      toolNames: e.toolNames?.length ? JSON.stringify(e.toolNames) : null,
      emptyAttempts: e.emptyAttempts,
      errorType: e.errorType ?? null,
      errorMessage: e.errorMessage ?? null,
      errorDetail: e.errorDetail ?? null,
      clientDisconnected: e.clientDisconnected ? 1 : 0,
      clientIp: e.clientIp ?? null,
      userAgent: e.userAgent ?? null,
    });
  }

  /** Newest first. */
  list(
    filter: RequestLogFilter,
    limit: number,
    offset: number,
  ): { total: number; items: RequestLogEntry[] } {
    const w = where(filter);
    const total = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM requests ${w.sql}`)
      .get(...w.params) as {
      n: number;
    };
    const rows = this.#db
      .prepare(`SELECT * FROM requests ${w.sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...w.params, limit, offset) as Row[];
    return { total: total.n, items: rows.map(fromRow) };
  }

  summary(filter: RequestLogFilter): RequestLogSummary {
    const w = where(filter);
    const r = this.#db
      .prepare(`
        SELECT
          COUNT(*) AS requests,
          COALESCE(SUM(CASE WHEN ${FAILED_SQL} THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(credits), 0) AS credits,
          AVG(CASE WHEN ${FAILED_SQL} THEN NULL ELSE duration_ms END) AS avg_duration_ms,
          AVG(CASE WHEN ${FAILED_SQL} THEN NULL ELSE ttft_ms END) AS avg_ttft_ms
        FROM requests ${w.sql}`)
      .get(...w.params) as Row;
    return {
      requests: Number(r.requests),
      failed: Number(r.failed),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      credits: Number(r.credits),
      avgDurationMs: num(r.avg_duration_ms),
      avgTtftMs: num(r.avg_ttft_ms),
    };
  }

  /** Values seen in the log, for the filter dropdowns. */
  facets(): { models: string[]; accounts: { id: string; name: string }[] } {
    const models = this.#db
      .prepare('SELECT DISTINCT model FROM requests WHERE model IS NOT NULL ORDER BY model')
      .all() as { model: string }[];
    const accounts = this.#db
      .prepare(`
        SELECT account_id AS id, account_name AS name FROM requests
        WHERE id IN (SELECT MAX(id) FROM requests WHERE account_id IS NOT NULL GROUP BY account_id)
        ORDER BY name`)
      .all() as { id: string; name: string | null }[];
    return {
      models: models.map((m) => m.model),
      accounts: accounts.map((a) => ({ id: a.id, name: a.name ?? a.id })),
    };
  }

  /**
   * Point past rows of an account at its new name: `account_name` by id, and
   * `from` inside `accounts_tried` (which keeps names only).
   */
  renameAccount(id: string, from: string, to: string): number {
    const named = this.#db
      .prepare(
        'UPDATE requests SET account_name = ? WHERE account_id = ? AND account_name IS NOT ?',
      )
      .run(to, id, to).changes;
    if (from !== to) {
      this.#db
        .prepare(`
          UPDATE requests SET accounts_tried = replace(accounts_tried, json_quote(@from), json_quote(@to))
          WHERE accounts_tried IS NOT NULL AND instr(accounts_tried, json_quote(@from)) > 0`)
        .run({ from, to });
    }
    return named;
  }

  /** Delete rows that started before `cutoff`; returns the number removed. */
  prune(cutoff: number): number {
    return this.#db.prepare('DELETE FROM requests WHERE ts < ?').run(cutoff).changes;
  }

  close(): void {
    this.#db.close();
  }
}

/** Finished draft → stored row. `accountName` resolves pool ids to their current display name. */
export function entryFromDraft(
  d: RequestLogDraft,
  accountName: (id: string) => string | undefined,
): NewRequestLogEntry {
  const finishedAt = d.finishedAt ?? Date.now();
  const accountId = d.accountIds.at(-1);
  const name = (id: string) => accountName(id) ?? id;
  const tried = [...new Set(d.accountIds)];
  return {
    ts: d.startedAt,
    reqId: d.reqId,
    method: d.method,
    path: d.path,
    model: d.model,
    stream: d.stream,
    thinking: d.thinking,
    effort: d.effort,
    accountId,
    accountName: accountId ? name(accountId) : undefined,
    accountsTried: tried.length > 1 ? tried.map(name) : undefined,
    status: d.statusCode ?? 0,
    durationMs: Math.max(0, finishedAt - d.startedAt),
    ttftMs: d.firstTokenAt !== undefined ? Math.max(0, d.firstTokenAt - d.startedAt) : undefined,
    inputTokens: d.usage?.inputTokens,
    outputTokens: d.usage?.outputTokens,
    cacheReadTokens: d.usage?.cacheReadTokens,
    cacheWriteTokens: d.usage?.cacheWriteTokens,
    contextTokens: d.usage?.contextTokens,
    credits: d.usage?.credits,
    meteringLost: d.usage?.meteringLost ?? false,
    stopReason: d.stopReason,
    toolNames: d.toolNames,
    emptyAttempts: d.emptyAttempts ?? 0,
    errorType: d.errorType,
    errorMessage: d.errorMessage,
    errorDetail: d.errorDetail?.slice(0, 1000),
    clientDisconnected: d.clientDisconnected ?? false,
    clientIp: d.clientIp,
    userAgent: d.userAgent?.slice(0, 500),
  };
}

/**
 * Per-request record for the admin request log (`/admin` → 请求日志).
 *
 * `withRequestLog` opens a draft on the request context when a model route
 * handler starts; the pipeline fills in what it learns along the way
 * (`noteRequestLog`, `noteAccountAttempt`, `noteFirstToken`). The draft is
 * handed to the sink exactly once, after BOTH the handler has returned and the
 * response has finished: after a client disconnect the stream keeps draining
 * upstream and only bills (usage-finish hook) once the response is long gone.
 *
 * Only metadata is recorded, never request or response bodies.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { getLogger } from './logger.js';
import { getRequestContext } from './request-context.js';

export interface RequestLogUsage {
  /** Uncached input (plugin-derived when credits are known, else the raw upstream count). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Context size reported by the upstream (`kiro.inputTokens`). */
  contextTokens: number;
  credits?: number;
  meteringLost: boolean;
}

export interface RequestLogDraft {
  reqId: string;
  startedAt: number;
  method: string;
  path: string;
  clientIp: string;
  userAgent?: string;
  model?: string;
  stream: boolean;
  /** `adaptive` / `disabled` for Claude models; unset for GPT and non-native models. */
  thinking?: string;
  effort?: string;
  /** Pool accounts in the order they were tried; the last one served the request. */
  accountIds: string[];
  firstTokenAt?: number;
  stopReason?: string;
  toolNames?: string[];
  emptyAttempts?: number;
  usage?: RequestLogUsage;
  errorType?: string;
  errorMessage?: string;
  /** Internal cause (upstream error code / provider error); admin-only, never sent to clients. */
  errorDetail?: string;
  statusCode?: number;
  finishedAt?: number;
  clientDisconnected?: boolean;
  handlerDone: boolean;
}

export type RequestLogPatch = Partial<
  Pick<
    RequestLogDraft,
    | 'thinking'
    | 'effort'
    | 'stopReason'
    | 'toolNames'
    | 'emptyAttempts'
    | 'usage'
    | 'errorType'
    | 'errorMessage'
    | 'errorDetail'
  >
>;

type Sink = (draft: RequestLogDraft) => void;

let sink: Sink | undefined;
const written = new WeakSet<RequestLogDraft>();

/** Installed once at startup; without a sink, model routes keep no draft at all. */
export function setRequestLogSink(fn: Sink | undefined): void {
  sink = fn;
}

function currentDraft(): RequestLogDraft | undefined {
  return getRequestContext()?.requestLog;
}

export function noteRequestLog(patch: RequestLogPatch): void {
  const draft = currentDraft();
  if (draft) Object.assign(draft, patch);
}

/** Error info is first-writer-wins: the specific cause beats the generic envelope seen later. */
export function noteRequestError(type: string, message: string, detail?: string): void {
  const draft = currentDraft();
  if (!draft || draft.errorType !== undefined) return;
  draft.errorType = type;
  draft.errorMessage = message;
  if (detail !== undefined) draft.errorDetail ??= detail;
}

export function noteRequestErrorDetail(detail: string): void {
  const draft = currentDraft();
  if (draft) draft.errorDetail ??= detail;
}

export function noteAccountAttempt(accountId: string): void {
  currentDraft()?.accountIds.push(accountId);
}

export function noteFirstToken(): void {
  const draft = currentDraft();
  if (draft && draft.firstTokenAt === undefined) draft.firstTokenAt = Date.now();
}

function flush(draft: RequestLogDraft): void {
  if (!draft.handlerDone || draft.finishedAt === undefined || written.has(draft)) return;
  written.add(draft);
  try {
    sink?.(draft);
  } catch (err) {
    getLogger().warn({
      msg: 'request log write failed',
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The response is finished, or the client went away before it was. */
function finishResponse(draft: RequestLogDraft, reply: FastifyReply): void {
  if (draft.finishedAt !== undefined) return;
  draft.finishedAt = Date.now();
  draft.statusCode = reply.raw.statusCode;
  draft.clientDisconnected = !reply.raw.writableFinished;
  flush(draft);
}

/** Error envelope of a >= 400 JSON response body (Claude and OpenAI shapes both carry `error.type` / `error.message`). */
export function noteErrorResponseBody(payload: string): void {
  if (!currentDraft()) return;
  let body: { error?: { type?: unknown; message?: unknown } };
  try {
    body = JSON.parse(payload);
  } catch {
    return;
  }
  const type = body?.error?.type;
  const message = body?.error?.message;
  if (typeof type === 'string') noteRequestError(type, typeof message === 'string' ? message : '');
}

/** Wraps a model route handler so its request gets a draft and is written when done. */
export function withRequestLog(
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const ctx = getRequestContext();
    if (!sink || !ctx) return handler(request, reply);
    const body = (request.body ?? {}) as { model?: unknown; stream?: unknown };
    const userAgent = request.headers['user-agent'];
    const draft: RequestLogDraft = {
      reqId: ctx.reqId,
      startedAt: ctx.startTime,
      method: request.method,
      path: request.url,
      clientIp: request.ip,
      userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      stream: body.stream === true,
      accountIds: [],
      handlerDone: false,
    };
    ctx.requestLog = draft;
    // `close` rather than Fastify's onResponse: onResponse only runs on `finish`,
    // which never comes when the client disconnects mid-stream.
    reply.raw.once('close', () => finishResponse(draft, reply));
    try {
      await handler(request, reply);
    } finally {
      draft.handlerDone = true;
      flush(draft);
    }
  };
}

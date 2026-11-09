import type { UsageFinishEvent } from '@kiro2claude/plugin-api';
import { localPromptSplit } from '../kiro/prompt-cache.js';
import { UsageFinishEventImpl } from '../plugin-host/index.js';
import type { RequestLogUsage } from '../shared/request-log.js';

/**
 * Token breakdown for the request log, read after every plugin hook has run (the hook is
 * registered last). The gateway's own count (`localPromptSplit`, exact or tracker-based) wins:
 * it is what the log is for. Without it (the request never got an upstream success) plugin overrides, then
 * the raw upstream count as input with no cache split, stand in.
 */
export function requestLogUsage(event: UsageFinishEvent): RequestLogUsage {
  const contextTokens = event.getMeta<number>('kiro.inputTokens') ?? 0;
  const outputTokens = event.getMeta<number>('kiro.outputTokens') ?? 0;
  const common = {
    outputTokens,
    contextTokens,
    credits: event.getMeta<number>('kiro.creditsUsed'),
    meteringLost: event.getMeta<boolean>('kiro.meteringMissing') === true,
  };
  const local = localPromptSplit(event);
  if (local) {
    const { exact, ...split } = local;
    return { ...split, ...common, accounting: exact ? 'exact' : 'local' };
  }

  const overrides = event instanceof UsageFinishEventImpl ? event.getOverrides() : undefined;
  return {
    ...common,
    inputTokens: overrides?.get('input_tokens') ?? contextTokens,
    outputTokens: overrides?.get('output_tokens') ?? outputTokens,
    cacheReadTokens: overrides?.get('cache_read_input_tokens') ?? 0,
    cacheWriteTokens: overrides?.get('cache_creation_input_tokens') ?? 0,
    accounting: overrides?.get('cache_read_input_tokens') === undefined ? 'raw' : 'derived',
  };
}

/**
 * Static model catalog for `GET /claude/v1/models` (and, reshaped, `/openai/v1/models`).
 *
 * One entry per model the upstream `ListAvailableModels` returns for kiro-cli,
 * in the upstream order. Thinking is a request parameter, not a model, so there
 * are no `-thinking` entries; `mapModel` accepts any id with a `-thinking`
 * suffix as the plain id. When the upstream list changes, edit this table and `mapModel`
 * together and re-run `pnpm test`.
 */

import type { Model, ModelsResponse } from './types.js';

/** 2026-10-29: the day the non-Claude upstream models were added here (no public release date). */
const ADDED = 1793232000;

function model(id: string, created: number, owned_by: string, display_name: string): Model {
  return { id, object: 'model', created, owned_by, display_name, type: 'chat', max_tokens: 64000 };
}

/** Full list of model identifiers exposed by this proxy. */
export const MODELS: Model[] = [
  model('auto', ADDED, 'kiro', 'Auto (Kiro picks the model)'),
  model('claude-opus-5-5', 1790035200, 'anthropic', 'Claude Opus 5.5'),
  model('claude-sonnet-5-5', 1790553600, 'anthropic', 'Claude Sonnet 5.5'),
  model('claude-haiku-5-5', 1791331200, 'anthropic', 'Claude Haiku 5.5'),
  // GPT-5.6 系列（OpenAI，kiro-cli 2.12.1 起）。走与 Claude 完全相同的上游
  // conversationState wire，故经 `/claude/v1` 也可用（mapModel 处理）；同时是
  // `/openai/v1` 的一等公民。
  model('gpt-5.6-sol', 1783900800, 'openai', 'GPT-5.6 Sol'),
  model('gpt-5.6-terra', 1783900800, 'openai', 'GPT-5.6 Terra'),
  model('gpt-5.6-luna', 1783900800, 'openai', 'GPT-5.6 Luna'),
  model('kimi-k3', ADDED, 'moonshotai', 'Kimi K3'),
  model('claude-opus-5', 1784505600, 'anthropic', 'Claude Opus 5'),
  model('claude-sonnet-5', 1781481600, 'anthropic', 'Claude Sonnet 5'),
  model('claude-opus-4-8', 1779840000, 'anthropic', 'Claude Opus 4.8'),
  model('claude-opus-4-7', 1776384000, 'anthropic', 'Claude Opus 4.7'),
  model('claude-opus-4-6', 1770336000, 'anthropic', 'Claude Opus 4.6'),
  model('claude-sonnet-4-6', 1771372800, 'anthropic', 'Claude Sonnet 4.6'),
  model('claude-opus-4-5', 1763942400, 'anthropic', 'Claude Opus 4.5'),
  model('claude-sonnet-4-5', 1759104000, 'anthropic', 'Claude Sonnet 4.5'),
  model('claude-haiku-4-5', 1760486400, 'anthropic', 'Claude Haiku 4.5'),
  model('deepseek-3.2', ADDED, 'deepseek', 'DeepSeek 3.2'),
  model('minimax-m2.5', ADDED, 'minimax', 'MiniMax M2.5'),
  model('minimax-m2.1', ADDED, 'minimax', 'MiniMax M2.1'),
  model('glm-5', ADDED, 'zhipuai', 'GLM-5'),
  model('qwen3-coder-next', ADDED, 'qwen', 'Qwen3 Coder Next'),
];

/** Shape the catalog as the `list`-typed response expected by clients. */
export function getModelsResponse(): ModelsResponse {
  return {
    object: 'list',
    data: MODELS,
  };
}

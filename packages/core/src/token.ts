import axios from 'axios';
import type {
  CountTokensRequest,
  CountTokensResponse,
  Message,
  SystemMessage,
  Tool,
} from './claude/types.js';
import { logger } from './shared/logger.js';

/** Count Tokens API 配置 */
export interface CountTokensConfig {
  apiUrl?: string;
  apiKey?: string;
  authType: string;
}

let countTokensConfig: CountTokensConfig | undefined;

/** 初始化 count_tokens 配置（应在应用启动时调用一次） */
export function initCountTokensConfig(config: CountTokensConfig): void {
  countTokensConfig = config;
}

/**
 * 判断字符是否为非西文字符
 *
 * 西文字符包括 ASCII、拉丁字母扩展等
 * 返回 true 表示该字符是非西文字符（如中文、日文、韩文等）
 */
function isNonWesternChar(c: string): boolean {
  // for-of 遍历字符串产出的每个元素至少包含一个 code point，codePointAt(0) 永远有值；
  // 这里用 `?? 0` 收敛掉类型层面的 undefined，0 落在 ASCII 区间，即使退化也返回 false（西文）
  const code = c.codePointAt(0) ?? 0;
  return !(
    (
      (code >= 0x0000 && code <= 0x007f) || // 基本 ASCII
      (code >= 0x0080 && code <= 0x00ff) || // 拉丁字母扩展-A
      (code >= 0x0100 && code <= 0x024f) || // 拉丁字母扩展-B
      (code >= 0x1e00 && code <= 0x1eff) || // 拉丁字母扩展附加
      (code >= 0x2c60 && code <= 0x2c7f) || // 拉丁字母扩展-C
      (code >= 0xa720 && code <= 0xa7ff) || // 拉丁字母扩展-D
      (code >= 0xab30 && code <= 0xab6f)
    ) // 拉丁字母扩展-E
  );
}

/**
 * 计算文本的 token 数量
 *
 * 非西文字符每个计 4.0 个字符单位，西文字符每个计 1 个
 * 4 个字符单位 = 1 token
 */
export function countTokens(text: string): number {
  let charUnits = 0;
  for (const c of text) {
    charUnits += isNonWesternChar(c) ? 4.0 : 1.0;
  }

  const tokens = charUnits / 4.0;

  let accToken: number;
  if (tokens < 100) {
    accToken = tokens * 1.5;
  } else if (tokens < 200) {
    accToken = tokens * 1.3;
  } else if (tokens < 300) {
    accToken = tokens * 1.25;
  } else if (tokens < 800) {
    accToken = tokens * 1.2;
  } else {
    accToken = tokens * 1.0;
  }

  return Math.floor(accToken);
}

/**
 * Per-feature token weights fitted against the upstream's own count (2026-11-04, claude-opus-5.5,
 * 16 input samples + 4 echoed outputs: code, Chinese/English docs, JSON, YAML, base64, digits,
 * indentation). RMS error 7 %; the older chars/4 heuristic is off by 50 % on the same set and
 * undercounts output 1.4–1.9×. Units are the upstream's: the same ones `contextUsage` and
 * credits are computed in. Weights not listed here fitted to 0 (word length, single spaces);
 * other non-ASCII characters are given 1 token each, which the sample set barely covered.
 */
const TOKEN_WEIGHTS = {
  cjk: 1.133,
  /** A run of ASCII letters. */
  word: 1.927,
  digit: 0.451,
  punct: 0.805,
  newline: 2.062,
  /** lower → upper inside a word (camelCase, base64). */
  caseStep: 3.12,
  other: 1,
};

type CharClass = 'cjk' | 'letter' | 'digit' | 'space' | 'newline' | 'punct' | 'other';

function isCjk(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * Running token count for text that arrives in pieces (a stream). Word and case runs carry
 * over between pieces, so chunking does not change the total.
 */
export class TokenTally {
  #units = 0;
  #chars = 0;
  #prev: CharClass | undefined;
  #prevUpper = false;

  add(text: string): void {
    const w = TOKEN_WEIGHTS;
    for (const c of text) {
      const code = c.codePointAt(0) ?? 0;
      this.#chars++;
      let cls: CharClass;
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
        const upper = code <= 90;
        if (this.#prev !== 'letter') this.#units += w.word;
        else if (upper && !this.#prevUpper) this.#units += w.caseStep;
        this.#prevUpper = upper;
        cls = 'letter';
      } else if (code >= 48 && code <= 57) {
        this.#units += w.digit;
        cls = 'digit';
      } else if (code === 10) {
        this.#units += w.newline;
        cls = 'newline';
      } else if (code === 32 || code === 9 || code === 13) {
        cls = 'space';
      } else if (code < 128) {
        this.#units += w.punct;
        cls = 'punct';
      } else if (isCjk(code)) {
        this.#units += w.cjk;
        cls = 'cjk';
      } else {
        this.#units += w.other;
        cls = 'other';
      }
      this.#prev = cls;
    }
  }

  /** 0 only when nothing was added; any text counts as at least 1. */
  get tokens(): number {
    return this.#chars === 0 ? 0 : Math.max(1, Math.round(this.#units));
  }
}

/** Token count in the upstream's units, see {@link TokenTally}. */
export function countUpstreamTokens(text: string): number {
  const tally = new TokenTally();
  tally.add(text);
  return tally.tokens;
}

/** 调用远程 count_tokens API */
async function callRemoteCountTokens(
  apiUrl: string,
  config: CountTokensConfig,
  model: string,
  system: SystemMessage[] | undefined,
  messages: Message[],
  tools: Tool[] | undefined,
): Promise<number> {
  const client = axios.create({ timeout: 300_000 });

  const request: CountTokensRequest = {
    model,
    messages,
    system,
    tools,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.apiKey) {
    if (config.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    } else {
      headers['x-api-key'] = config.apiKey;
    }
  }

  const response = await client.post<CountTokensResponse>(apiUrl, request, { headers });
  return response.data.input_tokens;
}

/**
 * 估算请求的输入 tokens
 *
 * 优先调用远程 API，失败时回退到本地计算
 */
export async function countAllTokens(
  model: string,
  system: SystemMessage[] | undefined,
  messages: Message[],
  tools: Tool[] | undefined,
): Promise<number> {
  if (countTokensConfig?.apiUrl) {
    try {
      const tokens = await callRemoteCountTokens(
        countTokensConfig.apiUrl,
        countTokensConfig,
        model,
        system,
        messages,
        tools,
      );
      return tokens;
    } catch (e) {
      // 远程 API 失败，回退到本地计算（保留原有回退语义，但补一条 warn 方便诊断）
      logger.warn(`Remote count_tokens failed, fallback to local: ${(e as Error).message}`);
    }
  }

  return countAllTokensLocal(system, messages, tools);
}

/** 本地计算请求的输入 tokens */
function countAllTokensLocal(
  system: SystemMessage[] | undefined,
  messages: Message[],
  tools: Tool[] | undefined,
): number {
  let total = 0;

  // 系统消息
  if (system) {
    for (const msg of system) {
      total += countTokens(msg.text);
    }
  }

  // 用户消息
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += countTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          total += countTokens(item.text);
        }
      }
    }
  }

  // 工具定义
  // 两个可选字段分别防护：countTokens 不接受 undefined（for-of 会炸），
  // 且 JSON.stringify(undefined) 返回 undefined 而非字符串。
  if (tools) {
    for (const tool of tools) {
      total += countTokens(tool.name);
      if (tool.description) {
        total += countTokens(tool.description);
      }
      if (tool.input_schema) {
        total += countTokens(JSON.stringify(tool.input_schema));
      }
    }
  }

  return Math.max(total, 1);
}

/** 估算输出 tokens(text、thinking、tool_use 入参),口径见 {@link TokenTally}。 */
export function estimateOutputTokens(content: Record<string, unknown>[]): number {
  const tally = new TokenTally();

  for (const block of content) {
    if (typeof block.text === 'string') tally.add(block.text);
    if (typeof block.thinking === 'string') tally.add(block.thinking);
    if (block.type === 'tool_use' && block.input) tally.add(JSON.stringify(block.input));
  }

  return Math.max(tally.tokens, 1);
}

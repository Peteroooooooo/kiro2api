# plugin-derived

> **内置 runtime 插件**(作为 `@kiro2claude/core` 的依赖随镜像默认启用):通过 [`@kiro2claude/plugin-api`](../plugin-api/) 接入 core gateway,把 Kiro 原始 credit 反演成 Anthropic 风格的 token 拆分。默认直接覆写标准 token 字段;诊断模式下注入的扩展字段 `usage.kiro_derived` 与 plugin 名(`derived`)一致。

## 解决什么问题

Kiro 上游的计量帧(`meteringEvent.usage`)只给一个聚合 credit 数,缺失下游 Anthropic 客户端期望的 `cache_creation_input_tokens` / `cache_read_input_tokens` 拆分。本 plugin 在 `onUsageFinish` hook 里读 `'kiro.creditsUsed'`,按 `'kiro.pricedModel'`(core 映射后的上游 id)查价,基于回归拟合常数(`KIRO_K_IN` / `KIRO_K_OUT`)反演 cache 字段:

- 默认:`overrideStandardField` 覆写 `input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`(OpenAI 端点只取 `cache_read`,映射成 `cached_tokens`)
- `KIRO2CLAUDE_DERIVED_INCLUDE_FIELD=true`(诊断):标准字段不动,改以 `addExtension('kiro_derived', …)` 暴露完整拆分,形状见 `src/derive.ts` 的 `KiroDerivedMetadata`,`derivedStatus` 取值 `ok_derived` / `below_threshold` / `unknown_model` / `gpt_credit_anchored`

Kiro 按上游倍率计价,与 Anthropic 标价不总在一条线上:偏离倍率线的模型反演改用 `KIRO_BILLING`(可带未命中溢价,只作用于 prompt、不作用于本轮输出),按 prompt 长度整单加价的(haiku-5.5 超 100K ×5)进 `LONG_CONTEXT_TIER`;收录的模型与系数以 `src/derive.ts` 为准,证据见 docs/PITFALLS.md「支持哪些模型」。

### GPT-5.6 系列(独立反演,成本锚定 credit)

GPT-5.6(sol/terra/luna 及 Codex 别名)走 `deriveKiroUsage` 顶部的**专属分支**,用自己的计费公式反演缓存:

```
credits = 倍率 × [ GPT_K_IN · (未命中 + 0.1 · 命中) + GPT_K_OUT · 输出 ]
```

缓存价为冷价的 0.1×,命中 = 同 conversationId 里此前请求的前缀、换 conversationId 不命中;倍率即上游 rateMultiplier(`GPT_RATE_MULTIPLIER`),prompt 超过 272K 整单 ×2、命中也翻倍(`GPT_LONG_CONTEXT`)。隐藏的推理 token 无法观测,按 0 解,推理只会让 `cache_read` **低估**;可见输出由 core 估算,估多 Δ 会虚报约 6.3Δ(见 docs/PITFALLS.md「GPT credit 锚定与缓存反演」);`cache_creation` 恒 0(OpenAI 缓存没有写入溢价)。成本不按单价重算,仍锚定 `credits × KIRO_OVERAGE_RATE`(× multiplier),`derivedStatus = 'gpt_credit_anchored'`。**切勿给 GPT 填 `CLAUDE_PRICE_USD_PER_TOK`**——Claude 的系数与缓存比例和 GPT 不同。常数与证据见 `src/derive.ts` 的 `gptCacheDerivedBreakdown` 头注释。

## 依赖

无 `dependsOn`。反演只读 host 注入的 `'kiro.creditsUsed'` meta key(任何路径都存在),不依赖 `metering` 插件的 wire 输出,故与 metering 的加载顺序无关。

## 关键真相源

| 想看 | 文件 |
|---|---|
| KiroPlugin manifest + hook 注册 | `src/index.ts` |
| 反演公式 / 数学常数 `KIRO_K_IN` `KIRO_K_OUT` `KIRO_CACHE_READ_RATIO` | `src/derive.ts` |

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `KIRO2CLAUDE_DERIVED_INCLUDE_FIELD` | `false` | `true` 时不覆写标准字段,改注入 `usage.kiro_derived` |
| `KIRO2CLAUDE_COST_MULTIPLIER` | `1.0` | `kiro_derived.finalCostUsd` 的倍率,只在诊断模式可见 |
| `KIRO2CLAUDE_CACHE_READ_RATIO` | `KIRO_CACHE_READ_RATIO` | Claude 模型的 cache 反演比例旋钮,只接受 `[0,1)` |

公式与取值说明见 [`.env.example`](../../.env.example) 的 derived 节。

## 测试

```bash
pnpm --filter @kiro2claude/plugin-derived test
```

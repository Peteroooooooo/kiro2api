# kiro2claude

把 kiro-cli(Kiro 后端)包装成 **Anthropic Messages + OpenAI Chat Completions / Responses** 双协议网关:改个 base URL,Claude Code、Codex CLI 与各家 SDK 即可接入,账单走你的 kiro-cli。支持流式、工具调用、Vision、原生 reasoning、hosted WebSearch 与 `count_tokens`。

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node->=22-brightgreen.svg)
[![ghcr](https://img.shields.io/badge/ghcr.io-yupanzi%2Fkiro2claude-2496ED.svg)](https://github.com/yupanzi/kiro2claude/pkgs/container/kiro2claude)

> **免责声明**:非官方项目,与 AWS、Amazon、Anthropic、OpenAI、Kiro 均无关联、未获授权;上述名称为各自所有者的商标,此处仅用于说明 API 协议兼容。仅供学习研究、非商业用途;接入第三方代理**可能违反上游服务条款并导致账号封停**。软件按 [MIT](./LICENSE)「原样(AS IS)」提供、不含任何担保,**风险与法律责任自负**。

## 支持的模型

| 模型 ID | 上下文 | reasoning |
|---|---|---|
| `claude-opus-5-5` | 1M | 原生,常开 |
| `claude-opus-5` · `claude-opus-4-8` · `claude-opus-4-7` | 1M | 原生 |
| `claude-opus-4-6` | 1M | 无 |
| `claude-sonnet-5-5` | 1M | 原生,常开 |
| `claude-sonnet-5` · `claude-sonnet-4-6` | 1M | 原生 |
| `claude-haiku-5-5` | 1M | 原生 |
| `gpt-5.6-sol` · `gpt-5.6-terra` · `gpt-5.6-luna` | 922K | 原生,不透明 |

- 两个协议端点共用同一份目录,真相源 [`models-catalog.ts`](./packages/core/src/claude/models-catalog.ts);每个 Claude 模型另有 `-thinking` 变体
- 「常开」= 上游不接受关闭 thinking,`disabled` 按 adaptive + `low` effort 发送
- 没有版本号或 4.5 及更老的写法(如 `claude-haiku-4-5`)兜底到同家族最新版本(目前是 5.5);表里没有的其它版本返回 400
- 计价差异:Opus 5.5 / Sonnet 5.5 冷请求有溢价,Haiku 5.5 与 GPT 的长 prompt 整单加价,系数见 [`plugin-derived`](./packages/plugin-derived/)
- GPT 窗口未放开的账号设 `KIRO2CLAUDE_GPT_CONTEXT_WINDOW=272000`;Fable 系列 Kiro 尚未提供

## 快速开始

```bash
# 1. kiro-cli 登录(凭据写入本地 SQLite)
kiro-cli login --use-device-flow --identity-provider https://your-idc.awsapps.com/start --region us-east-1
# 或 Builder ID:kiro-cli login --use-device-flow --license free

# 2. 起服务(Linux 凭据路径 ~/.local/share/kiro-cli/data.sqlite3)
pnpm install
KIRO2CLAUDE_API_KEY=sk-local-test \
KIRO2CLAUDE_SQLITE_DB_PATH="$HOME/Library/Application Support/kiro-cli/data.sqlite3" \
pnpm dev
```

默认监听 `127.0.0.1:8080`。Claude 客户端 base URL 用 `http://127.0.0.1:8080/claude`,OpenAI 客户端用 `http://127.0.0.1:8080/openai/v1`。全部环境变量见 [`.env.example`](./.env.example)。

```bash
curl -s http://127.0.0.1:8080/claude/v1/messages \
  -H 'x-api-key: sk-local-test' -H 'content-type: application/json' \
  -d '{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'
```

## Docker

```bash
cp .env.example .env   # 填 KIRO2CLAUDE_API_KEY;删掉 KIRO2CLAUDE_SQLITE_DB_PATH 行(镜像已内置)

docker run -d --name kiro2claude --env-file .env \
  -e KIRO2CLAUDE_HOST=0.0.0.0 \
  -e KIRO2CLAUDE_LOGIN_START_URL=https://d-xxx.awsapps.com/start \
  -e KIRO2CLAUDE_LOGIN_REGION=us-east-1 \
  -p 8080:8080 \
  -v kiro-home:/home/kiro/.local/share/kiro-cli \
  ghcr.io/yupanzi/kiro2claude:latest

docker logs -f kiro2claude   # 首次启动打出 device flow URL,浏览器完成认证
```

## HTTP 路由

除 `/`、`/health` 外都用 `KIRO2CLAUDE_API_KEY` 鉴权。

| 路径 | 说明 |
|---|---|
| `GET /health` | liveness 探针 |
| `GET /claude/v1/models` · `GET /openai/v1/models` | 模型列表 |
| `POST /claude/v1/messages` | Anthropic Messages |
| `POST /claude/v1/messages/count_tokens` | Token 计数 |
| `POST /openai/v1/chat/completions` | OpenAI Chat Completions |
| `POST /openai/v1/responses` | OpenAI Responses(Codex CLI) |
| `/api/{claude,openai}/v1/*` | 同上,`usage` 不含插件扩展字段 |
| `GET /kiro/usage` | Kiro 额度查询 |

## 插件

镜像内置两个插件,均默认启用;写自己的插件见 [`docs/PLUGIN-DEVELOPMENT.md`](./docs/PLUGIN-DEVELOPMENT.md)。

| 插件 | 作用 |
|---|---|
| [`plugin-metering`](./packages/plugin-metering/) | 注入本次 credit 消耗 `usage.kiro_metering` |
| [`plugin-derived`](./packages/plugin-derived/) | 把 credit 反演成 Anthropic 风格 token / cache 字段 |

## 已知限制

网关只修 wire 与协议翻译层,以下行为仍然存在(「」内为 [`docs/PITFALLS.md`](./docs/PITFALLS.md) 条目):

- system 只有 user 级权重,身份覆写不可靠(`KIRO2CLAUDE_IDENTITY_OVERRIDE` 默认关)「注入文本」
- 以 assistant 结尾的请求不是真 prefill
- 客户端压缩或省略的历史无法还原,历史 thinking 只回传带签名的「原生 reasoning / effort / system 的 wire 真相」
- GPT 推理不可读,Chat Completions 不回传推理「推理往返」
- 多张图片只能按位置归属到工具调用「多图归属只靠顺序」
- tool_result 的 `is_error` 不会到达模型,成败只能从正文判断「工具调用往返与图片的 wire 形态」
- 超长工具 description 截尾,超过 63 字符的工具名改写后再还原「tool description cap」
- 上游中途报错时,之前已下发的正文留在客户端
- Claude Code 的 Write 会把字面 `\uXXXX` 转义还原成字符(客户端侧,复现 `claude-unicode-input-probe.mjs`)

## 文档

| 主题 | 入口 |
|---|---|
| 架构 / 规范 / 踩坑地图 | [AGENTS.md](./AGENTS.md) |
| 踩坑来龙去脉 | [`docs/PITFALLS.md`](./docs/PITFALLS.md) |
| 插件开发 | [`docs/PLUGIN-DEVELOPMENT.md`](./docs/PLUGIN-DEVELOPMENT.md) |
| 手工探针 | [`packages/core/test/manual/README.md`](./packages/core/test/manual/README.md) |
| 真实 CLI harness | [`tools/claude-code/`](./tools/claude-code/) · [`tools/codex/`](./tools/codex/) |
| 贡献 / 提交 / 发版 | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| 安全披露 | [SECURITY.md](./SECURITY.md) |

## 许可证

[MIT](./LICENSE),Copyright (c) 2026 yupanzi。

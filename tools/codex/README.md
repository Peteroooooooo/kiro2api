# OpenAI Codex 兼容性测试 harness

开发 / 测试用的 Docker harness(不是 runtime plugin,不随镜像发布):在容器里跑真实 Codex CLI,经网关 `/openai/v1/responses` 打真实 GPT 模型。与 [`tools/claude-code/`](../claude-code/) 对称。

## 前置条件

- Docker Desktop / Engine
- 网关已启动并监听 `0.0.0.0`(容器经 `host.docker.internal` 访问)
- 有效 API key

## 快速启动

```bash
# 交互式 REPL
./tools/codex/run.sh -t sk-local-test

# headless 单次(工具调用在容器内真实执行)
./tools/codex/run.sh -t sk-local-test -- exec "Run 'uname -s' and tell me the output"

# 挂载项目目录做真实编码任务
./tools/codex/run.sh -t sk-local-test -w ~/projects/myapp
```

| 参数 | 说明 | 默认 |
|---|---|---|
| `-t, --token` | API token → `KIRO2CLAUDE_API_KEY` | 必填 / 交互 |
| `-u, --url` | 网关 OpenAI 端点 | `http://host.docker.internal:8080/openai/v1` |
| `-m, --model` | Codex model | `gpt-5.6-sol` |
| `-v, --version` | Codex 版本 | `VERSION` 文件(`latest`) |
| `-n, --network` | `bridge` / `host` | `bridge` |
| `-w, --workspace` | 挂载到 `/workspace` | 无 |
| `--build` | 强制重建(latest 自动 `--pull --no-cache`) | - |
| `--shell` | bash 进容器调试 | - |
| `-- <args>` | 原样透传给 `codex` | - |

容器内沙箱为 `danger-full-access` + `approval_policy=never`(容器本身即隔离)。

## 验证过的版本

本仓只在这里记录端到端验证过的 Codex 版本;其它地方出现的版本号只标注某种 wire 形态何时出现,代码一律按字段在不在判别,不按版本分支。

| 形态 | 触发 | 验证版本 |
|---|---|---|
| code mode + `functions` / `collaboration` namespace | 认识的模型名(`gpt-5.6-sol`) | 0.156.1(最近一次)、0.153.4 |
| code mode 扁平工具 | 同上,0.147 之前 | 0.144.4 / 0.146.0 |
| 顶层 `tools` fallback | 不认识的模型名(`gpt-5-codex` / `o3`) | 0.144.4 / 0.146.0 |

两种形态的差异与网关处理见 [PITFALLS「Codex code mode」](../../docs/PITFALLS.md);只支持 Responses 的原因见 PITFALLS「Codex 只说 Responses」。

## subagent

客户端须开 `agents.enabled = true`(harness 的 `entrypoint.sh` 不设);`gpt-5.6-sol` 的模型目录自带 `multi_agent_version="v2"`。网关侧实现点:

| 实现项 | 位置 |
|---|---|
| 请求侧展开 `collaboration`,记录 `名字 → namespace` | `converter.ts` `expandNamespaces` / `collectTools` |
| 只对展开的 namespace 工具剥 schema 私有关键字 `encrypted` | `converter.ts` `stripEncryptedKeyword` |
| 响应侧把 `namespace` 写回 `function_call`(流式 + 非流式) | `response-stream.ts` / `response-nonstream.ts` |
| 线程间信封 `agent_message`(`NEW_TASK` / `MESSAGE` / `FINAL_ANSWER`)转成 user 消息 | `converter.ts` `convertAgentMessage` |

### 复跑(零上游)

路由受理对照:`codex-subagent-probe-server.ts` 的四组 case 只差「请求侧是否展开」与「响应侧是否写回 `namespace`」,只有写回 `namespace` 的 `ns-only` / `ns-restore` 被客户端受理。

```sh
K2C_SUBAGENT_PORT=18961 K2C_SUBAGENT_TOOL=spawn_agent \
  pnpm --filter @kiro2claude/core exec tsx test/manual/codex-subagent-probe-server.ts
```

```sh
docker run --rm --entrypoint bash -e KIRO2CLAUDE_API_KEY=subagent-probe-key \
  kiro2claude-codex:<版本> -c 'mkdir -p ~/.codex && cat > ~/.codex/config.toml <<EOF
model = "gpt-5.6-sol"
model_provider = "kiro2claude"
sandbox_mode = "danger-full-access"
approval_policy = "never"
[agents]
enabled = true
[model_providers.kiro2claude]
name = "kiro2claude"
base_url = "http://host.docker.internal:18961/case/ns-restore/openai/v1"
env_key = "KIRO2CLAUDE_API_KEY"
wire_api = "responses"
EOF
codex exec --json --skip-git-repo-check "Spawn a subagent to say hello." < /dev/null'
```

`ns-restore` 换成 `no-expand` / `expand` / `ns-only` 即其余三组;`K2C_SUBAGENT_TOOL=exec` 是必跑的对照组(真的执行 `echo CONTROL_OK`),证明拒绝来自 router 而不是网关编码。探针只验证 router 是否受理调用,不模拟模型决策。

生命周期矩阵:`codex-subagent-lifecycle-server.ts`(`K2C_LIFECYCLE_PORT=18962`,客户端配置同上),场景清单与 nonce 配对判据见该文件头注释。

## 调试

```bash
./tools/codex/run.sh -t TOKEN --shell         # bash 进容器
cat ~/.codex/config.toml                       # 生成的配置
codex --version; cat /etc/codex-version        # 版本
# 容器内加 RUST_LOG=codex_core=debug 看 Codex 内部事件解析
```

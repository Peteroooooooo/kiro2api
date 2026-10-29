# kiro2api

把 Kiro 账号变成 Claude / OpenAI 格式的 API，可以同时挂多个账号轮流用，并且带一个网页管理后台。

> **说明**：本项目基于 [yupanzi/kiro2claude](https://github.com/yupanzi/kiro2claude)（MIT 协议）。请求转换、思考处理、计费统计等核心部分都来自原项目，我在它上面加了号池和网页后台，相当于给它做了一个前端。原项目的完整说明保留在 [docs/README.kiro2claude.md](docs/README.kiro2claude.md)。
>
> 非官方项目，和 AWS、Amazon、Anthropic、Kiro 都没有关系。仅供学习研究，使用第三方代理可能违反 Kiro 的服务条款，风险自负。

## 和原版 kiro2claude 有什么不同

| | kiro2claude | kiro2api |
|---|---|---|
| 账号数量 | 1 个（kiro-cli 登录后的 SQLite） | 多个，自动轮流使用 |
| 添加账号 | 命令行登录 | 网页上点按钮登录，或粘贴凭据 |
| 账号状态、额度 | 看日志 | 网页上一眼看到 |
| 某个账号被限流或额度用完 | 请求直接失败 | 自动换下一个账号重试 |
| 服务器架构 | 只有 x86 | x86 和 arm64 都能构建 |
| 模型列表 | 每个模型另有一个 `-thinking` 版本 | 和 Kiro 上游实际提供的模型一一对应 |

## 快速开始（Docker）

```bash
git clone https://github.com/Peteroooooooo/kiro2api.git
cd kiro2api
./scripts/docker-build.sh -t kiro2api        # 自动识别 x86 / arm64

mkdir -p data && sudo chown 1001:1001 data   # 容器里以 uid 1001 运行
docker run -d --name kiro2api --restart unless-stopped \
  -e KIRO2CLAUDE_HOST=0.0.0.0 \
  -e KIRO2CLAUDE_API_KEY=换成你的API密钥 \
  -e KIRO2CLAUDE_ADMIN_KEY=换成你的后台密码 \
  -e KIRO2CLAUDE_ACCOUNTS_FILE=/data/accounts.json \
  -v "$PWD/data:/data" \
  -p 8080:8080 \
  kiro2api
```

然后浏览器打开 `http://你的服务器:8080/admin`，输入后台密码。

两个密钥的区别：

- `KIRO2CLAUDE_API_KEY`：客户端（Claude Code、New API 等）调用接口时用的密钥。
- `KIRO2CLAUDE_ADMIN_KEY`：登录网页后台用的密码。设置了它才会开启号池和后台。

## 添加账号

在后台的「添加账号」里选一种：

1. **Builder ID 登录**：点「开始登录」，页面给出一个验证码和链接。用任何一台电脑的浏览器打开链接、登录并确认，账号就自动加进来了。帮朋友加账号时，把链接和验证码发给他就行。
2. **IAM Identity Center 登录**：学校或公司的账号，填管理员给的 Start URL 和 Region，其余同上。
3. **粘贴凭据**：粘贴 kiro.rs 的 `credentials.json`，或 kiro-cli / Kiro IDE 的 token 文件加注册文件，可以一次粘贴多个。

GitHub、Google 登录的账号不支持。

注意：同一份凭据只能放在一个服务里用。两个服务同时刷新同一个 token 时，其中一个会失效。

## 怎么接入

后台最上面的「接入信息」里可以直接复制地址和密钥。

- **Claude 格式**：`http://你的服务器:8080/claude`
- **OpenAI 格式**：`http://你的服务器:8080/openai/v1`

Claude Code 示例：

```bash
export ANTHROPIC_BASE_URL=http://你的服务器:8080/claude
export ANTHROPIC_AUTH_TOKEN=你的API密钥
claude
```

New API：新建一个「Anthropic Claude」类型的渠道，填上面的 Claude 格式地址和 API 密钥。

## 号池怎么分配请求

- **同一个会话固定用同一个账号。** Kiro 的缓存按账号分开，换账号会让缓存失效、多花额度。
- **新会话轮流分给最久没用过的账号。**
- **出错时自动换账号。** 被限流（429）就冷却一会儿；额度用完就冷却到额度重置那天；凭据被拒就冷却 10 分钟。这三种情况都会把当前请求换到下一个账号重发。
- **refresh token 失效**的账号会自动停用，提示你重新登录。

## 思考（thinking）怎么控制

思考在 Kiro 里是请求参数，不是单独的模型，所以模型列表里没有 `-thinking` 版本。规则很简单：

- **客户端没说**：能思考的模型就开着思考，强度用模型自己的默认档位。
- **客户端说了**：以客户端为准。比如 Claude Code 里调的思考强度会照样生效；Cherry Studio 这类客户端发的旧式思考预算（`budget_tokens`）会换算成对应的强度档位。
- **关不掉思考的模型**（Opus 5.5、Sonnet 5.5）：客户端要求关闭时，按最低强度 low 思考。
- 任何模型名后面加 `-thinking` 都能用（比如 `claude-sonnet-5-5-thinking`、`glm-5-thinking`），等同于不带后缀的名字，方便沿用老配置。

## 支持的模型

和 Kiro 上游（kiro-cli 身份）实际提供的模型一一对应。「思考」一栏中，「常开」表示关不掉，「可开可关」表示可以关闭，「无」表示网关不做思考控制、直接转发。

| 模型 | 上下文 | 思考 |
|---|---|---|
| `claude-opus-5-5` `claude-sonnet-5-5` | 1M | 常开 |
| `claude-haiku-5-5` `claude-opus-5` `claude-sonnet-5` `claude-opus-4-8` `claude-opus-4-7` `claude-opus-4-6` `claude-sonnet-4-6` | 1M | 可开可关 |
| `gpt-5.6-sol` `gpt-5.6-terra` `gpt-5.6-luna` | 922K | GPT 推理 |
| `auto` `kimi-k3` | 1M | 无 |
| `claude-opus-4-5` `claude-sonnet-4-5` `claude-haiku-4-5` `glm-5` | 200K | 无 |
| `qwen3-coder-next` | 256K | 无 |
| `minimax-m2.5` `minimax-m2.1` | 196K | 无 |
| `deepseek-3.2` | 164K | 无 |

## 常用环境变量

| 变量 | 作用 |
|---|---|
| `KIRO2CLAUDE_API_KEY` | 客户端调用接口用的密钥（必填） |
| `KIRO2CLAUDE_ADMIN_KEY` | 后台密码，设置后开启号池和 `/admin` 后台 |
| `KIRO2CLAUDE_ACCOUNTS_FILE` | 账号文件路径，默认是工作目录下的 `accounts.json` |
| `KIRO2CLAUDE_HOST` / `KIRO2CLAUDE_PORT` | 监听地址和端口，默认 `127.0.0.1:8080`，容器里要设成 `0.0.0.0` |

其余变量和原版 kiro2claude 一样，见 [.env.example](.env.example)。

`accounts.json` 里有账号凭据的明文，权限默认是 600，不要提交到代码仓库，也不要发给别人。

## 本地开发

```bash
pnpm install
pnpm --filter @kiro2claude/core run build
pnpm --filter @kiro2claude/core test
```

## 协议

MIT。原项目版权归 yupanzi，见 [LICENSE](LICENSE)。

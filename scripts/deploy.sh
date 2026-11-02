#!/usr/bin/env bash
#
# deploy.sh —— 在部署机上一键更新:拉 origin/main → 构建镜像 → 换容器(不健康自动回滚)。
#
# 用法(在部署机的仓库目录里):
#   bash scripts/deploy.sh                 # 拉最新 main 并部署
#   bash scripts/deploy.sh --no-pull       # 用当前工作区直接部署
#
# 换容器这一步交给部署机上的 SWAP_SCRIPT(默认 /opt/kiro2api/deploy-swap.sh):
# 它负责 compose up、健康检查与回滚,和具体机器的 compose 文件 / .env 绑定,所以不放进仓库。
# 部署机只需要 git + docker,不需要 node(版本号由 docker-build.sh 用 sed 读 fixture)。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SWAP_SCRIPT="${SWAP_SCRIPT:-/opt/kiro2api/deploy-swap.sh}"
PULL=true
[[ "${1:-}" == "--no-pull" ]] && PULL=false

cd "$PROJECT_ROOT"
if [[ "$PULL" == "true" ]]; then
  git fetch --quiet origin main
  git reset --hard origin/main
fi
SHA="$(git rev-parse --short HEAD)"
TAG="kiro2api:${SHA}"

echo "→ 构建 ${TAG}"
bash scripts/docker-build.sh --no-version-tag -t "$TAG"

echo "→ 切换容器(${SWAP_SCRIPT})"
if bash "$SWAP_SCRIPT" "$TAG"; then
  echo "✓ 已部署 ${SHA}"
else
  echo "✗ 新镜像不健康,已回滚;日志见 $(dirname "$SWAP_SCRIPT")/deploy-swap.log" >&2
  exit 1
fi

#!/bin/sh
# 玩客云一键升级：拉新镜像 → 重建容器 → 健康检查 → 失败自动回滚。
# 数据卷 ./data 不参与任何改动；旧镜像 ID 记在 .previous-image-id 供 rollback.sh 使用。
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"
[ -f .env ] && . ./.env
IMAGE=${IMAGE:-ghcr.io/lztxi/hongguoguo:latest}
HEALTH=${HEALTH:-http://127.0.0.1:9636/api/health}
export IMAGE

echo "==> 升级目标：$IMAGE"

STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
cp docker-compose.yml "backups/docker-compose.$STAMP.yml" 2>/dev/null || true

OLD=$(docker inspect --format '{{.Id}}' hongguo-web 2>/dev/null || true)
if [ -n "$OLD" ]; then
  printf '%s\n' "$OLD" > .previous-image-id
  echo "==> 已记录当前镜像 ${OLD}（可回滚）"
fi

if ! docker compose pull; then
  echo "!! 拉取失败，保持现状" >&2
  exit 1
fi

if ! docker compose up -d; then
  echo "!! 启动失败，尝试回滚" >&2
  sh ./rollback.sh || true
  exit 1
fi

OK=0
i=0
BODY=''
while [ "$i" -lt 30 ]; do
  BODY=$(curl -fsS --max-time 3 "$HEALTH" 2>/dev/null || true)
  case "$BODY" in
    *'"ok":true'*'"hgop":true'*) OK=1; break ;;
  esac
  i=$((i + 1))
  sleep 2
done

if [ "$OK" -ne 1 ]; then
  echo "!! 健康检查未通过，尝试回滚" >&2
  sh ./rollback.sh || true
  exit 1
fi

echo "==> 升级成功（${STAMP}）"
printf '%s\n' "$BODY" | head -c 800
printf '\n'
printf '%s  %s  %s\n' "$STAMP" "$IMAGE" "${OLD:-none}" >> upgrade.log

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

# 必须是镜像 ID(.Image)，不是容器 ID(.Id)，否则 rollback.sh 会找不到镜像
OLD=$(docker inspect --format '{{.Image}}' hongguo-web 2>/dev/null || true)
if [ -n "$OLD" ]; then
  printf '%s\n' "$OLD" > .previous-image-id
  echo "==> 已记录回滚点镜像 ${OLD}（可回滚）"
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
# 直接回显镜像里锁定的上游版本：镜像更新只拉「已构建好的产物」，
# 上游源码版本由自动构建库的 upstream.lock.json 决定，合并升级 PR 后重新出镜像才会变。
UP_J=$(printf '%s' "$BODY" | tr -d '\n' | sed -n 's/.*"jackotom":{[^}]*"tag":"\([^"]*\)".*/\1/p' || true)
UP_Z=$(printf '%s' "$BODY" | tr -d '\n' | sed -n 's/.*"zfdang":{[^}]*"tag":"\([^"]*\)".*/\1/p' || true)
echo "==> 应用上游：${UP_J:-未知} / 播放内核：${UP_Z:-未知}"
echo "==> 提示：单独执行本脚本不会升级上游源码，需在自动构建库合并上游升级 PR。"
printf '%s  %s  %s  %s/%s\n' "$STAMP" "$IMAGE" "${OLD:-none}" "${UP_J:-?}" "${UP_Z:-?}" >> upgrade.log

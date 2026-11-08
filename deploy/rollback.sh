#!/bin/sh
# 回滚到 upgrade.sh 记录的上一版镜像（数据卷 ./data 不动）。
# 做法：给旧镜像打个本地 tag，用该 tag 强制重建容器，明确禁止拉取，
# 不覆盖 GHCR 的 latest 标签，避免之后误把旧版当成远端最新版。
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"
HEALTH=${HEALTH:-http://127.0.0.1:9636/api/health}

OLD=$(cat .previous-image-id 2>/dev/null || true)
if [ -z "$OLD" ]; then
  echo "!! 没有 .previous-image-id，无法回滚" >&2
  exit 1
fi
if ! docker image inspect "$OLD" >/dev/null 2>&1; then
  echo "!! 旧镜像 $OLD 已被删除，无法回滚" >&2
  exit 1
fi

TAG="hongguo-web:rollback-$(date +%Y%m%d-%H%M%S)"
docker tag "$OLD" "$TAG"
echo "==> 回滚到 $TAG（$OLD）"
# shell 传入的 IMAGE 优先级高于 .env
IMAGE="$TAG" docker compose up -d --force-recreate --pull never

i=0
while [ "$i" -lt 20 ]; do
  BODY=$(curl -fsS --max-time 3 "$HEALTH" 2>/dev/null || true)
  case "$BODY" in
    *'"ok":true'*) echo "==> 回滚完成"; printf '%s\n' "$BODY" | head -c 500; printf '\n'; exit 0 ;;
  esac
  i=$((i + 1))
  sleep 2
done
echo "!! 回滚后健康检查仍未通过，请查看 docker logs hongguo-web" >&2
exit 1

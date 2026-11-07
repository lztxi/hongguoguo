#!/bin/sh
# 回滚到 upgrade.sh 记录的上一版镜像。
# 做法：给旧镜像重新打上 compose 使用的 tag，再强制重建容器（禁止拉取）。
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"
[ -f .env ] && . ./.env
IMAGE=${IMAGE:-ghcr.io/lztxi/hongguoguo:latest}
export IMAGE

OLD=$(cat .previous-image-id 2>/dev/null || true)
if [ -z "$OLD" ]; then
  echo "!! 没有 .previous-image-id，无法回滚" >&2
  exit 1
fi
if ! docker image inspect "$OLD" >/dev/null 2>&1; then
  echo "!! 旧镜像 $OLD 已被删除，无法回滚" >&2
  exit 1
fi

echo "==> 回滚到 $OLD"
docker tag "$OLD" "$IMAGE"
docker compose up -d --force-recreate --pull never

i=0
while [ "$i" -lt 20 ]; do
  BODY=$(curl -fsS --max-time 3 "${HEALTH:-http://127.0.0.1:9636/api/health}" 2>/dev/null || true)
  case "$BODY" in
    *'"ok":true'*) echo "==> 回滚完成"; printf '%s\n' "$BODY" | head -c 500; printf '\n'; exit 0 ;;
  esac
  i=$((i + 1))
  sleep 2
done
echo "!! 回滚后健康检查仍未通过，请查看 docker logs hongguo-web" >&2
exit 1

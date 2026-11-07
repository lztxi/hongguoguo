#!/bin/sh
# 首次在玩客云部署（或换一台机器）。已运行旧版本请直接用 upgrade.sh。
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> 已生成 .env（默认镜像 ghcr.io/lztxi/hongguoguo:latest）"
fi
. ./.env
IMAGE=${IMAGE:-ghcr.io/lztxi/hongguoguo:latest}
export IMAGE

case "$IMAGE" in
  *OWNER*) echo "!! 请先修改 .env 里的 IMAGE，把 OWNER 换成实际用户名" >&2; exit 1 ;;
esac

mkdir -p data backups
echo "==> 拉取 $IMAGE"
docker compose pull
echo "==> 启动"
docker compose up -d

HEALTH=${HEALTH:-http://127.0.0.1:9636/api/health}
i=0
while [ "$i" -lt 30 ]; do
  BODY=$(curl -fsS --max-time 3 "$HEALTH" 2>/dev/null || true)
  case "$BODY" in
    *'"ok":true'*) echo "==> 部署完成：http://<玩客云IP>:9636"; printf '%s\n' "$BODY" | head -c 800; printf '\n'; exit 0 ;;
  esac
  i=$((i + 1))
  sleep 2
done
echo "!! 健康检查未通过，请查看 docker logs hongguo-web" >&2
exit 1

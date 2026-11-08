#!/bin/sh
# 每周低峰维护：只在确实无人使用时重启容器，回收长期运行累积的 V8 堆。
# 活跃保护：正在播放 / 有页面打开 / 10 分钟内有人操作，一律跳过本次重启。
# 注册方式（避开青龙 23 */3 * * * 的任务点）：
#   37 4 * * 1 /root/hongguo-web/maintain.sh >> /root/hongguo-web/maintain.log 2>&1
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"
# 允许调用方用 HEALTH=... 临时覆盖（演练 / 排错），优先级高于 .env
HEALTH_ARG=${HEALTH:-}
if [ -f .env ]; then . ./.env; fi
HEALTH=${HEALTH_ARG:-${HEALTH:-http://127.0.0.1:9636/api/health}}

echo "[$(date '+%Y-%m-%d %H:%M:%S')] === 每周维护开始 ==="
BODY=$(curl -fsS --max-time 8 "$HEALTH" 2>/dev/null || true)
if [ -z "$BODY" ]; then
  echo "健康检查无响应，跳过重启（不把已有故障放大）"
  exit 0
fi

# 解析 /api/health，任一活跃信号存在就跳过。解析失败也保守跳过。
DECISION=$(printf '%s' "$BODY" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("SKIP health 解析失败"); raise SystemExit
s = d.get("hgopStats") or {}
i = d.get("idle") or {}
active = int(s.get("activeStreams") or 0)
sse = int(d.get("sseClients") or 0)
idle = int(i.get("idleSeconds") or 0)
if active > 0:
    print("SKIP 正在播放 (activeStreams=%d)" % active)
elif idle < 600:
    print("SKIP 10 分钟内有人使用 (idle=%ds)" % idle)
elif sse > 0 and idle < 1800:
    print("SKIP 有页面打开且仅空闲 %ds（需满 30 分钟）" % idle)
else:
    # 后台标签页不算「正在使用」：浏览器 EventSource 会在 3s 后自动重连，
    # 凌晨重启后被断开的只是空闲连接。若一律因 sse>0 跳过，
    # 常年开着标签页的部署会让每周维护永远不执行。
    print("OK 已空闲 %ds (sse=%d, SSE 自动重连)，可以重启" % (idle, sse))
' 2>/dev/null || echo "SKIP python3 不可用或解析失败")

echo "$DECISION"
case "$DECISION" in
  OK*) ;;
  *) echo "保持运行，本次不重启"; exit 0 ;;
esac

# DRY_RUN=1 ./maintain.sh 只演练判定，不真的重启，方便部署后冒烟验证。
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN=1：判定通过，仅演练，不执行重启"
  exit 0
fi

echo "==> docker compose restart hongguo-web"
docker compose restart hongguo-web

OK=0
n=0
while [ "$n" -lt 20 ]; do
  BODY=$(curl -fsS --max-time 3 "$HEALTH" 2>/dev/null || true)
  case "$BODY" in
    *'"ok":true'*) OK=1; break ;;
  esac
  n=$((n + 1))
  sleep 1
done

if [ "$OK" -eq 1 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 维护完成，服务健康"
else
  echo "!! 重启后健康检查未通过，请查看 docker logs hongguo-web" >&2
  exit 1
fi

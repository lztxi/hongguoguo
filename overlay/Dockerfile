# 红果短剧桌面版 -> headless Web 版（armv7 / 玩客云）
# 上游源码不改：Electron 由 shim 模拟，主进程原样加载。
# node:20-alpine 已核实 manifest 含 linux/arm/v7；Node 20 具备本项目用到的全部运行时 API
# （fetch / structuredClone / Readable.toWeb / AbortSignal.timeout）。
FROM node:20-alpine

RUN apk add --no-cache ca-certificates tzdata ffmpeg \
 && mkdir -p /app/data /app/data/downloads

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PORT=9636 \
    HONGGUO_DATA_DIR=/app/data \
    HONGGUO_APP_DIR=/app \
    NODE_OPTIONS=--max-old-space-size=192 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app

# 只装运行时依赖；--ignore-scripts 阻止任何 Electron 二进制下载
COPY app/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
      --registry=https://registry.npmmirror.com \
 && npm cache clean --force

# 上游主进程 / 业务模块 / 前端产物（dist-react 已含浏览器桥接）
COPY app/ ./
COPY shim/ ./shim/
COPY server/ ./server/
# 整合播放内核：zfdang/hongguo-open-player 服务端流式解密模块（AGPL-3.0，保留原许可头）
COPY hgop/ ./hgop/
# sync.mjs 生成的上游版本/源码地址，供 /api/health 报告（AGPL 第 13 条可追溯性）
COPY BUILD-INFO.json ./BUILD-INFO.json

EXPOSE 9636

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||9636)+'/api/health',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "/app/server/index.js"]

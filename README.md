# hongguoguo

把两个上游项目**自动合并**成一份可在玩客云（armv7）一键运行的 Docker 镜像：

| 上游 | 许可证 | 提供 |
|---|---|---|
| [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) | GPL-3.0 | Electron 主进程、`preload.js`、React 前端 |
| [zfdang/hongguo-open-player](https://github.com/zfdang/hongguo-open-player) | **AGPL-3.0** | 服务端 CENC-MP4 流式解密播放内核 |

Web 化改造层（Electron shim / HTTP+SSE 服务 / 浏览器桥接 / 内存优化）全部放在 `overlay/`，
**不修改任何上游源码**（唯一例外是 `overlay/hgop/patches.json` 里带锚点校验的两处内存适配）。

> ⚠️ 因为对外提供网络服务且包含 AGPL-3.0 代码，按 §13 必须公开完整对应源码 ——
> 这个仓库本身就是合规交付物。部署时请把 `SOURCE_URL` 指向你的仓库，
> `/api/health` 会返回 `build` 字段标明上游版本与源码地址。许可证见 [NOTICE](NOTICE)。

## 它解决什么问题

上游每天发好几个版本，手工升级最怕的是「一覆盖就把定制补丁冲掉」。这里的做法是：

```
upstream.lock.json  ──锁定──>  两个上游的 tag + commit sha
        │
        ├─ check-upstream.yml  每 3 天 + 每次 push 查最新发行版 → 自动开 PR（只改 lock）
        │
        ├─ verify.yml         PR 里重新拉源码 + 叠加 overlay + 重放补丁 + 构建前端
        │                     └─ 补丁锚点被上游改动 / preload 结构变化 → 直接失败，不静默合并
        │
        ├─ build-image.yml    合并到 main → QEMU 构建 linux/arm/v7 镜像 → 推 GHCR
        │
        └─ deploy/upgrade.sh  玩客云 pull → 重建 → 健康检查 → 失败自动回滚
```

**升级时所有定制优化都会保留**，因为它们是独立叠加的：

- `overlay/shim/electron.js`、`overlay/server/index.js` —— 独立文件，永不与上游冲突；
- `overlay/web/gen-bridge.mjs` —— 每次构建都从**新版** `preload.js` 重新生成 `bridge.js`，
  上游新增/改名 IPC 方法会自动跟上（方法数异常下降会触发断言）；
- `app/dist-react/index.html` 的脚本注入也是每次构建重新做的，不是改过的静态文件；
- `overlay/web/sidebar-collapse.js`、`overlay/web/version-badge.js` —— 独立运行时增强层，
  每次构建随兼容脚本一起注入（版本角标显示上游版本，并在取源故障时提示自动重试状态）；
- `hgop/` 源文件每次从上游重新拉取，只重放 `patches.json` 的两处补丁；
  上游若改动被锚定的代码，同步脚本**报错停止**，提示人工合并，绝不覆盖。

## 目录

```
upstream.lock.json          当前镜像基于的上游版本（唯一需要随升级变动的文件）
overlay/                    全部定制层：shim / server / web / Dockerfile / compose / hgop 补丁
scripts/check-upstream.mjs  查最新发行版、生成 PR 正文、更新 lock
scripts/sync.mjs            拉两个上游 → 叠加 overlay → 重放补丁 → 构建前端 → 产出 build/
scripts/verify.mjs          校验版本、补丁、桥接、语法、前端产物
scripts/unzip.py            跨平台解压 codeload 归档
.github/workflows/          check-upstream / verify / build-image
deploy/                     玩客云侧 compose + install / upgrade / rollback
```

## Web 版增强：侧边栏收起

`overlay/web/sidebar-collapse.js` 是纯运行时增强层（DOM + CSS 注入，**不改任何上游源码**）：

- 侧栏底部有「收起 / 展开」按钮和「A」自动开关；
- **自动模式（默认）**：窗口宽度 < 1200px 或进入播放页时自动收起，离开后自动展开；
- **手动模式**：点收起按钮即锁定为手动，刷新后仍保持；再点「A」回到自动；
- 快捷键 `Alt+S` 快速切换；收起后侧栏 62px 只剩居中图标，鼠标悬停显示名称；
- 偏好存 `localStorage['hongguo:sidebar-mode']`（`auto` / `expanded` / `collapsed`），多标签页同步。

由 `build-frontend.mjs` 每次构建注入 `index.html`，升级上游不会丢。

## 首次使用

### 1. GitHub 仓库设置（代码已推送）

仓库：<https://github.com/lztxi/hongguoguo>（public，AGPL-3.0，默认分支 `main`）。

```bash
git clone https://github.com/lztxi/hongguoguo.git
cd hongguoguo
```

仓库设置：
- **Settings → Actions → General → Workflow permissions**：勾选 `Read and write permissions`
  （`check-upstream.yml` 要开 PR，`build-image.yml` 要推 GHCR）；
- 同一页面还要勾选 **Allow GitHub Actions to create and approve pull requests** ——
  这个开关默认关闭，是「检测成功但自动开 PR 失败」最常见的原因；
- 首次 `build-image` 跑完后，把 `hongguoguo` 包的可见性改成 **Public**，
  玩客云才能匿名 `docker pull`；
- 想手动重建镜像：Actions → `build-image` → Run workflow（push 到 main 也会自动触发）。

### 2. 玩客云部署

把 `deploy/` 整个目录拷到玩客云 `/root/hongguo-web-deploy`：

```sh
cd /root/hongguo-web-deploy
cp .env.example .env
vi .env                 # IMAGE=ghcr.io/lztxi/hongguoguo:latest
chmod +x *.sh
sh ./install.sh
```

**从旧的本地编译版本迁移**：旧目录 `/root/hongguo-web` 的 `data/` 里是观看记录、
下载任务和已下载视频。把它整体拷到新目录的 `data/`，再停掉旧容器，避免端口冲突：

```sh
cp -a /root/hongguo-web/data/. /root/hongguo-web-deploy/data/
docker stop hongguo-web && docker rm hongguo-web
sh ./install.sh
```

### 3. 以后升级

完全自动到你点「Merge」为止：上游发新版 → 机器人开 PR → 看 PR 里的变更文件和
verify 结果 → 合并 → 等镜像构建完 → 玩客云执行：

```sh
cd /root/hongguo-web-deploy && sh ./upgrade.sh
```

出问题时 `sh ./rollback.sh` 回到上一版镜像。`upgrade.sh` 会在健康检查失败时自动回滚。

> **镜像更新 ≠ 上游升级**：`update.sh` / `upgrade.sh` 只拉取「已经构建好」的 GHCR 镜像。
> 镜像里打包的上游源码版本由 `upstream.lock.json` 锁定，只有合并上游升级 PR、
> 重新跑完 `build-image` 之后才会变。所以可能出现「镜像刚更新、版本号却没变」——
> 这是预期行为，不是漏更新。升级脚本现在会直接回显镜像里的上游版本；
> 网页左下角的版本角标（点开看详情）也能随时确认。
>
> 当前玩客云实际部署目录是 `/root/hongguo-web`（已改成纯镜像 compose，不再本机编译），
> 日常用 `cd /root/hongguo-web && ./update.sh`，回滚用 `./rollback.sh`；
> 上面 `deploy/` 的用法适用于全新机器从零部署。

### 版本基线

`upstream.lock.json` 当前锁定 **jackotom v6.4 + zfdang v1.11.1**（2026-11-09 升级）。
这次跨越较大：6.2→6.4 有 153 个文件变更（`main.js` / `preload.js` 新增 interface-language
IPC、`Player.jsx`、`bytevc2.js`），v1.7.2→v1.11.0 有 35 个（`streamService.js` 新增
bytevc2 渐进式、并发分片、fragmentCache 等）；v1.11.1 只改了 2 个 CI 配置，内核代码零改动。
已用 `scripts/sync.mjs` + `verify.mjs` 完整验证：两处内存补丁锚点仍精确命中、
桥接自动生成 112 个 invoke、77 项校验全通过；并在玩客云用真实 vid 做过字节级对照
（三种 Range 的 md5 与升级前完全一致）。新版 `fragmentCache` 等额外缓存已纳入
空闲降级清理，避免 256MB 容器长期挂着旧数据。

想临时改用别的版本：编辑 `upstream.lock.json` 的 `tag` / `sha` 后推送即可。
`sha` 只用于构建信息追溯，实际下载用 tag；可用
`git ls-remote https://github.com/jackotom/hongguo-drama refs/tags/v6.4` 查询。

上游检测走两条路，避免「上游一天连发几版、定时还没轮到」导致版本号长期落后：

1. `.github/workflows/check-upstream.yml` 的 `cron`，**默认每 3 天一次**
   （`17 0 */3 * *`，UTC 00:17 = 北京 08:17）；
2. **每次 push 到 main 也顺带检查一次**（只改 lock 的 PR 合并不重复触发）。

另外 `build-image` 出镜像时会再比对一次上游最新版，若 lock 已落后会在构建摘要里
给出醒目警告。注意 GitHub cron 的 `*/3` 是「每月 1/4/7/… 号」的日历语义，跨月会重置；
GitHub 也会停用连续 60 天无任何仓库活动的 scheduled workflow，上游长期不发版时
偶尔手动 Run workflow 一次即可。

## 连播预热（换集秒开）

播放 `GET /hgop/stream/:vid` 时，浏览器桥接会在地址上附带后续 3 集 vid
（`next_vid` + `next_vids`），服务端据此**串行**预构建这几集的 CENC 分片计划：

- 实测冷启动（未预热）响应头 **2.098s**，命中预热只要 **0.074s**；
- 旧实现只预热 1 集，且正在预热时后一个请求被直接丢弃，连播到第 3 集必然卡；
  现在改成 FIFO 队列，同一时刻仍只构建 1 个（armv7 内存考虑），但不再丢；
- 播放计划 TTL 从上游的 90s 放宽到 **10 分钟**（线上 5 个计划约 3.2MB，
  上限 12MB，内存几乎不变），避免「一集没看完，预热就过期了」；
- 首个预热任务把后续 vid 一起传给 App 接口批量取址，后续计划构建明显更快。

> 注意：上面省掉的只是「点击 → 响应头」。浏览器真正能出画面，还要等服务端
> 向上游拉 mdat 前几个 512KB 分片并纯 JS 解密 CENC —— 这段在 armv7 上才是大头。
> 只做计划缓存时体感提升有限，下一节专门解决它。

## 首片预缓冲与预热避让

- **首片预缓冲**：预热计划建好后，再把该集开头 **1MB 已解密**数据放进内存
  （包装 `plan.read`：命中时先吐内存前缀，剩余区间仍走流式解密，Range /
  Content-Length / seek 语义完全不变）。切集瞬间浏览器就能拿到起播所需数据。
- **预热避让**：旧实现固定开播后 800ms 启动预热，正好和当前集首片缓冲抢 CPU
  与带宽。现在等「已推送 512KB 且开播满 2 秒」后才启动（8 秒兜底）。
- 每个预热任务都带上剩余 vid 供批量取址；任务间留 250ms 空隙，避免连续占满 CPU。
- 预缓冲总量封顶 4MB、与播放计划同为 10 分钟 TTL，空闲降级和缓存管家会一并清理。

玩客云同环境 A/B（`Range: bytes=0-2097151`，1080p 真实 vid，md5 三方一致）：

| 场景 | 首包 | 收到 256KB | 收到 1MB | 总耗时 |
|---|---|---|---|---|
| 旧镜像 | 0.215s | 0.347s | 0.484s | 0.752s |
| 新代码·预缓冲关 | 0.036s | 0.185s | 0.364s | 0.647s |
| **新代码·预缓冲开** | **0.016s** | **0.023s** | **0.054s** | **0.387s** |

可在 `deploy/.env` 调整，改完 `docker compose up -d` 生效：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HONGGUO_HGOP_WARM_DEPTH` | `3` | 每集提前预热几集；`1` = 旧行为，`0` = 完全禁用 |
| `HONGGUO_HGOP_PLAN_TTL_MIN` | `10` | 播放计划存活分钟数（2~60） |
| `HONGGUO_HGOP_PREBUF_MB` | `1` | 每集首片预缓冲大小；`0` = 禁用 |
| `HONGGUO_HGOP_PREBUF_LIMIT_MB` | `4` | 预缓冲总上限（1~12） |
| `HONGGUO_HGOP_WARM_DELAY_MS` | `2000` | 预热至少等开播多久；`0` = 立刻预热 |
| `HONGGUO_HGOP_WARM_TRIGGER_KB` | `512` | 预热前至少已推送多少 KB |

`/api/health` 的 `hgopStats` 会报告 `warmQueue` / `planTtlMinutes` / `warmDepth`
以及 `prebuf`（entries / mb / filled / hits / failures），方便确认有没有命中。

## 上游取源故障容错（熔断 + 自动重试）

2026-11-10 红果官方短暂收紧校验，取址接口返回 `HTTP 200 + content-length: 0`，
上游两个项目（jackotom #130 / zfdang #87）同时报障，约一小时后自行恢复。
这类故障不是部署问题，但旧行为有两个副作用：预热队列每 250ms 就重新注册设备取址、
几十次无效请求可能让本机被风控盯得更久；`<video>` 一收到 500 就锁死，官方恢复后
还得手动刷新页面。因此加了三层纯 overlay 保护（上游复制源码零改动）：

1. **错误分类**：把 `EMPTY_RESPONSE` / 签名鉴权 / 取源超时 / 业务拒绝 / 片源解析失败
   判为「红果上游坏了」；把 CDN 不支持 Range、客户端切集断连（`AbortError`）、
   ByteVC2 不支持等排除；其余判为「本机服务异常」。
2. **播放自动重试**：所有取址都经过 overlay 包装的 `getStreamingPlan`，失败时在
   响应头写出之前按 1.2s / 2.4s / 4.8s 退避重试最多 2 次（单次总时限 20s）。
   浏览器只是在「加载中」多等几秒，官方一恢复就能直接出画面，**不需要刷新**。
3. **预热熔断**：连续 3 次失败即暂停整条预热队列并清空积压任务，按
   30s → 60s → 120s → 300s 指数退避；播放请求不受限（用户点播本身就是一次
   低成本恢复探测），**一次播放成功立即解封并清零**，解封前不主动打接口。

`/api/health` 新增 `upstream` 字段，一眼分清是谁坏了：

```json
{
  "guard": "on", "state": "cooldown", "blame": "upstream", "ok": false,
  "hint": "红果接口暂时不可用：已暂停预热，播放会自动重试，恢复后自动解封",
  "failures": 3, "trips": 1, "retries": 4, "warmSuppressed": 6,
  "cooldownRemainingSec": 24, "lastFailure": { "code": "EMPTY_RESPONSE", "purpose": "warm" }
}
```

`state` 取 `ok` / `degraded` / `cooldown` / `local-error`，`blame` 取
`none` / `upstream` / `us`。网页左下角版本角标每 30s 读一次（心跳类请求，
不阻止空闲降级）：故障时变橙色提示「红果接口繁忙 · 自动重试中」，恢复后自动还原
版本号；切回标签页时立即刷新。

可在 `deploy/.env` 调整，改完 `docker compose up -d` 生效：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HONGGUO_UPSTREAM_GUARD` | `1` | `0` = 完全禁用容错（保留观测字段） |
| `HONGGUO_UPSTREAM_FAIL_THRESHOLD` | `3` | 连续失败几次触发熔断（2~10） |
| `HONGGUO_UPSTREAM_RETRY_MAX` | `2` | 单次播放自动重试次数（0~4） |
| `HONGGUO_UPSTREAM_RETRY_BASE_MS` | `1200` | 重试基础间隔，逐次翻倍，封顶 8s |
| `HONGGUO_UPSTREAM_RETRY_DEADLINE_MS` | `20000` | 单次重试总时限 |
| `HONGGUO_UPSTREAM_COOLDOWN_MS` | `30000` | 熔断初始退避 |
| `HONGGUO_UPSTREAM_COOLDOWN_MAX_MS` | `300000` | 退避封顶 |

> 边界：只覆盖「取址/建计划阶段」的失败，此时响应头还没写出，浏览器无感；
> 已开始推流后的断连仍按原有逻辑处理。若官方故障持续超过单次重试时限，
> 播放器会报错，此时看角标确认原因，恢复后点一下播放即可（不必刷新）。

## 空闲降级与每周维护（低配设备）

服务常驻在 988MB 内存的 armv7 玩客云上，长时间无人使用时会自动进入低功耗状态：

- **判定**：`/api/health`（Docker 每 60s 的健康检查）与 `/api/events`（SSE 长连接 +
  20s ping）不算「使用」；正在播放 / 预热 / 分片进行中一律不降级，避免看到一半卡住。
- **动作**：无业务请求达到阈值后清空 hgop 分片计划与 LRU 缓存、连做两次 full GC，
  把播放期间 axios 分配的 ArrayBuffer 尽量还给系统。**不关服务、不断连接**，
  任何业务请求到达即无感唤醒；代价是唤醒后首播要重建一次分片计划（约 1~2s）。
- **默认 30 分钟**，由 `deploy/.env.example` 的 `IDLE_SLEEP_MINUTES` 调整，
  `IDLE_SLEEP=0` 可一键禁用。状态可在 `/api/health` 的 `idle` 字段查看
  （`sleeping` / `idleSeconds` / `sleepCount` / `rssAfterSleepMB`）。
- 顺带修掉一个老问题：兜底 GC 的门槛原为 80MB，而 armv7 常态 RSS 只有 45~56MB，
  导致 `gc.count` 长期为 0、兜底形同虚设；已下调到 40MB。

`deploy/maintain.sh` 是每周低峰重启（回收长期堆增长），带活跃保护：正在播放、
10 分钟内有人操作、有页面打开但空闲不足 30 分钟都会跳过；健康检查失败也不重启。
后台标签页空闲满 30 分钟后允许重启（浏览器 SSE 会 3s 自动重连），
避免「常年开着标签页 → 每周维护永远不执行」。用 `DRY_RUN=1 ./maintain.sh` 可只演练判定。
注册方式：

```sh
chmod +x /root/hongguo-web/maintain.sh
# crontab -e 追加，周一 04:37 避开青龙 23 */3 * * * 的任务点
37 4 * * 1 /root/hongguo-web/maintain.sh >> /root/hongguo-web/maintain.log 2>&1
```

> 深度休眠（`docker stop` + 常驻门卫按需唤醒，可把内存降到 0）方案已实测可行，
> 但需要门卫接管 SSE 心跳、改端口映射，且首次唤醒 4~5s，**当前未启用**。

## 本地复现构建（不推镜像）

```bash
node scripts/sync.mjs        # 产出 build/，可直接 docker build
node scripts/verify.mjs
docker build -t hongguo-web:local ./build
```

离线/快速校验（复用已有前端产物，跳过 npm install + vite）：

```bash
SKIP_FRONTEND=1 node scripts/sync.mjs && SKIP_FRONTEND=1 node scripts/verify.mjs
DIST_REACT_FROM=/path/to/hongguo-web/app/dist-react node scripts/sync.mjs
```

其它环境变量见 `scripts/sync.mjs` 文件头。

## 关键兼容点

- `preload.js` 是桥接的唯一真相来源；`gen-bridge.mjs` 内置断言
  （invoke ≥ 80、事件 ≥ 15），上游删方法或改缩进会立刻报错；
- `watchPaths` 列出我们真正关心的上游文件，PR 正文会标注它们是否变化；
- `main.js` 由 shim 原样加载，若上游用了新的 Electron API，shim 的 no-op Proxy
  会静默吞掉 —— CI 的 verify 不做运行时验证，**合并前建议用真实浏览器点一次播放**
  （项目里已有 CDP 验证脚本的实践：全新 Edge 会话、剧卡 → 立即播放 → 下一集）；
- 上游 `package.json` 声明 `engines: node >=22.12`，但当前 `node:20-alpine` 实测可运行。
  若某版上游开始用 Node 22 专有 API，把 `overlay/Dockerfile` 的 `FROM` 改成
  `node:22-alpine` 并重新验证即可（该镜像同样有 `linux/arm/v7` manifest）。

## 许可证

整体按 **AGPL-3.0** 分发（见 [LICENSE](LICENSE)）。两个上游的来源、各自许可证、
本工程的修改清单与 AGPL §13 义务说明见 [NOTICE](NOTICE)。请勿移除上游文件自带的
SPDX 头与 `build/hgop/LICENSE`。

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
        ├─ check-upstream.yml  每 3 天查最新发行版 → 自动开 PR（只改 lock 文件）
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
- `overlay/web/sidebar-collapse.js` —— 独立运行时增强层，每次构建随兼容脚本一起注入；
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

> 当前玩客云实际部署目录是 `/root/hongguo-web`（已改成纯镜像 compose，不再本机编译），
> 日常用 `cd /root/hongguo-web && ./update.sh`，回滚用 `./rollback.sh`；
> 上面 `deploy/` 的用法适用于全新机器从零部署。

### 版本基线

`upstream.lock.json` 当前锁定 **jackotom v6.2 + zfdang v1.7.2**。6.2 相对 6.1 只改了
观看记录续作判断、切集画面交接、转码排队回调与版本号；v1.7.2 相对 1.7.1 只有
README 与一篇架构文档，**播放内核代码零改动**。已用 `scripts/sync.mjs` + `verify.mjs`
完整验证：补丁重放成功、桥接仍生成 111 个 invoke、49 项校验全通过。

玩客云 9636 自 2026-11-08 起已运行基于 6.2 的 GHCR 镜像，升级只需 `./update.sh`。

想临时改用别的版本：编辑 `upstream.lock.json` 的 `tag` / `sha` 后推送即可。
`sha` 只用于构建信息追溯，实际下载用 tag；可用
`git ls-remote https://github.com/jackotom/hongguo-drama refs/tags/v6.2` 查询。

定时检查在 `.github/workflows/check-upstream.yml` 的 `cron`，**默认每 3 天一次**
（`17 0 */3 * *`，UTC 00:17 = 北京 08:17）。注意 GitHub cron 的 `*/3` 是「每月
1/4/7/… 号」的日历语义，跨月会重置；另外 GitHub 会停用连续 60 天无任何仓库活动的
scheduled workflow，上游长期不发版时偶尔手动 Run workflow 一次即可。

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

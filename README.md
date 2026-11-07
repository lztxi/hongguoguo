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
        ├─ check-upstream.yml  每 6h 查最新发行版 → 自动开 PR（只改 lock 文件）
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
- 首次 `build-image` 跑完后，把 `hongguoguo` 包的可见性改成 **Public**，
  玩客云才能匿名 `docker pull`；
- 想立刻出第一版镜像：Actions → `build-image` → Run workflow。

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

### 版本基线

`upstream.lock.json` 当前锁定 **jackotom v6.2 + zfdang v1.7.1**。6.2 相对 6.1 只改了
观看记录续作判断、切集画面交接、转码排队回调与版本号，没有新增依赖、没有新增
Electron API、`preload.js` 只改注释 —— 已用 `scripts/sync.mjs` + `verify.mjs`
完整验证：补丁重放成功、桥接仍生成 111 个 invoke、36 项校验全通过。

玩客云**线上仍是 6.1**，首次执行 `deploy/upgrade.sh` 拉到的就是 6.2 镜像，
相当于顺带完成这次升级。之后上游再发新版，才由机器人自动开 PR。

想临时改用别的版本：编辑 `upstream.lock.json` 的 `tag` / `sha` 后推送即可。
`sha` 只用于构建信息追溯，实际下载用 tag；可用
`git ls-remote https://github.com/jackotom/hongguo-drama refs/tags/v6.2` 查询。
定时检查频率在 `.github/workflows/check-upstream.yml` 的 `cron`（默认每 6 小时）修改。

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

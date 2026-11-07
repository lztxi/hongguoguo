## 上游更新待合并

检测时间：2026-11-07T13:41:09.722Z

### jackotom/hongguo-drama：`v6.2` → `v6.2`
- commit: `affc81c7f885`，发布 2026-11-07T11:17:12Z
- 发行页：https://github.com/jackotom/hongguo-drama/releases/tag/v6.2

### zfdang/hongguo-open-player：`v1.7.1` → `v1.7.1`
- commit: `2e6bf2bb61ed`，发布 2026-11-07T09:37:39Z
- 发行页：https://github.com/zfdang/hongguo-open-player/releases/tag/v1.7.1

### 合并后会自动发生什么

1. `verify` 工作流重新拉取两份上游源码、叠加 `overlay/`、重放 hgop 锚点补丁并构建前端；
2. 补丁锚点若被上游改动会**直接失败**，不会静默覆盖，需人工调整 `overlay/hgop/patches.json`；
3. 合并到 main 后 `build-image` 构建 armv7 镜像并推送 GHCR；
4. 玩客云执行 `deploy/upgrade.sh` 一键拉取，失败自动回滚。

> 本 PR 只更新 `upstream.lock.json`，不含上游源码副本。

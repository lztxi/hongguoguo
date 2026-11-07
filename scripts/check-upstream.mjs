#!/usr/bin/env node
'use strict';
/**
 * 检查两个上游仓库的最新发行版，与 upstream.lock.json 比对。
 *
 *   node scripts/check-upstream.mjs           只检查，输出摘要
 *   node scripts/check-upstream.mjs --write  同时把新版本写回 lock 文件
 *
 * CI 中会把 changed / 新版本号写入 GITHUB_OUTPUT，并生成 .cache/pr-body.md
 * 供自动开 PR 使用。只认「正式发行 tag」，不跟随 main 的每次提交。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_FILE = path.join(ROOT, 'upstream.lock.json');
const WRITE = process.argv.includes('--write');
const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));

const HEADERS = {
  'User-Agent': 'hongguoguo',
  'Accept': 'application/vnd.github+json',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function api(pathname) {
  const url = pathname.startsWith('http') ? pathname : `https://api.github.com${pathname}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${url}`);
  return res.json();
}

async function latest(repo) {
  const release = await api(`/repos/${repo}/releases/latest`);
  const tag = release.tag_name;
  const ref = await api(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  let sha = ref.object.sha;
  if (ref.object.type === 'tag') {
    const annotated = await api(`/repos/${repo}/git/tags/${sha}`);
    sha = annotated.object.sha;
  }
  return { tag, sha, publishedAt: release.published_at, url: release.html_url };
}

async function compare(repo, fromTag, toTag, watchPaths) {
  if (fromTag === toTag) return { total: 0, watched: [], all: [] };
  try {
    const d = await api(`/repos/${repo}/compare/${encodeURIComponent(fromTag)}...${encodeURIComponent(toTag)}`);
    const all = (d.files || []).map(f => f.filename);
    return { total: all.length, watched: all.filter(f => watchPaths.some(w => f === w || f.endsWith('/' + w))), all };
  } catch (error) {
    return { total: -1, watched: [], all: [], error: error.message };
  }
}

function output(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${name}=${String(value).replace(/\r?\n/g, ' ')}\n`);
}

function semver(tag) { return /^(\d+)\.(\d+)/.exec(String(tag).replace(/^v/, '')); }

const results = [];
for (const key of ['jackotom', 'zfdang']) {
  const entry = lock[key];
  const now = await latest(entry.repo);
  const diff = await compare(entry.repo, entry.tag, now.tag, lock.watchPaths || []);
  results.push({ key, entry, now, diff, changed: entry.tag !== now.tag || entry.sha !== now.sha });
  console.log(`[check] ${key.padEnd(9)} ${entry.tag} -> ${now.tag} ${entry.tag === now.tag ? '(无变化)' : '(有更新)'}`);
  console.log(`         变更文件 ${diff.total} 个，其中我们关注的: ${diff.watched.join(', ') || '无'}`);
}

const changed = results.some(r => r.changed);
const summary = results.map(r => `${r.key}:${r.entry.tag}->${r.now.tag}`).join(' / ');

// 生成 PR 正文：列出两个上游的变更、重点文件、以及合并后会发生什么
const lines = [
  '## 上游更新待合并',
  '',
  `检测时间：${new Date().toISOString()}`,
  '',
];
for (const r of results) {
  lines.push(`### ${r.entry.repo}：\`${r.entry.tag}\` → \`${r.now.tag}\``);
  lines.push(`- commit: \`${r.now.sha.slice(0, 12)}\`，发布 ${r.now.publishedAt}`);
  lines.push(`- 发行页：${r.now.url}`);
  if (r.diff.total > 0) {
    lines.push(`- 共变更 ${r.diff.total} 个文件，其中本工程关注：`);
    for (const f of r.diff.watched) lines.push(`  - \`${f}\``);
    if (!r.diff.watched.length) lines.push('  - （无，纯文档/发行资料改动，风险低）');
  } else if (r.diff.error) {
    lines.push(`- ⚠️ 变更对比失败：${r.diff.error}`);
  }
  lines.push('');
}
lines.push(
  '### 合并后会自动发生什么',
  '',
  '1. `verify` 工作流重新拉取两份上游源码、叠加 `overlay/`、重放 hgop 锚点补丁并构建前端；',
  '2. 补丁锚点若被上游改动会**直接失败**，不会静默覆盖，需人工调整 `overlay/hgop/patches.json`；',
  '3. 合并到 main 后 `build-image` 构建 armv7 镜像并推送 GHCR；',
  '4. 玩客云执行 `deploy/upgrade.sh` 一键拉取，失败自动回滚。',
  '',
  '> 本 PR 只更新 `upstream.lock.json`，不含上游源码副本。',
  '',
);
fs.mkdirSync(path.join(ROOT, '.cache'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.cache', 'pr-body.md'), lines.join('\n'));

if (WRITE) {
  for (const r of results) {
    lock[r.key].tag = r.now.tag;
    lock[r.key].sha = r.now.sha;
    lock[r.key].publishedAt = r.now.publishedAt;
  }
  lock.checkedAt = new Date().toISOString();
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + '\n');
  console.log('[check] upstream.lock.json 已更新');
}

output('changed', changed ? 'true' : 'false');
output('summary', summary);
output('jackotom_tag', results[0].now.tag);
output('zfdang_tag', results[1].now.tag);
console.log(`[check] changed=${changed} summary=${summary}`);

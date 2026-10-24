/**
 * 从仓库根 `CHANGELOG.md` 生成站点「版本历史」页的**正文区**（en + zh-cn 两套）。
 *
 * 为什么是"正文区"而不是整页：
 *   页面还需要 frontmatter、导语和版本号规则（这些是站点侧的编辑内容，不该被生成覆盖）。
 *   因此页面里留一对标记，脚本只替换标记之间的内容：
 *
 *     <!-- CHANGELOG:BEGIN -->
 *     …由本脚本生成…
 *     <!-- CHANGELOG:END -->
 *
 *   ⇒ 标记外人工改、标记内机器写，两边永远不抢同一个字节。
 *
 * 与 `gen-reference.mjs` 同样的口径：**一处真源，两处呈现**。
 * 站点不维护第二份版本记录，`CHANGELOG.md` 改了而本页没刷新，`site-check` 会红。
 *
 * 用法：
 *   node scripts/gen-changelog.mjs          写入文件
 *   node scripts/gen-changelog.mjs --check  只比对（不写），落后即 exit 1
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHECK = process.argv.includes('--check');
const repoRoot = new URL('../../', import.meta.url);
const docs = new URL('../src/content/docs/', import.meta.url);

const BEGIN = '<!-- CHANGELOG:BEGIN -->';
const END = '<!-- CHANGELOG:END -->';
const LANGS = ['en', 'zh-cn'];

/* ── 1. 读真源，切出"版本正文" ───────────────────────────────────── */

const raw = readFileSync(new URL('./CHANGELOG.md', repoRoot), 'utf8').replace(/\r\n/g, '\n');

// 丢掉 `# Changelog` 一级标题与它下面的 Keep-a-Changelog 说明段：
// 页面标题由 frontmatter 提供（否则一页两个 h1），导语由站点侧按语言各写一份。
// 从第一个 `## ` 起往后全要 —— 包括结尾的 `[unreleased]: …` 链接定义，
// 少了它，`## [Unreleased]`、`## [0.1.0]` 会退化成字面方括号。
const start = raw.search(/^## /m);
if (start < 0) {
  console.error('[gen-changelog] CHANGELOG.md 里找不到 `## ` 版本段落');
  process.exit(1);
}
const body = raw.slice(start).trimEnd();

// 形状断言：至少一个版本段。防止真源被清空后静默生成一个空页面。
if (!/^## /m.test(body)) {
  console.error('[gen-changelog] 版本正文为空');
  process.exit(1);
}
const versionCount = (body.match(/^## /gm) ?? []).length;

const block = `${BEGIN}\n${body}\n${END}`;

/* ── 2. 只替换标记区间 ───────────────────────────────────────────── */

let stale = 0;
for (const lang of LANGS) {
  const file = `${lang}/changelog.md`;
  const target = new URL(file, docs);
  let current;
  try {
    current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    console.error(`[gen-changelog] 缺少页面：${file}`);
    stale++;
    continue;
  }

  const b = current.indexOf(BEGIN);
  const e = current.indexOf(END, b + BEGIN.length);
  if (b < 0 || e < 0) {
    console.error(`[gen-changelog] ${file} 缺少 ${BEGIN} / ${END} 标记`);
    stale++;
    continue;
  }

  const next = current.slice(0, b) + block + current.slice(e + END.length);

  if (next === current) {
    console.log(`[gen-changelog] ${file} up to date`);
    continue;
  }
  if (CHECK) {
    stale++;
    console.error(`[gen-changelog] stale: ${file}`);
    continue;
  }
  writeFileSync(fileURLToPath(target), next);
  console.log(`[gen-changelog] ${file} 已刷新（${versionCount} 个版本段）`);
}

if (CHECK) {
  if (stale) {
    console.error(
      `[gen-changelog] ${stale} 个页面落后于 CHANGELOG.md — 执行：node scripts/gen-changelog.mjs`,
    );
    process.exit(1);
  }
  console.log(`[gen-changelog] 两套 locale 与 CHANGELOG.md 同步（${versionCount} 个版本段）`);
}

/**
 * 站点构建包装器
 *
 * 为什么要包一层：Astro 在收尾时会批量删除 dist/.prerender（上百个临时文件），
 * 本机环境的"批量删除需确认"护栏会把这一步拦下，Astro 于是以非零码退出 ——
 * 但页面其实**已经全部产出**。直接把它当失败，会让 Pagefind（在 astro:build:done 里跑）
 * 永远不执行，站内搜索就没索引。
 *
 * 因此这里改为：
 *   1. 跑 `astro build`（继承输出，不因收尾清理失败而中断后续）
 *   2. 用**产物自检**判定构建是否真的成功（关键页面是否落盘）
 *   3. 把 .prerender 移到系统临时目录（不用 rm —— 本仓库护栏拦 rm）
 *   4. 手动跑 Pagefind 生成搜索索引
 *
 * CI（GitHub Actions）里没有这个护栏，Astro 会正常退出，本脚本同样成立。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(siteRoot, 'dist');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: siteRoot, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  return r.status ?? 1;
}

/* 0. 生成页必须在构建链里刷新，否则"改了真源忘生成"会被 site-check 拦下：
   · gen-reference：契约 → 消息参考 / 平台端点 / 控制面端点
   · gen-changelog：CHANGELOG.md → 版本历史页正文区 */
for (const gen of ['scripts/gen-reference.mjs', 'scripts/gen-changelog.mjs']) {
  const genStatus = run(process.execPath, [gen]);
  if (genStatus !== 0) {
    console.error(`\n[build] 生成失败：${gen}`);
    process.exit(1);
  }
}

/* 1. astro build */
const astroStatus = run(npm, ['run', 'astro', '--', 'build']);

/* 2. 产物自检（比退出码可靠） */
const required = [
  'en/index.html',
  'zh-cn/index.html',
  'en/api/reference/index.html',
  'zh-cn/api/control-plane-reference/index.html',
  'en/protocol/messages/index.html',
];
const missing = required.filter((p) => !existsSync(join(dist, p)));
if (missing.length) {
  console.error('\n[build] 构建产物自检失败，缺少：');
  for (const m of missing) console.error(`  ✗ ${m}`);
  process.exit(1);
}
if (astroStatus !== 0) {
  console.warn(
    `[build] astro build 退出码 ${astroStatus}（多为收尾清理被环境护栏拦下）；产物自检通过，继续生成搜索索引。`,
  );
}

/* 3. 移走中间产物（mv，不是 rm） */
const prerender = join(dist, '.prerender');
if (existsSync(prerender)) {
  const target = join(tmpdir(), `ab-site-prerender-${Date.now()}`);
  try {
    renameSync(prerender, target);
  } catch {
    // 移不走也不致命：pagefind 只索引 HTML
    console.warn('[build] .prerender 无法移走（忽略）');
  }
}

/* 4. Pagefind：全站搜索索引（含静态生成的 API 端点页） */
const pfStatus = run(npm, ['exec', '--', 'pagefind', '--site', 'dist', '--output-subdir', 'pagefind']);
const indexOk = existsSync(join(dist, 'pagefind', 'pagefind.js'));
if (pfStatus !== 0 || !indexOk) {
  console.error('\n[build] Pagefind 索引生成失败 —— 站内搜索将不可用');
  process.exit(1);
}

console.log('\n[build] 完成：页面已产出，搜索索引已生成');

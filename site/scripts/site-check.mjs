/**
 * 站点级防漂移校验（构建前置，CI 里跑在 build 之前）
 *
 * 1. CLI 命令页 ↔ src/cli/dispatch.ts 的 COMMANDS 表：加命令没写文档 → 红
 * 2. 三份契约能被解析，且控制面端点在文档里有记载 → 红
 * 3. 生成页（消息/API 参考）与契约同步：改了契约没重新生成 → 红
 * 4. i18n 对等：en 有 zh-cn 必须也有（反之亦然）→ 红
 *
 * 主包的 `npm run gate` 不跑这个 —— 站点是独立工作区，站点坏不阻断主包发布。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as load } from 'yaml';

const siteRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const docsDir = join(siteRoot, 'src/content/docs');

const errors = [];
const fail = (m) => errors.push(m);

/* ── 1. CLI 命令覆盖 ─────────────────────────────────────────────── */

const dispatch = readFileSync(join(repoRoot, 'src/cli/dispatch.ts'), 'utf8');
const table = dispatch.match(/export const COMMANDS[^=]*=\s*\{([\s\S]*?)\n\};/);
const commands = table
  ? [...table[1].matchAll(/^\s*([a-zA-Z][\w-]*)\s*:/gm)].map((m) => m[1])
  : [];
if (!commands.length) fail('无法从 src/cli/dispatch.ts 解析出 COMMANDS 表');

for (const lang of ['en', 'zh-cn']) {
  const p = join(docsDir, lang, 'cli.md');
  if (!existsSync(p)) {
    fail(`缺少 ${lang}/cli.md`);
    continue;
  }
  const text = readFileSync(p, 'utf8');
  for (const c of commands) {
    // 允许 `## connect`、`### connect` 或 `#### connect` 形式的条目
    const re = new RegExp(`^#{2,4}\\s+\`?${c}\`?\\s*$`, 'm');
    if (!re.test(text)) fail(`${lang}/cli.md 缺少命令条目：${c}`);
  }
}
console.log(`[site-check] CLI 命令覆盖：${commands.join(', ')}`);

/* ── 1.5 Agent 墙 ↔ 适配器清单：首页列的 Agent 必须与代码里的适配器一致 ── */

const wall = readFileSync(join(siteRoot, 'src/components/home/AgentWall.astro'), 'utf8');
const namesBlock = wall.match(/const NAMES[^{]*\{([\s\S]*?)\n\};/);
const wallKinds = namesBlock
  ? [...namesBlock[1].matchAll(/^\s*'?([a-z-]+)'?:/gm)].map((m) => m[1]).sort()
  : [];
const adapters = readFileSync(join(repoRoot, 'src/adapters/agent-adapters.ts'), 'utf8');
const adapterKinds = [...adapters.matchAll(/kind:\s*'([a-z-]+)'/g)].map((m) => m[1]).sort();

const missingOnWall = adapterKinds.filter((k) => !wallKinds.includes(k));
const ghostOnWall = wallKinds.filter((k) => !adapterKinds.includes(k));
if (missingOnWall.length) fail(`Agent 墙缺少适配器：${missingOnWall.join(', ')}`);
if (ghostOnWall.length) fail(`Agent 墙有未知适配器：${ghostOnWall.join(', ')}`);
if (!wallKinds.length) fail('无法从 AgentWall.astro 解析出 Agent 清单');
console.log(`[site-check] Agent 墙与适配器一致：${wallKinds.length} 个`);

// 1.6 图标必须是顶层 svg：`<svg set:html={...}>` 会套出内层 svg，而内层 svg 不跟随
// CSS 缩放到容器尺寸（按自身 24px 排版），右/下各 4px 被外层视口裁掉 —— 2026-10-24 实测事故
// （12 个图标全部被切，opencode 的右边框被切到只剩 "["）。改用 HTML 容器 set:html 即可。
// 判定前先剥掉注释 —— 注释里拿反例做说明时不能误报。
const wallMarkup = wall.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
if (/<svg[^>]*\sset:html/.test(wallMarkup)) {
  fail('AgentWall 图标不得用 `<svg set:html>` 套娃（内层 svg 不跟随缩放，会被裁切）');
}
console.log('[site-check] Agent 墙图标非嵌套渲染');

/* ── 1.7 页脚站内链接 ↔ 实际页面 ─────────────────────────────────── */

// 页脚菜单是新加的「人工维护的链接表」，最容易在删/改页面后留下死链。
// 只校验 `${base}/…` 形态的站内链接；外链（GitHub / llms.txt）不在此列。
const footerSrc = readFileSync(join(siteRoot, 'src/components/overrides/Footer.astro'), 'utf8');
const footerRoutes = [...footerSrc.matchAll(/href: `\$\{base\}\/([^`]*)`/g)].map((m) =>
  m[1].replace(/\/$/, ''),
);
if (!footerRoutes.length) fail('无法从 Footer.astro 解析出站内链接');

function routeExists(lang, route) {
  const p = join(docsDir, lang, route);
  if (existsSync(`${p}.md`) || existsSync(`${p}.mdx`)) return true;
  return existsSync(join(p, 'index.md')) || existsSync(join(p, 'index.mdx'));
}

for (const route of footerRoutes) {
  for (const lang of ['en', 'zh-cn']) {
    if (!routeExists(lang, route)) fail(`页脚链接指向不存在的页面：${lang}/${route}`);
  }
}
console.log(`[site-check] 页脚站内链接：${footerRoutes.length} 条 × 2 locale`);

/* ── 1.8 版本历史页 ↔ CHANGELOG.md ───────────────────────────────── */

// 版本历史页是 CHANGELOG.md 的渲染视图（一处真源两处呈现）。
// 两边脱钩有两种典型形态，都要红：
//   · 改了 CHANGELOG.md 但页面没刷新（生成区落后）
//   · 生成区里的版本段数量与真源对不上（曾经有人手工删过几段"看着重复"的）
const changelogSrc = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
const sourceVersions = (changelogSrc.match(/^## /gm) ?? []).length;
if (!sourceVersions) fail('CHANGELOG.md 里找不到版本段落');

try {
  execFileSync(process.execPath, [join(siteRoot, 'scripts/gen-changelog.mjs'), '--check'], {
    stdio: 'pipe',
  });
} catch {
  fail('版本历史页与 CHANGELOG.md 不同步 — 执行：node site/scripts/gen-changelog.mjs');
}

for (const lang of ['en', 'zh-cn']) {
  const p = join(docsDir, lang, 'changelog.md');
  if (!existsSync(p)) {
    fail(`缺少 ${lang}/changelog.md`);
    continue;
  }
  const text = readFileSync(p, 'utf8');
  const b = text.indexOf('<!-- CHANGELOG:BEGIN -->');
  const e = text.indexOf('<!-- CHANGELOG:END -->', b + 1);
  if (b < 0 || e < 0) {
    fail(`${lang}/changelog.md 缺少 CHANGELOG 生成区标记`);
    continue;
  }
  const rendered = (text.slice(b, e).match(/^## /gm) ?? []).length;
  if (rendered !== sourceVersions) {
    fail(`${lang}/changelog.md 渲染了 ${rendered} 个版本段，CHANGELOG.md 有 ${sourceVersions} 个`);
  }
}
console.log(`[site-check] 版本历史页 ↔ CHANGELOG.md：${sourceVersions} 个版本段 × 2 locale`);

/* ── 2. 契约可解析 + 控制面端点有记载 ───────────────────────────── */

const contracts = [
  'asyncapi-3.0.yaml',
  'openapi-3.1.yaml',
  'openapi.control-plane.yaml',
];
const parsed = {};
for (const f of contracts) {
  const p = join(repoRoot, 'contracts', f);
  if (!existsSync(p)) {
    fail(`契约缺失：contracts/${f}`);
    continue;
  }
  try {
    parsed[f] = load(readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`契约解析失败：contracts/${f} — ${e.message}`);
  }
}

const cp = parsed['openapi.control-plane.yaml'];
if (cp?.paths) {
  const ops = [];
  for (const [path, item] of Object.entries(cp.paths)) {
    for (const m of Object.keys(item ?? {})) {
      if (['get', 'post', 'patch', 'put', 'delete'].includes(m)) ops.push(`${m.toUpperCase()} ${path}`);
    }
  }
  const cpRefEn = join(docsDir, 'en/api/control-plane-reference.md');
  const cpRefZh = join(docsDir, 'zh-cn/api/control-plane-reference.md');
  for (const ref of [cpRefEn, cpRefZh]) {
    if (!existsSync(ref)) {
      fail(`缺少生成页：${relative(siteRoot, ref)}`);
      continue;
    }
    const text = readFileSync(ref, 'utf8');
    for (const key of ops) {
      if (!text.includes(`### ${key}`)) fail(`${relative(siteRoot, ref)} 缺少端点：${key}`);
    }
  }
  console.log(`[site-check] 控制面端点：${ops.length} 个`);
}

/* ── 3. 生成页与契约同步 ─────────────────────────────────────────── */

try {
  execFileSync(process.execPath, [join(siteRoot, 'scripts/gen-reference.mjs'), '--check'], {
    stdio: 'pipe',
  });
} catch (e) {
  fail('生成页与契约不同步（见上面 gen-reference 输出）');
}

/* ── 4. i18n 对等 ───────────────────────────────────────────────── */

function walk(dir, base = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, `${base}${e}/`));
    else out.push(base + e);
  }
  return out;
}

const enPages = walk(join(docsDir, 'en')).sort();
const zhPages = walk(join(docsDir, 'zh-cn')).sort();
const missingInZh = enPages.filter((f) => !zhPages.includes(f));
const missingInEn = zhPages.filter((f) => !enPages.includes(f));
if (missingInZh.length) fail(`zh-cn 缺少页面：${missingInZh.join(', ')}`);
if (missingInEn.length) fail(`en 缺少页面：${missingInEn.join(', ')}`);
console.log(`[site-check] i18n 对等：${enPages.length} 页 × 2 locale`);

/* ── 结论 ───────────────────────────────────────────────────────── */

if (errors.length) {
  console.error('\n[site-check] 失败：');
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('\n[site-check] 全部通过');

/**
 * 发布链路的离线取证（不需要 GITHUB_TOKEN / NPM_TOKEN，不联网、不写仓库）：
 *
 *   1. 取**最近一个已发布 tag**（`git describe --tags --abbrev=0 --match 'v*'`）到 HEAD 的真实提交
 *   2. 用 @semantic-release/commit-analyzer 算出这次该升哪一位 —— 这是 semantic-release 在 CI 里
 *      会做的同一件事，所以这里的结论就是「推 main 之后实际会发什么版本」
 *   3. 用 @semantic-release/release-notes-generator 生成 notes
 *   4. 把 notes 交给 scripts/semantic-release-changelog.mjs（在 CHANGELOG.md 的临时副本上）
 *   5. 断言结构：标题在最前、新版本插在**第一个旧版本之前**、正文里只有一个 h1、版本标题统一为 h2
 *
 * 跑法：
 *   node scripts/verify-release.mjs                  # 只报告「会发哪个版本」
 *   node scripts/verify-release.mjs --expect=1.0.0   # 版本不符即退出码 1（发布前的闸门）
 *
 * 为什么不硬编码版本：0.1.0 → 0.2.0 时期的脚本写死了 tag 和期望版本，发到 0.2.3 之后就一直在
 * 校验一个早就存在的版本段（且 `## [Unreleased]` 段已不存在 → 断言长期失败却没人发现）。
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

const expectArg = process.argv.find((a) => a.startsWith('--expect='));
const expected = expectArg ? expectArg.slice('--expect='.length).trim() : null;

const fails = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) fails.push(label);
};

/** 手工升版本（只处理正式版，够用且不引入 semver 依赖） */
function bump(version, type) {
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// semantic-release 的插件会为**每个提交**打一行日志（101 个提交就是 101 行），
// 默认关掉，需要排查时加 --verbose。
const verbose = process.argv.includes('--verbose');
const logger = {
  log: verbose ? (...a) => console.log('[semrel]', ...a) : () => {},
  error: (...a) => console.error('[semrel]', ...a),
};

/* 1. 基线 tag → 提交 ------------------------------------------------ */

const lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*').trim();
const lastVersion = lastTag.replace(/^v/, '');
console.log(`[verify-release] 上一个发布：${lastTag}（${git('log', '-1', '--format=%cs', lastTag).trim()}）`);

const raw = git('log', '--format=%H%x1f%s%x1f%b%x1e', `${lastTag}..HEAD`);
const commits = raw
  .split('\x1e')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((rec) => {
    const [hash, subject, body = ''] = rec.split('\x1f');
    return { hash, message: `${subject}\n\n${body}`.trim() };
  });

check(commits.length > 0, `${lastTag}..HEAD 有提交可分析（${commits.length} 个）`);

/* 2. 算版本类型（= semantic-release 的判定）-------------------------- */

const { analyzeCommits } = await import('@semantic-release/commit-analyzer').then((m) => m.default ?? m);
const releaseType = await analyzeCommits({ preset: 'angular' }, { cwd: repo, commits, logger });

if (!releaseType) {
  check(false, '有可发布内容（feat/fix/breaking）；当前无 → semantic-release 会什么都不做');
  console.error('\n[verify-release] 没有可发布的提交，后续断言跳过');
  process.exit(1);
}

const nextVersion = bump(lastVersion, releaseType);
console.log(`[verify-release] releaseType=${releaseType} → 预期版本 ${nextVersion}`);

check(
  expected === null || nextVersion === expected,
  expected === null
    ? '未指定 --expect，跳过版本断言'
    : `版本符合预期（--expect=${expected}，实际 ${nextVersion}）`,
);

const lastRelease = { version: lastVersion, gitTag: lastTag, gitHead: git('rev-parse', lastTag).trim() };
const nextRelease = {
  version: nextVersion,
  gitTag: `v${nextVersion}`,
  type: releaseType,
  date: new Date().toISOString().slice(0, 10),
};

/* 3. 真实提交 → notes ------------------------------------------------ */

const { generateNotes } = await import('@semantic-release/release-notes-generator').then((m) => m.default ?? m);
const notes = await generateNotes(
  { preset: 'angular' },
  {
    cwd: repo,
    options: { repositoryUrl: 'https://github.com/shaylanwu/agent-bridge.git' },
    lastRelease,
    nextRelease,
    commits,
    logger,
  },
);

console.log(`\n=== 生成的 notes（前 6 行，共 ${commits.length} 个提交）===`);
console.log(notes.trim().split('\n').slice(0, 6).join('\n'));
console.log('===\n');

check(new RegExp(`^#+ \\[?${nextVersion.replace(/\./g, '\\.')}`).test(notes.trim()), `notes 标题带 ${nextVersion}`);
check(/^##+ /m.test(notes) && /\n### /.test(notes), 'notes 里有分组小节（### Features / ### Bug Fixes）');

/* 4. 写入 CHANGELOG 临时副本 ---------------------------------------- */

const tmp = mkdtempSync(join(tmpdir(), 'ab-release-verify-'));
copyFileSync(join(repo, 'CHANGELOG.md'), join(tmp, 'CHANGELOG.md'));
const before = readFileSync(join(tmp, 'CHANGELOG.md'), 'utf8');
const prevSections = (before.match(/^## \[?\d+\.\d+\.\d+/gm) ?? []).length;

const { prepare } = await import(pathToFileURL(join(repo, 'scripts/semantic-release-changelog.mjs')).href);
await prepare({ changelogFile: 'CHANGELOG.md' }, { cwd: tmp, nextRelease: { version: nextVersion, notes }, logger });

const out = readFileSync(join(tmp, 'CHANGELOG.md'), 'utf8');
const lines = out.split('\n');

console.log('=== 写入后的前 14 行 ===');
console.log(lines.slice(0, 14).join('\n'));
console.log('===\n');

/* 5. 结构断言 ------------------------------------------------------- */

const h1Lines = lines.filter((l) => /^# /.test(l));
const h2Lines = lines.filter((l) => /^## /.test(l));
const bodyH1 = lines.filter((l) => /^# /.test(l) && !/^# Changelog$/.test(l));
const iNew = out.search(new RegExp(`^## \\[?${nextVersion.replace(/\./g, '\\.')}`, 'm'));
// 插入点必须是**第一个旧版本段之前**：取上一次发布的版本段作为锚点
const iPrev = out.search(new RegExp(`^## \\[?${lastVersion.replace(/\./g, '\\.')}`, 'm'));

check(lines[0] === '# Changelog', '标题仍在本页第一行（`# Changelog`）');
check(bodyH1.length === 0, '正文里没有第二个 h1（版本标题已压成 ##）');
check(iNew > 0 && iPrev > 0 && iNew < iPrev, `新版本段插在 ${lastVersion} 之前`);
check(h2Lines.length === prevSections + 1, `版本段数量 = ${h2Lines.length}（原 ${prevSections} + 1）`);
check(out.includes(`## [${lastVersion}]`) || out.includes(`## ${lastVersion}`), `旧版本段 ${lastVersion} 仍在`);
check(h1Lines.length === 1, '全文只有一个 h1');

/* 6. 结论 ----------------------------------------------------------- */

writeFileSync(join(tmp, 'CHANGELOG.after.md'), out);
console.log(`\n[verify-release] 临时产物：${tmp}`);
console.log(`[verify-release] 结论：合入 main 后 semantic-release 会发布 ${lastTag} → ${nextVersion}`);
if (fails.length) {
  console.error(`\n[verify-release] ${fails.length} 项失败：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\n[verify-release] 发布链路离线取证全部通过');

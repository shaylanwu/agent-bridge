/**
 * 发布链路的离线取证（不需要 GITHUB_TOKEN / NPM_TOKEN，不联网、不写仓库）：
 *
 *   1. 用 @semantic-release/release-notes-generator 从 v0.1.0..HEAD 的**真实提交**生成 notes
 *   2. 把 notes 交给 scripts/semantic-release-changelog.mjs（在 CHANGELOG.md 的临时副本上）
 *   3. 断言结构：标题在最前、新版本插在第一个旧版本之前、正文里只有一个 h1、版本标题统一为 h2
 *
 * 跑法：node scripts/verify-release.mjs
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

const fails = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) fails.push(label);
};

/* 1. 真实提交 → notes ------------------------------------------------ */

const raw = git('log', '--format=%H%x1f%B%x1e', 'v0.1.0..HEAD');
const commits = raw
  .split('\x1e')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((rec) => {
    const [hash, message] = rec.split('\x1f');
    return { hash, message };
  });

const lastRelease = { version: '0.1.0', gitTag: 'v0.1.0', gitHead: git('rev-parse', 'v0.1.0').trim() };
const nextRelease = {
  version: '0.2.0',
  gitTag: 'v0.2.0',
  type: 'minor',
  date: new Date('2026-10-24T00:00:00Z'),
};
const logger = {
  log: (...a) => console.log('[semrel]', ...a),
  error: (...a) => console.error('[semrel]', ...a),
};

const { generateNotes } = await import('@semantic-release/release-notes-generator');
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

check(commits.length > 0, 'v0.1.0..HEAD 有提交可分析');
check(/^#+ \[?\d+\.\d+\.\d+/.test(notes.trim()), 'notes 带版本标题');
check(/^##+ /m.test(notes) && /\n### /.test(notes), 'notes 里有分组小节（### Features / ### Bug Fixes）');

/* 2. 写入 CHANGELOG 临时副本 ---------------------------------------- */

const tmp = mkdtempSync(join(tmpdir(), 'ab-release-verify-'));
copyFileSync(join(repo, 'CHANGELOG.md'), join(tmp, 'CHANGELOG.md'));
const { prepare } = await import(pathToFileURL(join(repo, 'scripts/semantic-release-changelog.mjs')).href);
await prepare({ changelogFile: 'CHANGELOG.md' }, { cwd: tmp, nextRelease: { version: '0.2.0', notes }, logger });

const out = readFileSync(join(tmp, 'CHANGELOG.md'), 'utf8');
const lines = out.split('\n');
writeFileSync(join(tmp, 'CHANGELOG.after.md'), out);

console.log('=== 写入后的前 14 行 ===');
console.log(lines.slice(0, 14).join('\n'));
console.log('===\n');

/* 3. 结构断言 ------------------------------------------------------- */

const h1Lines = lines.filter((l) => /^# /.test(l));
const h2Lines = lines.filter((l) => /^## /.test(l));
const bodyH1 = lines.filter((l) => /^# /.test(l) && !/^# Changelog$/.test(l));
const iNew = out.search(/^## \[?0\.2\.0/m);
const iOld = out.search(/^## \[Unreleased\]/m);

check(lines[0] === '# Changelog', '标题仍在本页第一行（`# Changelog`）');
check(bodyH1.length === 0, '正文里没有第二个 h1（版本标题已压成 ##）');
check(iNew > 0 && iOld > 0 && iNew < iOld, '新版本插在第一个旧版本之前');
check(h2Lines.length >= 3, `版本段数量 = ${h2Lines.length}（0.2.0 + Unreleased + 0.1.0）`);
check(out.includes('[Unreleased]'), '`## [Unreleased]` 保留');
check(h1Lines.length === 1, '全文只有一个 h1');

/* 4. 结论 ----------------------------------------------------------- */

console.log(`\n[verify-release] 临时产物：${tmp}`);
if (fails.length) {
  console.error(`\n[verify-release] ${fails.length} 项失败：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\n[verify-release] 发布链路离线取证全部通过');

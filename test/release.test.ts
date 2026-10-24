/**
 * 发布自动化的可测部分：CHANGELOG 写入插件（scripts/semantic-release-changelog.mjs）。
 *
 * 它替掉了 `@semantic-release/changelog`，原因是后者只能把新版本前插到文件最顶部
 * （`# Changelog` 会掉到版本段下面）。这里钉住四条行为，防止以后"顺手换回现成插件"：
 *   1. 新版本插在第一个 `## ` 之前 —— 标题与前言都不动
 *   2. conventional-changelog 给 minor/major 用的 `# ` 标题被压成 `## `（一页只能有一个 h1）
 *   3. 没有 notes 时不碰文件
 *   4. 文件不存在时从零建一个（包含 `# Changelog` 标题）
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error —— 纯 JS 插件脚本，不在 tsc 的 include 范围内（test/ 也不在）
import { prepare } from '../scripts/semantic-release-changelog.mjs';

const logger = { log: () => {} };

const BASE = `# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- pending thing

## [1.0.0] - 2026-01-01

### Added

- shipped thing
`;

function freshFile(content = BASE) {
  const dir = mkdtempSync(join(tmpdir(), 'ab-changelog-test-'));
  const file = join(dir, 'CHANGELOG.md');
  if (content !== null) writeFileSync(file, content);
  return { dir, file };
}

const NOTES = `# [2.0.0](https://example.com/compare/v1.0.0...v2.0.0) (2026-10-24)


### Features

* **cli:** new flag ([abc1234](https://example.com/commit/abc1234))
`;

describe('semantic-release changelog 插件', () => {
  it('把新版本插到第一个 `## ` 之前，标题与前言不动', async () => {
    const { file } = freshFile();
    await prepare({ changelogFile: file }, { cwd: '/', nextRelease: { version: '2.0.0', notes: NOTES }, logger });

    const out = readFileSync(file, 'utf8');
    expect(out.startsWith('# Changelog\n')).toBe(true);
    expect(out.indexOf('## [2.0.0]')).toBeGreaterThan(out.indexOf('All notable changes'));
    expect(out.indexOf('## [2.0.0]')).toBeLessThan(out.indexOf('## [Unreleased]'));
    expect(out.indexOf('## [Unreleased]')).toBeLessThan(out.indexOf('## [1.0.0]'));
    // 旧内容一个字不丢
    expect(out).toContain('- pending thing');
    expect(out).toContain('- shipped thing');
  });

  it('把 minor/major 的 `# x.y.z` 标题压成 `## `（一页只有一个 h1）', async () => {
    const { file } = freshFile();
    await prepare({ changelogFile: file }, { cwd: '/', nextRelease: { version: '2.0.0', notes: NOTES }, logger });

    const out = readFileSync(file, 'utf8');
    const h1 = out.split('\n').filter((l) => /^# /.test(l));
    expect(h1).toEqual(['# Changelog']);
    expect(out).toContain('## [2.0.0](https://example.com/compare/v1.0.0...v2.0.0)');
    // 小节层级不能被压平
    expect(out).toContain('### Features');
  });

  it('没有 notes 时完全不碰文件', async () => {
    const { file } = freshFile();
    await prepare({ changelogFile: file }, { cwd: '/', nextRelease: { version: '2.0.0', notes: '' }, logger });
    expect(readFileSync(file, 'utf8')).toBe(BASE);
  });

  it('文件不存在时从零建一个', async () => {
    const { file } = freshFile(null);
    expect(existsSync(file)).toBe(false);
    await prepare({ changelogFile: file }, { cwd: '/', nextRelease: { version: '1.0.0', notes: NOTES }, logger });

    const out = readFileSync(file, 'utf8');
    expect(out.startsWith('# Changelog\n')).toBe(true);
    expect(out).toContain('## [2.0.0]');
  });
});

/**
 * semantic-release 的 CHANGELOG 写入插件（就地替换 `@semantic-release/changelog`）。
 *
 * 为什么不用现成的那个：它把新版本**直接放在文件最前面**，或者（给了 `changelogTitle` 时）
 * 放在标题之后、前言之前 —— 于是要么 `# Changelog` 落到版本段下面，要么前言被夹在新旧版本中间。
 * 实测（2026-10-24，`@semantic-release/changelog@7` 的 `lib/prepare.js`）它只做
 * `notes + '\n' + 旧内容`，没有"插入点"这个概念。
 *
 * 本仓库的 CHANGELOG 结构是固定的三段：标题 → 前言（Keep a Changelog 说明）→ 版本段。
 * 所以这里只做一件事：**把新版本插到第一个 `## ` 之前**，前面一律不动。
 *
 * 顺带修一个 conventional-changelog 的格式不一致：它生成的版本标题对 patch 用 `##`、
 * 对 minor/major 用 `#`（`isPatch` 分支）。本站的版本历史页用 frontmatter 提供 h1，
 * 正文里出现第二个 h1 会破坏大纲，因此统一压成 `##`。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TITLE = '# Changelog';

/** 版本标题统一到 `## `（`### Features` 这类小节不动） */
function normalizeNotes(notes) {
  return notes
    .replace(/\r\n/g, '\n')
    .trim()
    .replace(/^# (?=\[|[0-9])/gm, '## ');
}

export async function prepare(pluginConfig, { cwd, nextRelease, logger }) {
  const file = resolve(cwd, pluginConfig?.changelogFile ?? 'CHANGELOG.md');
  const notes = normalizeNotes(nextRelease?.notes ?? '');
  if (!notes) {
    logger.log('CHANGELOG: 本次没有 release notes，跳过写入');
    return;
  }

  const current = existsSync(file)
    ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    : `${TITLE}\n`;

  // 插入点 = 第一个版本段。找不到就追加到末尾（文件还没被初始化时）。
  const at = current.search(/^## /m);
  const head = (at < 0 ? current : current.slice(0, at)).trimEnd();
  const tail = at < 0 ? '' : current.slice(at).trimEnd();

  const next = `${head}\n\n${notes}\n${tail ? `\n${tail}\n` : ''}`;
  if (next === current) {
    logger.log('CHANGELOG: %s 无变化', file);
    return;
  }

  writeFileSync(file, next);
  logger.log('CHANGELOG: %s 已插入 %s', file, nextRelease.version);
}

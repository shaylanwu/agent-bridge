/**
 * 适配器品牌图标：把随包发布的 `assets/agent-icons/<kind>.svg` 转成 base64 data URI。
 *
 * 为什么内嵌而不是给 URL：平台侧是第三方实现，不该为了画 12 个卡片再维护一份图标资产；
 * data URI 可以直接丢给 `<img src>`。全量约 70KB（base64 后），平台按 kind 缓存一次即可（见 README）。
 *
 * 图标规格（**资产即标准，官网与平台共用同一份**，改资产前先读这条）：
 *   - 统一 `viewBox="0 0 24 24"` + `width/height="24"`，透明背景；
 *   - 内容用 `<g transform="translate(tx ty) scale(s)">` 归一化：墨迹最大边 = 20（24 画布内留 2 单位
 *     安全边距，约 83%），居中 —— 各家原始画布（24 / 40 / 192）与内在留白不同，不归一化就会一大一小、
 *     超界被裁（CodeBuddy 曾因滤镜光晕超出 40 画布被切）；
 *   - 保留官方品牌色，不做反色；`<title>` 保持在 `<g>` 外供读屏。
 *   - **填充式方块图标**（kimi-code / codebuddy-cli / trae-cli）统一 5 单位圆角（24 画布 ≈21%，
 *     绝对半径一致）；其余字形/线条型图标保持官方轮廓不动（如 opencode 的方框是线条字形，不套圆角）。
 *   ⇒ 平台任何尺寸（24 / 32 / 48）渲染出来光学大小一致。
 *
 * 注意：codex / grok-cli / mimo-code / opencode 的官方商标是深色（#111111），深色卡片上会看不见 ——
 * 官网靠 CSS 反色处理（`INVERT_ON_DARK`）；平台若用深底，需要自行反色或给浅色底板。
 *
 * 资产缺失不致命：返回 undefined，扫描结果省略 `logo` 字段，平台回退首字母块。
 */

import { readFileSync } from 'node:fs';

// src/ 与 dist/ 都在仓库根下一层，故只需回退一级（`../../` 会跑到仓库外）
// 注意：本文件在 src/adapters/ 下，资产目录要往上两级
const DIR = new URL('../../assets/agent-icons/', import.meta.url);
const cache = new Map<string, string | undefined>();

export function logoDataUri(kind: string): string | undefined {
  if (cache.has(kind)) return cache.get(kind);
  let value: string | undefined;
  try {
    const svg = readFileSync(new URL(`${kind}.svg`, DIR));
    value = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  } catch {
    value = undefined;
  }
  cache.set(kind, value);
  return value;
}

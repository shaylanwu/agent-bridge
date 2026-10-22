/**
 * 适配器品牌图标：把随包发布的 `assets/agent-icons/<kind>.svg` 转成 base64 data URI。
 *
 * 为什么内嵌而不是给 URL：平台侧是第三方实现，不该为了画 11 个卡片再维护一份图标资产；
 * data URI 可以直接丢给 `<img src>`。全量约 70KB，平台按 kind 缓存一次即可（见 README）。
 *
 * 资产缺失不致命：返回 undefined，扫描结果省略 `logo` 字段，平台回退首字母块。
 */

import { readFileSync } from 'node:fs';

// src/ 与 dist/ 都在仓库根下一层，故只需回退一级（`../../` 会跑到仓库外）
const DIR = new URL('../assets/agent-icons/', import.meta.url);
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

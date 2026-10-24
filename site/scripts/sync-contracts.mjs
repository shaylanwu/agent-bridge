/**
 * 构建期把契约真源复制进 site/public/ —— 站点不自己维护第二份契约。
 *
 *   ../../contracts/asyncapi-3.0.yaml          → public/asyncapi-3.0.yaml
 *   ../../contracts/openapi-3.1.yaml           → public/openapi-3.1.yaml
 *   ../../contracts/openapi.control-plane.yaml → public/openapi.control-plane.yaml
 *   ../../llms.txt                             → public/llms.txt
 *
 * 契约漂移由主包的 `npm run contracts:check` 守住，这里只做搬运。
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const root = new URL('../../', import.meta.url);
const contracts = new URL('./contracts/', root);
const pub = new URL('../public/', import.meta.url);
const assets = new URL('./assets/', root);

mkdirSync(pub, { recursive: true });

const files = [
  'asyncapi-3.0.yaml',
  'openapi-3.1.yaml',
  'openapi.control-plane.yaml',
];

for (const f of files) {
  copyFileSync(new URL(f, contracts), new URL(f, pub));
  console.log(`[sync-contracts] ${f}`);
}

// llms.txt：AI 客户端入口（与主包根目录同源）
try {
  const llms = readFileSync(new URL('./llms.txt', root), 'utf8');
  writeFileSync(new URL('llms.txt', pub), llms);
  console.log('[sync-contracts] llms.txt');
} catch {
  console.warn('[sync-contracts] llms.txt not found — skipping');
}

// Agent 品牌图标：从主包 assets/agent-icons/ 同步到 site/src/assets/agents/，
// 首页的 Agent 墙内联渲染（保留各家的官方品牌色）——站点不二次维护图标。
const agentsDst = new URL('../src/assets/agents/', import.meta.url);
mkdirSync(agentsDst, { recursive: true });
let copied = 0;
for (const f of readdirSync(new URL('agent-icons/', assets))) {
  if (!f.endsWith('.svg')) continue;
  copyFileSync(new URL(`agent-icons/${f}`, assets), new URL(f, agentsDst));
  copied++;
}
console.log(`[sync-contracts] ${copied} agent icons → src/assets/agents/`);

console.log(`[sync-contracts] ${files.length} contracts → ${basename(pub.pathname)}/`);

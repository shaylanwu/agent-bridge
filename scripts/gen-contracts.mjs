#!/usr/bin/env node
/**
 * gen-contracts.mjs —— 契约与代码的一致性校验（防漂移）
 *
 * 为什么要有这块：`contracts/*.yaml` 一旦手写，必然与 `src/protocol.ts` 漂移，
 * 而第三方是照着契约实现的 —— 契约说谎比没有契约更糟。
 *
 * 做法：**不生成 YAML**（生成出来的文档没人味），只做**机检**：
 * 从代码里抽出真源清单，再逐条确认契约里有记载。缺一条就红。
 *
 *   node scripts/gen-contracts.mjs          报告
 *   node scripts/gen-contracts.mjs --check  有漂移时 exit 1（CI 用）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

const check = process.argv.includes('--check');
const problems = [];
const notes = [];

// ---------- 从代码抽真源 ----------
const protocol = read('/src/protocol.ts');
const errors = read('/src/core/errors.ts');

/** wire 消息类型：`type: 'hello'` */
const wireTypes = [...new Set([...protocol.matchAll(/type:\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort();

/** 能力清单：PROTOCOL_CAPABILITIES = ['a', 'b', ...] */
const capBlock = /PROTOCOL_CAPABILITIES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(protocol);
const capabilities = capBlock
  ? [...new Set([...capBlock[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]))].sort()
  : [];

/** 受控错误码：BRIDGE_ERROR_CODES = ['a', 'b', ...] */
const codeBlock = /BRIDGE_ERROR_CODES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(errors);
const errorCodes = codeBlock
  ? [...new Set([...codeBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))].sort()
  : [];

if (wireTypes.length < 8) problems.push(`protocol.ts 只解析出 ${wireTypes.length} 个消息类型，疑似结构变更`);
if (capabilities.length === 0) problems.push('protocol.ts 解析不出 PROTOCOL_CAPABILITIES');
if (errorCodes.length === 0) problems.push('core/errors.ts 解析不出 BRIDGE_ERROR_CODES');

// ---------- 契约 ----------
const asyncapi = read('/contracts/asyncapi-3.0.yaml');
const openapi = read('/contracts/openapi-3.1.yaml');

for (const t of wireTypes) {
  if (!asyncapi.includes(`const: ${t}`)) problems.push(`asyncapi 未记载消息类型：${t}`);
}
for (const c of capabilities) {
  if (!asyncapi.includes(c)) problems.push(`asyncapi 未记载能力：${c}`);
}
for (const code of errorCodes) {
  if (!asyncapi.includes(`- ${code}`)) problems.push(`asyncapi 的 ErrorCode 枚举缺少：${code}`);
}

/** 平台必须实现的 HTTP 端点（bridge 作为客户端调用） */
const PLATFORM_ENDPOINTS = [
  '/bridge/authorize',
  '/api/bridge/token',
  '/api/bridge/device-code',
  '/api/bridge/device-token',
];
for (const p of PLATFORM_ENDPOINTS) {
  if (!openapi.includes(`${p}:`)) problems.push(`openapi 未记载平台端点：${p}`);
}

notes.push(`wire 消息 ${wireTypes.length} 个：${wireTypes.join(', ')}`);
notes.push(`capabilities ${capabilities.length} 个：${capabilities.join(', ')}`);
notes.push(`受控错误码 ${errorCodes.length} 个：${errorCodes.join(', ')}`);
notes.push(`平台端点 ${PLATFORM_ENDPOINTS.length} 个`);

// ---------- 输出 ----------
for (const n of notes) console.log(`  ℹ️  ${n}`);
if (problems.length) {
  for (const p of problems) console.log(`  ❌ ${p}`);
  console.log(`⛔ contracts:check 未通过（${problems.length} 处漂移）`);
  process.exit(check ? 1 : 0);
}
console.log('✅ contracts:check 通过（wire 类型 / 能力清单 / 错误码 / 平台端点 与代码一致）');

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

/**
 * 协议版本：`hello.protocolVersion` 的 const 必须等于 `PROTOCOL_VERSION`。
 *
 * 这是最容易漂的一处 —— v2 方案作废后代码回到 1.0，契约里却留着 `const: 2`，
 * 而原来的检查只比对消息名/能力/错误码，字段常量根本没人管。平台如果按契约写成
 * 「protocolVersion === 2 才受理」，会把每一台真实设备都判成版本不兼容。
 */
const codeVersion = /PROTOCOL_VERSION\s*=\s*(\d+)/.exec(protocol);
const contractVersion = /protocolVersion:\s*\{[^}]*const:\s*(\d+)[^}]*\}/.exec(asyncapi);
if (!codeVersion) problems.push('protocol.ts 解析不出 PROTOCOL_VERSION');
if (!contractVersion) problems.push('asyncapi 解析不出 hello.protocolVersion 的 const');
if (codeVersion && contractVersion && codeVersion[1] !== contractVersion[1]) {
  problems.push(
    `asyncapi 的 hello.protocolVersion.const=${contractVersion[1]} 与 PROTOCOL_VERSION=${codeVersion[1]} 不一致`,
  );
}

/**
 * 站点总览页的两张表是**手工维护**的（能力表、受控错误码表），最容易只加代码不加文档：
 * 实测漏过 6 个错误码、13 个能力。这里做存在性检查 —— 不校验措辞，只保证「代码里有的，
 * 两个语种的页面都提到了」，漏项会当场变红。
 */
for (const locale of ['en', 'zh-cn']) {
  const page = read(`/site/src/content/docs/${locale}/protocol/overview.md`);
  for (const capability of capabilities) {
    if (!page.includes(`\`${capability}\``)) problems.push(`site/${locale} 总览页缺少能力：${capability}`);
  }
  for (const code of errorCodes) {
    if (!page.includes(`\`${code}\``)) problems.push(`site/${locale} 总览页缺少错误码：${code}`);
  }
}

notes.push(`wire 消息 ${wireTypes.length} 个：${wireTypes.join(', ')}`);
notes.push(`capabilities ${capabilities.length} 个：${capabilities.join(', ')}`);
notes.push(`受控错误码 ${errorCodes.length} 个：${errorCodes.join(', ')}`);
notes.push(`平台端点 ${PLATFORM_ENDPOINTS.length} 个`);
notes.push(`协议版本 ${codeVersion ? codeVersion[1] : '?'}`);

// ---------- 输出 ----------
for (const n of notes) console.log(`  ℹ️  ${n}`);
if (problems.length) {
  for (const p of problems) console.log(`  ❌ ${p}`);
  console.log(`⛔ contracts:check 未通过（${problems.length} 处漂移）`);
  process.exit(check ? 1 : 0);
}
console.log('✅ contracts:check 通过（wire 类型 / 能力清单 / 错误码 / 平台端点 与代码一致）');

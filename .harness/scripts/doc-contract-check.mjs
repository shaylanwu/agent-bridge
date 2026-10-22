#!/usr/bin/env node
/**
 * doc-contract-check.mjs — 文档与实现一致性硬校验
 *
 * 校验点（任一失败 exit 1）：
 *  1. src/protocol.ts 的每个 wire 消息类型，必须出现在两份 README 中；
 *  2. README 里 run_task 的 json 示例必须带 args 数组（否则平台照抄会被本地拒帧）；
 *  3. cli.ts 支持的命令必须出现在两份 README 的用法段；
 *  4. daemon 未实现必须在两份 README 中标注（代码里是 stub，文档不得暗示可用）；
 *  5. 配置路径口径一致（代码与文档都用 .agent-bridge）。
 *
 * 只做机检得到的东西；语义级核对交给 reviewer checklist。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

const failures = [];
const notes = [];
const fail = (m) => failures.push(m);

const protocol = read('/src/protocol.ts');
const cli = read('/src/cli.ts');
const config = read('/src/config.ts');
const readmes = [
  { name: 'README.md', text: read('/README.md') },
  { name: 'README.zh-CN.md', text: read('/README.zh-CN.md') },
];

// ---------- 1. wire 消息类型 ----------
const wireTypes = [...protocol.matchAll(/type:\s*'([a-z_]+)'/g)].map((m) => m[1]);
const uniqueWire = [...new Set(wireTypes)];
if (uniqueWire.length < 8) fail(`protocol.ts 只解析出 ${uniqueWire.length} 个消息类型，疑似结构变更（预期 ≥8）`);

for (const { name, text } of readmes) {
  const missing = uniqueWire.filter((t) => !text.includes(t));
  if (missing.length) fail(`${name} 缺协议消息类型：${missing.join(', ')}`);
}
notes.push(`协议消息类型 ${uniqueWire.length} 个：${uniqueWire.join(', ')}`);

// ---------- 2. run_task 示例必须带 args ----------
/** 代码块里可能并列多个 JSON 对象（逐行一个），先整体解析，失败再逐行 */
function jsonObjectsOf(block) {
  const whole = block.trim();
  try {
    return [JSON.parse(whole)];
  } catch {
    const out = [];
    for (const line of whole.split('\n')) {
      const t = line.trim().replace(/,$/, '');
      if (!t.startsWith('{') || !t.endsWith('}')) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* 非独立对象：交给上层报错 */
      }
    }
    if (out.length === 0) throw new Error(`无法解析 json 代码块：${whole.slice(0, 60)}…`);
    return out;
  }
}

for (const { name, text } of readmes) {
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  let checked = 0;
  for (const raw of blocks) {
    let objs;
    try {
      objs = jsonObjectsOf(raw);
    } catch (e) {
      fail(`${name} ${e.message}`);
      continue;
    }
    for (const parsed of objs) {
      if (parsed && parsed.type === 'run_task') {
        checked += 1;
        if (!Array.isArray(parsed.args)) {
          fail(`${name} 的 run_task 示例缺 args 数组（平台照此实现会被 assertServerMessage 拒帧；用默认模板请写 "args": []）`);
        }
      }
    }
  }
  if (checked === 0) fail(`${name} 没有 run_task 示例（平台无参考）`);
}

// ---------- 3. CLI 命令覆盖（对外命令清单固定，防止悄悄加/删命令） ----------
const EXPECTED_CMDS = ['connect', 'status', 'logout', 'daemon'];
for (const c of EXPECTED_CMDS) {
  if (!new RegExp(`cmd === '${c}'`).test(cli)) fail(`src/cli.ts 未实现命令 ${c}（README 有记载）`);
}
for (const { name, text } of readmes) {
  const missing = EXPECTED_CMDS.filter((c) => !text.includes(c));
  if (missing.length) fail(`${name} 未记录命令：${missing.join(', ')}`);
}
notes.push(`CLI 命令：${EXPECTED_CMDS.join(', ')}`);

// ---------- 4. daemon 未实现必须标注 ----------
for (const { name, text } of readmes) {
  if (!/daemon/.test(text)) continue;
  const marked =
    /(not implemented|unimplemented|Phase 3)/i.test(text) || /(尚未实现|未实现|规划中|Phase 3)/.test(text);
  if (!marked) fail(`${name} 提到 daemon 但未标注"未实现"（cli.ts 里是 stub，文档不得暗示可用）`);
}

// ---------- 5. 配置路径口径 ----------
if (!config.includes("'.agent-bridge'")) {
  fail("src/config.ts 未使用 '.agent-bridge' 配置目录（与 README / CHANGELOG 口径不一致）");
}
if (/join\(home\(\),\s*'\.bridge'\)/.test(config)) {
  fail("src/config.ts 仍包含 unix 旧路径 ~/.bridge（文档写的是 ~/.agent-bridge）");
}
for (const { name, text } of readmes) {
  if (!text.includes('.agent-bridge')) fail(`${name} 未记录配置路径 .agent-bridge/config.toml`);
}

// ---------- 输出 ----------
for (const n of notes) console.log(`  ℹ️  ${n}`);
if (failures.length) {
  for (const f of failures) console.log(`  ❌ ${f}`);
  console.log(`⛔ doc-contract-check 未通过（${failures.length} 处）`);
  process.exit(1);
}
console.log('✅ doc-contract-check 通过（协议类型/示例报文/命令清单/未实现标注/配置路径）');

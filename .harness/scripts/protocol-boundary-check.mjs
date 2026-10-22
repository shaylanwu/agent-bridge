#!/usr/bin/env node
/**
 * protocol-boundary-check.mjs — 安全与架构边界硬校验（本仓库没有 monorepo 分包，边界是"契约/权限/网络"）
 *
 * 失败（exit 1）项：
 *  1. wire 类型在 protocol.ts 之外重复定义；
 *  2. 出现 shell 字符串执行（exec / execSync）；
 *  3. shell:true 出现在白名单之外的文件；
 *  4. 监听非回环地址；
 *  5. 终端输出完整 device_token（未过 tokenTail）；
 *  6. 适配器读取凭据文件内容；
 *  7. src 内相对导入逃逸出 src（依赖平台侧代码）。
 * 警告（不影响退出码，但必须写进变更方案）：
 *  - runner.ts 直接合并平台 env 而未剔除敏感变量；
 *  - 缺少并发任务上限。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC = join(ROOT, 'src');

const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });

/** 去掉注释后再做模式匹配：注释里提到 shell:true / exec 不算违规 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const files = walk(SRC).map((p) => {
  const code = readFileSync(p, 'utf8');
  return { path: p, rel: relative(ROOT, p).replace(/\\/g, '/'), code, bare: stripComments(code) };
});

const failures = [];
const warnings = [];
const fail = (m) => failures.push(m);
const warn = (m) => warnings.push(m);

// ---------- 1. wire 类型唯一 ----------
const DECLS = [
  { label: 'AgentListItem', re: /(?:export\s+)?interface\s+AgentListItem\b/ },
  { label: 'ClientMessage', re: /(?:export\s+)?type\s+ClientMessage\s*=/ },
  { label: 'ServerMessage', re: /(?:export\s+)?type\s+ServerMessage\s*=/ },
  { label: 'TaskStatus', re: /(?:export\s+)?type\s+TaskStatus\s*=/ },
];
for (const { label, re } of DECLS) {
  const hits = files.filter((f) => re.test(f.bare));
  if (hits.length === 0) fail(`找不到 ${label} 定义（契约类型缺失）`);
  else if (hits.length > 1) fail(`${label} 被重复定义：${hits.map((h) => h.rel).join(', ')}`);
  else if (hits[0].rel !== 'src/protocol.ts') fail(`${label} 定义在 ${hits[0].rel}，只允许在 src/protocol.ts`);
}

for (const f of files) {
  // ---------- 2. 禁止 shell 字符串执行 ----------
  if (/\b(execSync|exec)\(/.test(f.bare) && !/execFileSync/.test(f.bare)) {
    fail(`${f.rel} 使用 exec/execSync（shell 字符串），必须用 execFileSync/spawn + 参数数组`);
  }
  if (/require\(['"]child_process['"]\)/.test(f.bare) && /\bexec\(/.test(f.bare)) {
    fail(`${f.rel} 从 child_process 引入 exec（shell 字符串）`);
  }

  // ---------- 3. shell:true 白名单 ----------
  const shellHits = (f.bare.match(/shell:\s*true/g) ?? []).length;
  if (shellHits > 0 && !['src/runner.ts', 'src/agent-adapters.ts'].includes(f.rel)) {
    fail(`${f.rel} 出现 shell:true（只允许 runner.ts / agent-adapters.ts，且一律经 win-exec.ts）`);
  }

  // ---------- 4. 只绑回环 ----------
  if (/listen\([^)]*(0\.0\.0\.0|['"]::['"])/.test(f.bare)) fail(`${f.rel} 绑定非回环地址（只允许 127.0.0.1）`);
  if (/listen\(/.test(f.bare) && f.rel !== 'src/auth.ts') fail(`${f.rel} 监听端口（唯一允许监听的是 src/auth.ts 的 127.0.0.1 回调）`);

  // ---------- 5. token 脱敏 ----------
  for (const m of f.bare.matchAll(/console\.(log|error|warn)\([^\n]*/g)) {
    const line = m[0];
    if (/deviceToken|device_token/.test(line) && !/tokenTail\(/.test(line)) {
      fail(`${f.rel} 直接输出 device_token（必须经 tokenTail()）`);
    }
  }

  // ---------- 6. 凭据文件不读内容 ----------
  if (f.rel === 'src/agent-adapters.ts' && /readFileSync/.test(f.bare)) {
    fail('src/agent-adapters.ts 出现 readFileSync（凭据只允许 existsSync 判存在）');
  }
  if (/readFileSync\([^)]*(\.credentials|auth\.json|oauth_creds|\.codex|\.claude|\.gemini)/.test(f.bare)) {
    fail(`${f.rel} 试图读取凭据文件内容`);
  }

  // ---------- 7. 不许逃逸 src ----------
  for (const m of f.bare.matchAll(/from\s+'([^']+)'/g)) {
    if (m[1].startsWith('../../')) fail(`${f.rel} 相对导入逃逸出 src：${m[1]}（bridge 不得依赖平台代码）`);
  }
}

// ---------- 警告项 ----------
const runner = files.find((f) => f.rel === 'src/runner.ts');
if (runner) {
  if (/\{\s*\.\.\.process\.env,\s*\.\.\.\(?req\.env/.test(runner.code) && !/NODE_OPTIONS/.test(runner.code)) {
    warn('runner.ts 直接合并平台 env（未剔除 NODE_OPTIONS/PATH 等敏感变量）——见 protocol-contract-rules.md §6');
  }
  if (!/maxConcurrent|concurrency|MAX_TASKS/.test(runner.code)) {
    warn('runner.ts 无并发任务上限（平台可同时下发多个任务）');
  }
}

// ---------- 输出 ----------
for (const w of warnings) console.log(`  ⚠️  ${w}`);
if (failures.length) {
  for (const f of failures) console.log(`  ❌ ${f}`);
  console.log(`⛔ protocol-boundary-check 未通过（${failures.length} 处）`);
  process.exit(1);
}
console.log(`✅ protocol-boundary-check 通过（${warnings.length} 条警告；类型唯一/无 shell 字符串/回环/脱敏/凭据/导入边界）`);

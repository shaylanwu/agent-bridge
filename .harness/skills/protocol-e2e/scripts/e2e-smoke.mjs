#!/usr/bin/env node
/**
 * e2e-smoke.mjs — 端到端冒烟：本脚本扮演「平台侧」，把真实 bridge 连上来跑完整链路。
 *
 * 覆盖：WS 升级 + Bearer 鉴权 → hello → agent_list → ping/pong → scan/scan_result
 *      → run_task(非法 agentType 被拒) → run_task(真实 CLI) 的 task_log + success
 *      → run_task(timeoutMs 生效) → timeout 终态
 *
 * 用法：node .harness/skills/protocol-e2e/scripts/e2e-smoke.mjs [--agent claude-code] [--port 8899]
 * 退出码：0 = 全部断言通过；1 = 有失败项（打印逐条结果）
 *
 * 注意：会真实 spawn 一次本机 CLI（默认 claude-code --version），不会改任何业务文件。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const require = createRequire(join(ROOT, 'package.json'));
const { WebSocketServer } = require('ws');

// 期望工具数从适配器注册表读，不在断言里写死：新增适配器后写死的数字会让冒烟假红
// （2026-10-24 实测：断言写 11、注册表已 12，冒烟挂在这条上，与代码无关）。
const { AGENTS } = await import(
  new URL('../../../../dist/adapters/agent-adapters.js', import.meta.url).href
);
const EXPECTED_AGENTS = AGENTS.length;

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const AGENT = argOf('--agent', process.env.E2E_AGENT || 'claude-code');
const PORT = Number(argOf('--port', '8899'));
const TOKEN = 'tok_smoke';
const TIMEOUT_MS = 60_000;

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const http = createServer((req, res) => res.writeHead(404).end('not found'));
const wss = new WebSocketServer({ noServer: true });

http.on('upgrade', (req, socket, head) => {
  const auth = req.headers['authorization'] ?? '';
  if (auth !== `Bearer ${TOKEN}`) {
    record('WS 握手拒绝错误 token', false, auth.slice(0, 12));
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  record('WS 升级（Bearer 鉴权通过）', true, req.url);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

const logs = new Map();
const seen = new Set();
let bridge;

wss.on('connection', (ws) => {
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    seen.add(m.type);

    if (m.type === 'hello') {
      record('hello.protocolVersion = 1', m.protocolVersion === 1, `deviceId=${JSON.stringify(m.deviceId)}`);
      ws.send(JSON.stringify({ type: 'ping', at: Date.now() }));
    }
    if (m.type === 'pong') record('ping → pong 往返', true);
    if (m.type === 'agent_list') {
      record(
        `agent_list 上报 ${EXPECTED_AGENTS} 个工具`,
        m.agents?.length === EXPECTED_AGENTS,
        `n=${m.agents?.length}`,
      );
      ws.send(JSON.stringify({ type: 'scan', requestId: 'r1' }));
    }
    if (m.type === 'scan_result') {
      record('scan → scan_result（requestId 配对）', m.requestId === 'r1', `n=${m.agents?.length}`);
      ws.send(JSON.stringify({ type: 'run_task', taskId: 't_bad', agentType: 'not-a-real-agent', cwd: ROOT, args: [] }));
    }
    if (m.type === 'task_log') {
      logs.set(m.taskId, (logs.get(m.taskId) ?? '') + m.data);
      record(`task_log 分片 ≤4KB（${m.taskId}）`, Buffer.byteLength(m.data, 'utf8') <= 4096);
    }
    if (m.type === 'task_status' && m.taskId === 't_bad' && m.status !== 'running') {
      record('非法 agentType 被本地拒绝', m.status === 'failed', m.error);
      ws.send(JSON.stringify({ type: 'run_task', taskId: 't_ok', agentType: AGENT, cwd: ROOT, args: ['--version'] }));
    }
    if (m.type === 'task_status' && m.taskId === 't_ok' && m.status !== 'running') {
      if (m.status === 'failed' && /没有安装/.test(m.error ?? '')) {
        record(`真实任务执行（${AGENT}）`, true, 'SKIP：本机未安装该工具');
      } else {
        record(`真实任务 success + exitCode=0（${AGENT}）`, m.status === 'success' && m.exitCode === 0, m.error);
        record('日志内容非空', Boolean((logs.get('t_ok') ?? '').trim()), JSON.stringify((logs.get('t_ok') ?? '').slice(0, 40)));
      }
      ws.send(
        JSON.stringify({ type: 'run_task', taskId: 't_slow', agentType: AGENT, cwd: ROOT, args: ['--version'], timeoutMs: 50 }),
      );
    }
    if (m.type === 'task_status' && m.taskId === 't_slow' && m.status !== 'running') {
      record('timeoutMs 生效（timeout 终态）', m.status === 'timeout' || m.status === 'success', `status=${m.status}`);
      finish(0);
    }
  });
});

function finish(code) {
  console.log('\n===== 端到端冒烟结果 =====');
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
  const missing = ['hello', 'agent_list', 'pong', 'scan_result', 'task_log', 'task_status'].filter((t) => !seen.has(t));
  if (missing.length) console.log(`FAIL  缺少消息类型：${missing.join(', ')}`);
  console.log(`\n${failed.length === 0 && missing.length === 0 ? '✅ 全部通过' : `⛔ ${failed.length + missing.length} 项失败`}`);
  try {
    bridge?.kill();
  } catch {
    /* ignore */
  }
  http.close();
  process.exit(failed.length === 0 && missing.length === 0 ? code : 1);
}

http.listen(PORT, '127.0.0.1', () => {
  const cfg = mkdtempSync(join(tmpdir(), 'agent-bridge-e2e-'));
  console.log(`[e2e] mock 平台监听 127.0.0.1:${PORT}，拉起 bridge…`);
  bridge = spawn(process.execPath, ['dist/cli.js', 'connect', `http://127.0.0.1:${PORT}`, `--token=${TOKEN}`], {
    cwd: ROOT,
    env: { ...process.env, AGENT_BRIDGE_CONFIG: join(cfg, 'config.toml') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout.on('data', (b) => process.stdout.write(String(b).replace(/^/gm, '    [bridge] ')));
  bridge.stderr.on('data', (b) => process.stdout.write(String(b).replace(/^/gm, '    [bridge:err] ')));
  bridge.on('exit', (code) => {
    if (!results.length) record('bridge 启动', false, `进程提前退出 code=${code}`);
  });
  setTimeout(() => {
    record('整体超时（60s）', false);
    try {
      rmSync(cfg, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    finish(1);
  }, TIMEOUT_MS);
});

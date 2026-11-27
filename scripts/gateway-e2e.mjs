#!/usr/bin/env node
/**
 * gateway-e2e.mjs — A2A / ACP 网关端到端冒烟（add-a2a-acp-gateway task 5.1）
 *
 * 与 e2e-smoke 同一套模式：mock 平台 WS + 真实 bridge 进程（真 spawn 一次本机 CLI），
 * 区别是驱动面从 WS 换成**网关 HTTP 表面**：
 *
 * 覆盖：网关默认开（AGENT_BRIDGE_GATEWAY=1）→ agent card 真实能力声明 →
 *      services issue 签发真令牌（全链路鉴权）→ A2A SendMessage（真任务创建）→
 *      GetTask 轮询到终态（COMPLETED + history）→ CancelTask（真 SIGTERM）→
 *      ACP initialize/session/new → session/prompt SSE 流到 end_turn →
 *      未启用网关时 404（反向验证默认关闭）。
 *
 * 交互闭环（permission/form）由 test/gateway-acp.test.ts 以真 store + 真 SSE + dispatch
 * 注入方式覆盖；真 CLI 的 permission 冒烟依赖 ACP 通道工具调用（CodeBuddy），
 * 属后续实测项，不在本脚本硬凑。
 *
 * CLI 选择：不指定 --agent 时**自动挑本机就绪的一个**（首选 codex 等已有模型级实测的工具），
 * 而不是绑死某一个工具的账号状态——绑死的后果是一旦那个工具的订阅/登录态变化，整条链路
 * 会以「断言失败」的形态红掉，掩盖真实回归（2026-11-27 实测：默认 claude-code 因上游订阅 403
 * 出现 5 项失败，换 codex 15/15）。显式 --agent / E2E_AGENT 时不覆盖，只提示探测结果。
 *
 * 用法：node scripts/gateway-e2e.mjs [--agent <kind>] [--port 8890] [--cp-port 8891]
 * 退出码：0 = 全部通过（或 E2E_ALLOW_SKIP=1 时无人就绪而跳过）；1 = 有失败项；
 *         2 = 环境/用法未就绪（无人就绪，或 --agent 写了不存在的 kind）。
 */
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(ROOT, 'package.json'));
const { WebSocketServer } = require('ws');

const { AGENTS, agentDefOf, probeAgent } = await import(
  new URL('../dist/adapters/agent-adapters.js', import.meta.url).href
).catch(() => {
  console.error('[gw-e2e] 找不到 dist/adapters/agent-adapters.js —— 先跑 `npm run build`');
  process.exit(2);
});
const EXPECTED_AGENTS = AGENTS.length;

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
/** 显式指定（--agent 或 E2E_AGENT）为空表示「让脚本自己挑」 */
const EXPLICIT_AGENT = (() => {
  const i = argv.indexOf('--agent');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return (process.env.E2E_AGENT ?? '').trim();
})();
let AGENT = EXPLICIT_AGENT || 'codex';
const PORT = Number(argOf('--port', '8890'));
const CP_PORT = Number(argOf('--cp-port', '8891'));
const ALLOW_SKIP = process.env.E2E_ALLOW_SKIP === '1';
const TOKEN = 'tok_gw_smoke';
const DEVICE_ID = 'bd_0123456789abcdef0123456789abcdef';
// codex 等较慢 CLI 的对话任务单轮可达 60s+，三段任务（A2A 一轮 + cancel + ACP 两轮）需整体放宽
const TIMEOUT_MS = Number(argOf('--timeout', '300000'));

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------- CLI 选择（默认不绑定某一个工具的账号状态） ----------
// 首选顺序：已有「模型推理级」实测记录的工具在前，其余按适配器表顺序补齐。
const PREFERRED_AGENTS = ['codex', 'kimi-code', 'minimax-code', 'agy', 'opencode', 'claude-code'];
/** 环境未就绪时的跳过原因（非空表示本轮没验证任何网关行为） */
let skipReason = '';

function agentPreference() {
  const kinds = AGENTS.map((d) => d.kind);
  return [...PREFERRED_AGENTS.filter((k) => kinds.includes(k)), ...kinds.filter((k) => !PREFERRED_AGENTS.includes(k))];
}

const describeProbe = (item) =>
  [item.status, item.version ? `v${item.version}` : '', item.installedButBroken ? 'installedButBroken' : '', item.credentialSource ?? '']
    .filter(Boolean)
    .join(' ');

/**
 * 选定本轮要真跑的 CLI。
 * - 显式指定：不覆盖（探测只用于提前提示，避免把「换了个工具」误当修复）；
 * - 未指定：按首选顺序探测，用第一个 ready 的；
 * - 无人就绪：E2E_ALLOW_SKIP=1 跳过（exit 0），否则如实失败（exit 2），不假装通过。
 */
async function selectAgent() {
  if (EXPLICIT_AGENT) {
    const def = agentDefOf(EXPLICIT_AGENT);
    if (!def) {
      record(`preflight：显式指定的 ${EXPLICIT_AGENT} 不在适配器表里`, false, `可选：${AGENTS.map((d) => d.kind).join(', ')}`);
      return false;
    }
    const item = await probeAgent(def).catch(() => undefined);
    record(`preflight：按显式指定使用 ${EXPLICIT_AGENT}`, true, item ? describeProbe(item) : '探测失败（仍按指定跑）');
    if (item && item.status !== 'ready') {
      console.log(`  ⚠️  探测为 ${item.status}——继续按指定跑；若是上游订阅/登录问题，失败会以任务错误而非断言形式出现`);
    }
    return true;
  }
  const seen = [];
  for (const kind of agentPreference()) {
    const def = agentDefOf(kind);
    if (!def) continue;
    const item = await probeAgent(def).catch(() => undefined);
    if (!item) continue;
    if (item.status === 'ready' && item.installedButBroken !== true) {
      AGENT = kind;
      record('preflight：自动选用本机就绪的 CLI', true, `${kind} — ${describeProbe(item)}`);
      return true;
    }
    seen.push(`${kind}=${item.status}${item.installedButBroken ? '/broken' : ''}`);
  }
  const detail = `12 个适配器无一 ready：${seen.join(', ')}`;
  if (ALLOW_SKIP) {
    skipReason = detail;
    return false;
  }
  record('preflight：没有就绪的 CLI（设 E2E_ALLOW_SKIP=1 可跳过）', false, detail);
  return false;
}

// ---------- mock 平台（只需要把 bridge 连上：hello → ping；任务全部由网关驱动） ----------
const http = createServer((req, res) => res.writeHead(404).end('not found'));
const wss = new WebSocketServer({ noServer: true });
http.on('upgrade', (req, socket, head) => {
  const auth = req.headers['authorization'] ?? '';
  if (auth !== `Bearer ${TOKEN}`) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'hello') ws.send(JSON.stringify({ type: 'ping', at: Date.now() }));
  });
});

// ---------- 小工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: CP_PORT,
        method,
        path,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text), text });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: undefined, text });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** SSE 收集：until 满足或流结束时 resolve（POST + text/event-stream；可带鉴权头） */
function collectSse(path, body, until, { headers = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: CP_PORT,
        method: 'POST',
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) !== 200) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => reject(new Error(`SSE 状态码 ${res.statusCode}：${Buffer.concat(chunks).toString('utf8')}`)));
          return;
        }
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
          for (;;) {
            const idx = buf.indexOf('\n\n');
            if (idx < 0) break;
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
            const raw = /^data: (.+)$/m.exec(frame)?.[1];
            if (raw !== undefined) {
              try {
                events.push({ event: ev, data: JSON.parse(raw) });
              } catch {
                events.push({ event: ev, data: raw });
              }
            }
          }
          if (until(events)) {
            req.destroy();
            resolve(events);
          }
        });
        res.on('end', () => resolve(events));
      },
    );
    req.on('error', () => resolve(events));
    req.write(payload);
    req.end();
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`SSE 超时（已收 ${events.length} 帧）`));
    }, timeoutMs);
    timer.unref?.();
  });
}
let bridge;
const cfgDir = mkdtempSync(join(tmpdir(), 'agent-bridge-gw-e2e-'));
let issuedToken;

function finish(code) {
  console.log('\n===== 网关端到端冒烟结果 =====');
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
  if (skipReason) {
    console.log(`\n⚠️  跳过：${skipReason}`);
    console.log('   本轮没有验证任何网关行为（E2E_ALLOW_SKIP=1），不要当成通过证据。');
  } else {
    console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `⛔ ${failed.length} 项失败`}`);
  }
  try {
    bridge?.kill();
  } catch {
    /* ignore */
  }
  http.close();
  // 临时目录移到系统临时区（按仓库惯例不 rm）
  try {
    const { renameSync, mkdirSync } = require('node:fs');
    const trash = join(tmpdir(), `agent-bridge-gw-e2e-done-${Date.now()}`);
    mkdirSync(trash, { recursive: true });
    renameSync(cfgDir, join(trash, 'cfg'));
  } catch {
    /* 清理失败不影响结果 */
  }
  if (skipReason) process.exit(0);
  // 退出码语义：2 = 环境/用法未就绪（不掩盖成断言失败），1 = 断言失败，0 = 全过
  if (code === 2) process.exit(2);
  process.exit(failed.length === 0 ? code : 1);
}

const bridgeEnv = (extra = {}) => {
  const env = {
    ...process.env,
    AGENT_BRIDGE_CONFIG: join(cfgDir, 'config.toml'),
    AGENT_BRIDGE_GATEWAY: '1',
    AGENT_BRIDGE_CONTROL_PORT: String(CP_PORT),
    ...extra,
  };
  // CLI 出网代理修正：会话宿主可能注入坏代理（实测 65495 挡死全部 CLI 的 CONNECT），
  // E2E_PROXY 显式指定时覆盖四件套，让 bridge 里的 CLI 走对代理。
  if (process.env.E2E_PROXY) {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      env[key] = process.env.E2E_PROXY;
    }
  }
  return env;
};

// ---------- 主流程 ----------
async function main() {
  // 1. 等控制面就绪（/v1/health 免鉴权）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const h = await call('/v1/health');
      if (h.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  record('控制面就绪（/v1/health）', ready, ready ? `http://127.0.0.1:${CP_PORT}` : '60 次探活失败');

  // 2. 用已签发的真令牌（全链路鉴权，不绕 requireToken）
  const token = issuedToken;
  record('services issue 签发真令牌', Boolean(token), token ? `kid 尾号 …${token.slice(-6)}` : '未解析到 abs_ 令牌');
  if (!token) return finish(1);
  const auth = { authorization: `Bearer ${token}` };

  // 4. agent card：真实能力声明
  const card = await call('/.well-known/agent-card.json');
  const cardBody = card.json ?? {};
  const skills = Array.isArray(cardBody.skills) ? cardBody.skills : [];
  record(
    'agent card：skills 声明全部受管 CLI、streaming=false（只声明已实现）',
    card.status === 200 &&
      skills.length === EXPECTED_AGENTS &&
      cardBody.capabilities?.streaming === false &&
      cardBody.url === `http://127.0.0.1:${CP_PORT}/a2a`,
    `skills=${skills.length}/${EXPECTED_AGENTS}, url=${cardBody.url ?? '-'}`,
  );

  // 5. A2A SendMessage（真 CLI 任务）→ 立即返回 SUBMITTED
  const PROMPT = 'Reply with exactly the single word: OK';
  const send = await call('/a2a', {
    method: 'POST',
    headers: { ...auth, 'A2A-Version': '1.0' },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'gw-e2e-msg-1',
          role: 'ROLE_USER',
          parts: [{ kind: 'text', text: PROMPT }],
          metadata: { agentType: AGENT, cwd: ROOT },
        },
      },
    },
  });
  const sent = send.json ?? {};
  const sentState = sent.result?.status?.state;
  const taskId = sent.result?.id;
  record(
    `A2A SendMessage（${AGENT} 真任务创建）`,
    send.status === 200 && typeof taskId === 'string' && /^TASK_STATE_(SUBMITTED|WORKING)$/.test(String(sentState)),
    `taskId=${taskId}, state=${sentState}`,
  );

  // 5b. SendMessage 幂等：同 messageId 重发拿回同一 task
  const resend = await call('/a2a', {
    method: 'POST',
    headers: { ...auth, 'A2A-Version': '1.0' },
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'message/send',
      params: {
        message: {
          messageId: 'gw-e2e-msg-1',
          role: 'ROLE_USER',
          parts: [{ type: 'text', text: PROMPT }],
          metadata: { agentType: AGENT, cwd: ROOT },
        },
      },
    },
  });
  record(
    'A2A 幂等：同 messageId（0.3 拼写重发）拿回同一 taskId',
    resend.json?.result?.id === taskId && resend.json?.result?.metadata?.idempotentReplay === true,
    `id=${resend.json?.result?.id}`,
  );

    // A2A GetTask 轮询到终态（慢 CLI 单轮 60s+：40 次 × 3s = 120s）
    let final = undefined;
    for (let i = 0; i < 40; i++) {
      const g = await call('/a2a', {
        method: 'POST',
        headers: { ...auth, 'A2A-Version': '1.0' },
        body: { jsonrpc: '2.0', id: 3, method: 'GetTask', params: { id: taskId } },
      });
      const state = g.json?.result?.status?.state;
      if (state === 'TASK_STATE_COMPLETED' || state === 'TASK_STATE_FAILED' || state === 'TASK_STATE_CANCELED') {
        final = g.json?.result;
        break;
      }
      await sleep(3000);
    }
  const history = Array.isArray(final?.history) ? final.history : [];
  // 失败时把任务自带的错误正文带出来：只看 state=FAILED 无法区分「适配器缺陷」与
  // 「上游订阅/登录态问题」，而后者不该被当成网关回归。
  const finalText = (final?.status?.message?.parts ?? [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  record(
    'A2A GetTask：任务到达终态（COMPLETED + history 含 agent 消息）',
    final?.status?.state === 'TASK_STATE_COMPLETED' && history.length > 0,
    `state=${final?.status?.state ?? '-'}, history=${history.length}${finalText ? `, 任务消息=${JSON.stringify(finalText)}` : ''}`,
  );

  // 7. A2A CancelTask：再发一个任务立即取消（真 SIGTERM）
  const send2 = await call('/a2a', {
    method: 'POST',
    headers: { ...auth, 'A2A-Version': '1.0' },
    body: {
      jsonrpc: '2.0',
      id: 4,
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'gw-e2e-msg-2',
          role: 'ROLE_USER',
          parts: [{ kind: 'text', text: 'Count slowly to one hundred' }],
          metadata: { agentType: AGENT, cwd: ROOT },
        },
      },
    },
  });
  const taskId2 = send2.json?.result?.id;
  const cancel = await call('/a2a', {
    method: 'POST',
    headers: { ...auth, 'A2A-Version': '1.0' },
    body: { jsonrpc: '2.0', id: 5, method: 'tasks/cancel', params: { id: taskId2 } },
  });
  record('A2A CancelTask（0.3 拼写）：取消被受理', cancel.status === 200 && cancel.json?.result?.id === taskId2);
  let cancelled = false;
  for (let i = 0; i < 20; i++) {
    const g = await call('/a2a', {
      method: 'POST',
      headers: { ...auth, 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 6, method: 'GetTask', params: { id: taskId2 } },
    });
    if (g.json?.result?.status?.state === 'TASK_STATE_CANCELED') {
      cancelled = true;
      break;
    }
    await sleep(1000);
  }
  record('A2A 取消终态：GetTask 轮询到 TASK_STATE_CANCELED', cancelled);

  // 8. ACP：initialize → session/new → session/prompt（两轮，验证多轮记忆）→ cancel
  const init = await call('/acp', {
    method: 'POST',
    headers: auth,
    body: { jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: 1 } },
  });
  record(
    'ACP initialize：真实能力（loadSession=false、text-only）',
    init.status === 200 &&
      init.json?.result?.protocolVersion === 1 &&
      init.json?.result?.agentCapabilities?.loadSession === false,
  );

  const sn = await call('/acp', {
    method: 'POST',
    headers: auth,
    body: { jsonrpc: '2.0', id: 11, method: 'session/new', params: { cwd: ROOT, _meta: { agentType: AGENT } } },
  });
  const acpSessionId = sn.json?.result?.sessionId;
  record('ACP session/new：会话登记', sn.status === 200 && typeof acpSessionId === 'string', acpSessionId);

  const promptTurn = (text, id) =>
    collectSse(
      '/acp',
      {
        jsonrpc: '2.0',
        id,
        method: 'session/prompt',
        params: { sessionId: acpSessionId, prompt: [{ type: 'text', text }] },
      },
      (events) => events.some((e) => e.event === 'result'),
      { headers: auth, timeoutMs: 150_000 },
    ).catch((error) => {
      record('ACP session/prompt SSE', false, error.message);
      return [];
    });

  // 第一轮：让 CLI 记住暗号
  const acpEvents1 = await promptTurn('Remember the codeword BANANA42. Reply with exactly: OK', 12);
  const result1 = acpEvents1.find((e) => e.event === 'result');
  const firstTaskId = acpEvents1.find((e) => e.event === 'prompt')?.data?.taskId;
  // 失败轮次以 `result` 帧的 error（网关会话终态）出现，不给出这段就只能看到 content=""
  const acpErr = (frame) =>
    frame?.data?.error?.message ? `, error=${JSON.stringify(String(frame.data.error.message).slice(0, 180))}` : '';
  record(
    'ACP prompt 第一轮：SSE 流到终帧（end_turn）',
    result1?.data?.result?.stopReason === 'end_turn',
    `content=${JSON.stringify(String(result1?.data?.result?.content ?? '').slice(0, 24))}${acpErr(result1)}`,
  );
  // 第二轮：问暗号（同一 bridge 会话续接，token 只传增量——conversation 原生续接）
  const acpEvents2 = await promptTurn('What was the codeword I told you? Reply with exactly the codeword.', 13);
  const result2 = acpEvents2.find((e) => e.event === 'result');
  const secondTaskId = acpEvents2.find((e) => e.event === 'prompt')?.data?.taskId;
  const content2 = String(result2?.data?.result?.content ?? '');
  record(
    'ACP 多轮记忆：第二轮续接同一 bridge 会话（同 taskId）',
    secondTaskId === firstTaskId && acpEvents2.find((e) => e.event === 'prompt')?.data?.turn === 'continue',
    `taskId=${secondTaskId}`,
  );
  record(
    'ACP 多轮记忆：第二轮回答引用第一轮内容（含 BANANA42）',
    result2?.data?.result?.stopReason === 'end_turn' && /BANANA42/i.test(content2),
    `content=${JSON.stringify(content2.slice(0, 40))}${acpErr(result2)}`,
  );
  const updateFrames = acpEvents2.filter((e) => e.event === 'update');
  record('ACP update 帧（agent_message_chunk）', updateFrames.length > 0, `n=${updateFrames.length}`);

  // 9. ACP session/cancel：无活动任务 → 静默成功
  const ac = await call('/acp', {
    method: 'POST',
    headers: auth,
    body: { jsonrpc: '2.0', id: 13, method: 'session/cancel', params: { sessionId: acpSessionId } },
  });
  record('ACP session/cancel：无活动轮次静默成功', ac.status === 200 && ac.json?.result?.cancelled === false);

  finish(0);
}

http.listen(PORT, '127.0.0.1', async () => {
  console.log(`[gw-e2e] mock 平台监听 127.0.0.1:${PORT}，先签发令牌再拉起 bridge（网关 @ ${CP_PORT}）…`);
  // 0. 先定 CLI：无人就绪就不必花 2-3 分钟等超时（退出码 2 与断言失败区分）
  const selected = await selectAgent();
  if (!selected) return finish(skipReason ? 0 : 2);
  console.log(`[gw-e2e] 本轮真跑 CLI：${AGENT}`);
  // 令牌先签发（独立 CLI 写 <cfg>/services.toml；bridge 起来后每请求读同一落盘账本）
  const issue = await new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      [
        'dist/cli.js',
        'services',
        'issue',
        '--label=gw-e2e',
        '--scopes=task:create,task:read,task:cancel,task:approve,task:respond,device:read,session:read',
      ],
      { cwd: ROOT, env: bridgeEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    p.stdout.on('data', (b) => (out += String(b)));
    p.stderr.on('data', (b) => (out += String(b)));
    p.on('exit', () => resolve(out));
  });
  issuedToken = /abs_[A-Za-z0-9_-]+/.exec(issue)?.[0];

  bridge = spawn(process.execPath, ['dist/cli.js', 'connect', `http://127.0.0.1:${PORT}`, `--token=${TOKEN}`, `--device-id=${DEVICE_ID}`], {
    cwd: ROOT,
    env: bridgeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout.on('data', (b) => {
    const s = String(b);
    if (/Web 任务面板|控制面|网关|失败|error|refused/i.test(s)) process.stdout.write(s.replace(/^/gm, '    [bridge] '));
  });
  bridge.stderr.on('data', (b) => process.stdout.write(String(b).replace(/^/gm, '    [bridge:err] ')));
  bridge.on('exit', (code) => {
    if (!results.length) record('bridge 启动', false, `进程提前退出 code=${code}`);
  });
  setTimeout(() => {
    record(`整体超时（${Math.round(TIMEOUT_MS / 1000)}s）`, false);
    finish(1);
  }, TIMEOUT_MS);
  void main();
});

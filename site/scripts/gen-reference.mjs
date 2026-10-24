/**
 * 从契约真源生成**静态**参考页（en + zh-cn 两套）。
 *
 * 为什么必须静态生成，而不是只放一个 Scalar 渲染页：
 *   Scalar 是客户端 JS 渲染，Pagefind 索引不到端点名/路径/字段。
 *   静态页才是"API 文档能被全局搜索命中"的载体 —— 两者并存：
 *     · /api/reference、/api/control-plane-reference  静态页（可搜索、可锚点跳转）
 *     · /api、/api/control-plane                      Scalar 交互试请求（可玩）
 *
 * 用法：
 *   node scripts/gen-reference.mjs          写入文件
 *   node scripts/gen-reference.mjs --check  只比对（不写），落后即 exit 1
 */

// 用 `yaml` 而不是 `js-yaml`：js-yaml 会被提到顶层 node_modules，
// 覆盖 Astro 自己依赖的 js-yaml@4（Astro 用的是默认导出），构建期直接崩。
import { parse as load } from 'yaml';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const contracts = new URL('./contracts/', root);
const docs = new URL('../src/content/docs/', import.meta.url);

const CHECK = process.argv.includes('--check');

/* ── 语言与文案 ─────────────────────────────────────────────────── */

const LANGS = ['en', 'zh-cn'];

/** 契约的源语言：决定它的原生描述文字能直接用在哪个 locale（另一个 locale 走 I18N 覆盖表） */
const SOURCE_LANG = { asyncapi: 'zh-cn', platform: 'zh-cn', controlPlane: 'en' };

const T = {
  en: {
    required: 'Required',
    optional: 'Optional',
    fields: 'Fields',
    field: 'Field',
    type: 'Type',
    req: 'Required',
    desc: 'Description',
    example: 'Example',
    requestBody: 'Request body',
    responses: 'Responses',
    params: 'Parameters',
    status: 'Status',
    meaning: 'Meaning',
    method: 'Method',
    path: 'Path',
    summary: 'Summary',
    auth: 'Auth',
    noAuth: 'No token required',
    tokenRequired: 'Bearer service token required',
    endpointIndex: 'Endpoint index',
    generated: 'This page is generated from',
    generatedTail: '— do not edit by hand. Run `npm run build` in `site/` to refresh.',
    schemaRef: 'Schema',
  },
  'zh-cn': {
    required: '必填',
    optional: '可选',
    fields: '字段',
    field: '字段',
    type: '类型',
    req: '必填',
    desc: '说明',
    example: '示例',
    requestBody: '请求体',
    responses: '响应',
    params: '参数',
    status: '状态码',
    meaning: '含义',
    method: '方法',
    path: '路径',
    summary: '摘要',
    auth: '鉴权',
    noAuth: '无需令牌',
    tokenRequired: '需要 Bearer 服务令牌',
    endpointIndex: '端点索引',
    generated: '本页由',
    generatedTail: '生成 —— 请勿手工编辑。在 `site/` 下执行 `npm run build` 会自动刷新。',
    schemaRef: '结构',
  },
};

/* ── 覆盖文案：源语言对不上时的翻译 ─────────────────────────────── */

const MSG_I18N = {
  hello: {
    en: ['Handshake', 'Sent immediately after the WebSocket opens. The platform must implement the handshake rules (protocol version, device token) before anything else.'],
    'zh-cn': ['握手', 'WebSocket 建立后立即发送。平台必须先完成握手（协议版本、设备令牌校验），之后才能下发指令。'],
  },
  agent_list: {
    en: ['Agent inventory', 'The full list of detected agents, sent once after the first connection.'],
    'zh-cn': ['本机 Agent 清单', '探测到的全部 AI Agent，首连后发送一次。'],
  },
  scan_progress: {
    en: ['Scan progress', 'Streaming partial results while a scan is running (only after a `scan` command).'],
    'zh-cn': ['扫描增量', '扫描过程中的流式增量（仅在收到 scan 指令后出现）。'],
  },
  scan_result: {
    en: ['Scan result', 'Terminal response to a `scan` command.'],
    'zh-cn': ['扫描终态', 'scan 指令的最终响应。'],
  },
  task_log: {
    en: ['Task output chunk', 'A chunk of stdout/stderr (each chunk is at most 4096 bytes and never splits a multi-byte character). The bridge redacts home directories and long secrets before sending.'],
    'zh-cn': ['任务输出分片', 'stdout / stderr 分片（每片 ≤ 4096 字节，且不切断多字节字符）。bridge 发送前会做脱敏（家目录 → `~`，长密钥折叠）。'],
  },
  task_status: {
    en: ['Task state', 'State transitions, and the only message that carries terminal results: exit code, controlled error code, and (when enabled) the diff.'],
    'zh-cn': ['任务状态', '状态变更；也是唯一携带终态结果的消息：退出码、受控错误码，以及开启时的 diff。'],
  },
  pong: {
    en: ['Heartbeat reply', 'Reply to `ping`.'],
    'zh-cn': ['心跳应答', '对 ping 的应答。'],
  },
  run_task: {
    en: ['Dispatch a task', 'Platform → bridge. Creates and runs one agent task. Accepts the optional service-identity triple (`requestedBy` / `purpose` / `serviceToken`).'],
    'zh-cn': ['下发任务', '平台 → bridge。创建并执行一个任务；可携带可选的服务身份三件套（requestedBy / purpose / serviceToken）。'],
  },
  cancel_task: {
    en: ['Cancel a task', 'Platform → bridge. Requests cancellation of a running task.'],
    'zh-cn': ['取消任务', '平台 → bridge。请求取消一个运行中的任务。'],
  },
  scan: {
    en: ['Re-scan agents', 'Platform → bridge. Asks the device to re-probe installed agents.'],
    'zh-cn': ['重新扫描工具', '平台 → bridge。请求设备重新探测本机已安装的工具。'],
  },
  ping: {
    en: ['Heartbeat', 'Platform → bridge; the bridge replies with `pong`.'],
    'zh-cn': ['心跳', '平台 → bridge；bridge 回 pong。'],
  },
};

const PLATFORM_I18N = {
  'GET /bridge/authorize': {
    en: ['Browser authorization page', 'The bridge opens this URL in the system browser. Reuse the user’s existing session, then 302 back to `redirect_uri` with `code`.'],
    'zh-cn': ['浏览器授权页', 'bridge 会用系统默认浏览器打开该 URL。复用用户已有登录态，确认后带 `code` 302 回 `redirect_uri`。'],
  },
  'POST /api/bridge/token': {
    en: ['Exchange the authorization code', 'The bridge calls this after receiving `code`. You MUST verify `code_verifier` against the S256 challenge: `base64url(sha256(code_verifier)) === code_challenge`.'],
    'zh-cn': ['用授权码换取 device_token', 'bridge 拿到 `code` 后调用。**必须校验 code_verifier 满足 S256**：`base64url(sha256(code_verifier)) === 之前下发的 code_challenge`。'],
  },
  'POST /api/bridge/device-code': {
    en: ['Request a device code', 'For browserless / SSH environments: hand out a short `user_code` the user confirms elsewhere.'],
    'zh-cn': ['申请设备码', '无浏览器 / SSH 场景：返回一个短码 `user_code`，用户在别处确认。'],
  },
  'POST /api/bridge/device-token': {
    en: ['Poll for the device-code result', 'Returns 4xx while the user has not confirmed (the bridge keeps polling every `interval` seconds until `expires_in`); on success returns the same shape as `/api/bridge/token`.'],
    'zh-cn': ['轮询设备码结果', '用户未确认时返回 4xx（bridge 按 `interval` 持续轮询直到 `expires_in`）；确认后返回与 `/api/bridge/token` 相同的结构。'],
  },
};

/** 控制面契约是英文写的，zh 侧需要翻译 */
const CP_ZH = {
  'GET /v1/health': ['存活 / 就绪 / 版本', '唯一不需要令牌的路由 —— 容器与 CI 探活可直接用。'],
  'GET /v1/capabilities': ['能力清单与端点索引', '与 hello.capabilities 同源。'],
  'GET /v1/agents': ['已安装 AI Agent 及其凭据状态', '`?fresh=true` 触发重新探测。'],
  'POST /v1/agents:scan': ['触发一次全新扫描', '等同 GET /v1/agents?fresh=true。'],
  'GET /v1/tasks': ['任务台账（游标分页）', '用 cursor 而非 offset —— 列表一直在动，offset 会漏会重。'],
  'POST /v1/tasks': ['创建任务', '`Idempotency-Key` 让重试返回同一个 taskId 而不是跑两次。任务走的是与平台任务同一个 TaskSupervisor，因此 `max_tasks` 对两个通道都生效，上行也走同一个 Emitter。'],
  'GET /v1/tasks/{id}': ['任务状态 + 终态产物', '含 diff 与 changedFiles。'],
  'GET /v1/tasks/{id}/events': ['SSE 事件流', '单个任务的日志与状态事件；晚订阅先从有界环形缓冲补发。'],
  'GET /v1/tasks/{id}/diff': ['仅取终态 diff', '不会为了取 diff 重跑任务。'],
  'POST /v1/tasks/{id}:cancel': ['取消任务', '幂等；已终态返回 200 且带 alreadySettled。只有本通道创建的任务可以在此取消 —— 远端平台下发的任务归那个会话所有（409）。取消先 SIGTERM，2 秒后 SIGKILL。'],
};

/* ── 通用工具 ───────────────────────────────────────────────────── */

const oneLine = (s) => (s == null ? '' : String(s).replace(/\s*\n\s*/g, ' ').trim());
const cell = (s) => oneLine(s).replace(/\|/g, '\\|');

function deref(doc, node, depth = 0) {
  if (!node || depth > 8) return node ?? {};
  if (typeof node.$ref === 'string') {
    const p = node.$ref.replace(/^#\//, '').split('/');
    let cur = doc;
    for (const seg of p) cur = cur?.[seg];
    return deref(doc, cur ?? {}, depth + 1);
  }
  return node;
}

function typeName(schema) {
  const s = schema ?? {};
  if (s.$ref) return '`' + String(s.$ref).split('/').pop() + '`';
  if (Array.isArray(s.enum)) return 'enum';
  if (Array.isArray(s.type)) return s.type.join(' \\| ');
  if (s.type === 'array') return 'array';
  if (s.type === 'object') return 'object';
  return String(s.type ?? 'any');
}

function typeDetail(schema) {
  const s = schema ?? {};
  if (Array.isArray(s.enum)) return '`' + s.enum.join('` \\| `') + '`';
  if (Array.isArray(s.type)) return '`' + s.type.join('` \\| `') + '`';
  if (s.type === 'array') {
    const item = s.items ?? {};
    return 'array&lt;' + (item.$ref ? String(item.$ref).split('/').pop() : item.type ?? 'any') + '&gt;';
  }
  if (s.$ref) return '`' + String(s.$ref).split('/').pop() + '`';
  const t = String(s.type ?? 'any');
  if (s.format) return '`' + t + '` (' + s.format + ')';
  if (s.const !== undefined) return '`' + t + '` = `' + s.const + '`';
  return '`' + t + '`';
}

/** 字段表；只有"契约源语言 == 目标语言"时才输出描述，避免中英串味 */
function fieldsTable(schema, lang, sourceLang) {
  const s = schema ?? {};
  const props = s.properties ?? {};
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const names = Object.keys(props);
  if (!names.length) return '';
  const t = T[lang];
  const rows = names.map((n) => {
    const p = props[n] ?? {};
    const desc = sourceLang === lang ? cell(p.description) : '';
    return `| \`${n}\` | ${typeDetail(p)} | ${required.has(n) ? '✓' : ''} | ${desc} |`;
  });
  return `| ${t.field} | ${t.type} | ${t.req} | ${t.desc} |\n| --- | --- | --- | --- |\n${rows.join('\n')}`;
}

/** 从 schema 造一个可读的示例对象（够用即可，不追求穷举） */
function exampleOf(doc, schema, depth = 0) {
  const s = deref(doc, schema);
  if (depth > 4) return '…';
  if (Array.isArray(s.enum)) return s.enum[0];
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  switch (s.type) {
    case 'array':
      return [exampleOf(doc, s.items ?? { type: 'string' }, depth + 1)];
    case 'object': {
      const out = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const vv = deref(doc, v);
        if (Array.isArray(s.required) && !s.required.includes(k) && vv.type !== 'string') continue;
        out[k] = exampleOf(doc, v, depth + 1);
      }
      return out;
    }
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    default:
      return 'string';
  }
}

const anchorId = (key) => 'op-' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ── 渲染：协议消息 ─────────────────────────────────────────────── */

function renderMessages(doc, lang) {
  const t = T[lang];
  const src = SOURCE_LANG.asyncapi;
  const out = [];
  out.push('## Upstream (bridge → platform)');
  out.push(lang === 'en'
    ? 'Messages the device sends up. Everything the bridge sends leaves through a single `Emitter`.'
    : '设备上报的消息。bridge 的所有上行报文都经唯一出口 `Emitter` 发出。');
  for (const [name, def] of Object.entries(doc.channels?.upstream?.messages ?? {})) {
    const ov = MSG_I18N[name];
    const title = ov?.[lang]?.[0] ?? oneLine(def.title);
    const body = ov?.[lang]?.[1] ?? (src === lang ? oneLine(def.description) : '');
    out.push(`<a id="${'msg-' + name}"></a>`);
    out.push(`### ${name}${title ? ` — ${title}` : ''}`);
    if (body) out.push(body);
    out.push(`**${t.fields}**\n`);
    out.push(fieldsTable(def.payload, lang, src));
    const ex = exampleOf(doc, def.payload);
    out.push(`**${t.example}**\n\n\`\`\`json\n${JSON.stringify(ex, null, 2)}\n\`\`\`\n`);
  }
  out.push('## Downstream (platform → bridge)');
  out.push(lang === 'en'
    ? 'Commands the platform sends down. An unknown message type is rejected with a controlled error code, never silently ignored.'
    : '平台下发的指令。未知消息类型会被拒并回受控错误码，不会静默忽略。');
  for (const [name, def] of Object.entries(doc.channels?.downstream?.messages ?? {})) {
    const ov = MSG_I18N[name];
    const title = ov?.[lang]?.[0] ?? oneLine(def.title);
    const body = ov?.[lang]?.[1] ?? (src === lang ? oneLine(def.description) : '');
    out.push(`<a id="${'msg-' + name}"></a>`);
    out.push(`### ${name}${title ? ` — ${title}` : ''}`);
    if (body) out.push(body);
    out.push(`**${t.fields}**\n`);
    out.push(fieldsTable(def.payload, lang, src));
    const ex = exampleOf(doc, def.payload);
    out.push(`**${t.example}**\n\n\`\`\`json\n${JSON.stringify(ex, null, 2)}\n\`\`\`\n`);
  }
  return out.join('\n\n');
}

/**
 * 取文案：优先用覆盖表（与契约源语言不一致时的翻译），否则用契约原生文案。
 * 描述（body）只在契约源语言 == 目标语言时才直用，避免中英串味。
 */
function pickSummary({ key, op, lang, src, dict, zhDict }, withBody = false) {
  const ov = dict?.[key]?.[lang] ?? (lang === 'zh-cn' ? zhDict?.[key] : undefined);
  const summary = ov?.[0] ?? oneLine(op.summary);
  if (!withBody) return summary;
  const body = ov?.[1] ?? (src === lang ? oneLine(op.description) : '');
  return [summary, body];
}

/* ── 渲染：OpenAPI（平台端点 / 控制面）──────────────────────────── */

function renderOpenApi(doc, lang, kind) {
  const t = T[lang];
  const src = SOURCE_LANG[kind];
  const dict = kind === 'platform' ? PLATFORM_I18N : null;
  const zhDict = kind === 'controlPlane' ? CP_ZH : null;
  const isCp = kind === 'controlPlane';
  const out = [];

  const entries = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item ?? {})) {
      if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
      entries.push({ path, method, op });
    }
  }

  const indexRows = entries.map(({ path, method, op }) => {
    const key = `${method.toUpperCase()} ${path}`;
    const summary = pickSummary({ key, op, lang, src, dict, zhDict });
    return `| \`${method.toUpperCase()}\` | [\`${path}\`](#${anchorId(key)}) | ${cell(summary)} |`;
  });
  out.push(
    [
      `## ${t.endpointIndex}`,
      '',
      `| ${t.method} | ${t.path} | ${t.summary} |`,
      '| --- | --- | --- |',
      ...indexRows,
      '',
    ].join('\n'),
  );

  for (const { path, method, op } of entries) {
    const key = `${method.toUpperCase()} ${path}`;
    const [summary, bodyText] = pickSummary({ key, op, lang, src, dict, zhDict }, true);
    out.push(`<a id="${anchorId(key)}"></a>`);
    out.push(`### ${method.toUpperCase()} ${path}`);
    if (summary) out.push(`**${summary}**`);
    if (bodyText) out.push(bodyText);
    if (isCp) {
      const noAuth = Array.isArray(op.security) && op.security.length === 0;
      out.push(`**${t.auth}**：${noAuth ? t.noAuth : t.tokenRequired}  (\`abs_<kid>_<secret>\`)`);
    }

    const params = (op.parameters ?? []).map((p) => deref(doc, p));
    if (params.length) {
      const rows = params.map((p) => {
        const d = src === lang ? cell(p.description) : '';
        return `| \`${p.name}\` | ${p.in} | ${typeDetail(p.schema)} | ${p.required ? '✓' : ''} | ${d} |`;
      });
      out.push(
        [
          `**${t.params}**`,
          '',
          `| ${t.field} | in | ${t.type} | ${t.req} | ${t.desc} |`,
          '| --- | --- | --- | --- | --- |',
          ...rows,
          '',
        ].join('\n'),
      );
    }

    const body = op.requestBody?.content?.['application/json']?.schema;
    if (body) {
      const resolved = deref(doc, body);
      const merged = resolved.allOf
        ? resolved.allOf.reduce((acc, part) => ({ ...acc, ...deref(doc, part) }), {})
        : resolved;
      out.push(`**${t.requestBody}**\n`);
      out.push(fieldsTable(merged, lang, src) + '\n');
      const ex = exampleOf(doc, body);
      out.push(`**${t.example}**\n\n\`\`\`json\n${JSON.stringify(ex, null, 2)}\n\`\`\`\n`);
    }

    const responses = Object.entries(op.responses ?? {}).map(([code, r]) => {
      const rr = deref(doc, r);
      const schema = rr.content?.['application/json']?.schema ?? rr.content?.['application/problem+json']?.schema;
      return { code, desc: (src === lang ? oneLine(rr.description) : '') || '', schema };
    });
    if (responses.length) {
      const rows = responses.map((r) => {
        const refName = r.schema?.$ref ? String(r.schema.$ref).split('/').pop() : '';
        const allOfRef = Array.isArray(r.schema?.allOf) ? r.schema.allOf.map((x) => x.$ref ? String(x.$ref).split('/').pop() : '').filter(Boolean).join(' + ') : '';
        const s = refName || allOfRef ? ` — ${t.schemaRef}: ${refName || allOfRef}` : '';
        return `| \`${r.code}\` | ${cell(r.desc)}${s} |`;
      });
      out.push(
        [`**${t.responses}**`, '', `| ${t.status} | ${t.meaning} |`, '| --- | --- |', ...rows, ''].join(
          '\n',
        ),
      );
      const ok = responses.find((r) => r.code.startsWith('2'));
      if (ok?.schema) {
        const ex = exampleOf(doc, ok.schema);
        out.push(`**${t.example}**\n\n\`\`\`json\n${JSON.stringify(ex, null, 2)}\n\`\`\`\n`);
      }
    }
    out.push('');
  }
  return out.join('\n\n');
}

/* ── 组装页面 ───────────────────────────────────────────────────── */

function page({ title, description, contractFile, body, lang }) {
  const t = T[lang];
  const generatedNote = lang === 'en'
    ? `> ${t.generated} \`contracts/${contractFile}\` ${t.generatedTail}`
    : `> ${t.generated} \`contracts/${contractFile}\` ${t.generatedTail}`;
  return `---
title: ${title}
description: ${oneLine(description)}
---

${generatedNote}

${body}
`;
}

const PAGES = [
  {
    file: 'protocol/messages.md',
    contract: 'asyncapi-3.0.yaml',
    titles: { en: 'Protocol messages', 'zh-cn': '协议消息' },
    descs: {
      en: 'Every message on the WebSocket channel, field by field — generated from the AsyncAPI contract.',
      'zh-cn': 'WebSocket 通道上的全部消息，逐字段说明 —— 由 AsyncAPI 契约生成。',
    },
    render: (doc, lang) => renderMessages(doc, lang),
  },
  {
    file: 'api/reference.md',
    contract: 'openapi-3.1.yaml',
    titles: { en: 'Platform HTTP endpoints', 'zh-cn': '平台 HTTP 端点' },
    descs: {
      en: 'The four HTTP endpoints a platform must implement to drive Agent Bridge Service — generated from the OpenAPI contract.',
      'zh-cn': '平台要驱动 Agent Bridge Service 必须实现的四个 HTTP 端点 —— 由 OpenAPI 契约生成。',
    },
    render: (doc, lang) => renderOpenApi(doc, lang, 'platform'),
  },
  {
    file: 'api/control-plane-reference.md',
    contract: 'openapi.control-plane.yaml',
    titles: { en: 'Local control plane endpoints', 'zh-cn': '本地控制面端点' },
    descs: {
      en: 'Every endpoint of the optional loopback control plane — generated from the OpenAPI contract. Off by default.',
      'zh-cn': '可选的本地回环控制面全部端点 —— 由 OpenAPI 契约生成。默认关闭。',
    },
    render: (doc, lang) => renderOpenApi(doc, lang, 'controlPlane'),
  },
];

let stale = 0;
for (const p of PAGES) {
  const raw = readFileSync(new URL(p.contract, contracts), 'utf8');
  const doc = load(raw);
  for (const lang of LANGS) {
    const text = page({
      title: p.titles[lang],
      description: p.descs[lang],
      contractFile: p.contract,
      body: p.render(doc, lang),
      lang,
    });
    const target = new URL(`${lang}/${p.file}`, docs);
    if (CHECK) {
      let current = null;
      try {
        current = readFileSync(target, 'utf8');
      } catch {
        current = null;
      }
      if (current !== text) {
        stale++;
        console.error(`[gen-reference] stale: ${lang}/${p.file}`);
      }
      continue;
    }
    mkdirSync(dirname(fileURLToPath(target)), { recursive: true });
    writeFileSync(target, text);
    console.log(`[gen-reference] ${lang}/${p.file}`);
  }
}

if (CHECK) {
  if (stale) {
    console.error(`[gen-reference] ${stale} page(s) out of date — run: npm --prefix site run build`);
    process.exit(1);
  }
  console.log('[gen-reference] all generated pages up to date');
}

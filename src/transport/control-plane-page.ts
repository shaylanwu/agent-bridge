/**
 * 控制面内嵌 Web 任务面板 v3（2026-10-25 UI/性能专项）
 *
 * 设计目标：
 *  - 产品化视觉：统一的品牌区、统计卡、任务表、授权页与三类弹窗；
 *  - 弹窗使用 vw/vh 响应式尺寸，支持一键全屏与 Escape 退出；
 *  - 日志不是 JSONL 倾倒：7 族 CLI 事件统一归并成「对话 / 工具 / 系统 / 错误」事件卡，
 *    tool_use 与 tool_result 按 ref 合并；原始 JSON 只作为折叠诊断信息；
 *  - 实时性能：日志缓存有界（600 事件）、搜索/筛选后才全量绘制，增量事件按 revision 更新，
 *    可见窗口默认 120 条；SSE 渲染按 120ms 合帧；后台标签页暂停轮询。
 *
 * 约束不变：零新依赖零构建；数据全部走带鉴权的 /v1/* 端点；
 * 令牌经 ?token= 进入后立刻挪 localStorage 并从地址栏抹除。
 */

const BRAND_LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="10" width="11" height="12" rx="2.5" fill="none" stroke="#1A2029" stroke-width="1.9"/><path d="M15 16h8" stroke="#17A67F" stroke-width="1.9" stroke-linecap="round" fill="none"/><circle cx="27" cy="16" r="2.6" fill="#17A67F"/></svg>';

export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Agent Bridge · 任务面板</title>
<style>
  :root { color-scheme: light; --ink:hsl(216,22%,13%); --muted:hsl(214,14%,49%); --line:hsl(210,13%,90%); --soft:hsl(210,9%,96%); --brand:#17A67F; --brand-high:hsl(164,80%,27%); --brand-low:hsl(158,35%,93%); }
  * { box-sizing: border-box; }
  html,body { margin:0; min-height:100%; }
  body { font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; background:hsl(210,15%,97%); color:var(--ink); }
  button,input { font:inherit; }
  button { cursor:pointer; }
  button:disabled { cursor:not-allowed; opacity:.42; }
  .mono { font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace; }
  .muted { color:var(--muted); }
  .hidden { display:none !important; }

  /* ---------- 品牌与授权 ---------- */
  .brand { display:flex; align-items:center; gap:12px; min-width:0; }
  .brand-mark { width:36px; height:36px; display:flex; align-items:center; justify-content:center; flex:none; }
  .brand-mark svg { width:36px; height:36px; display:block; }
  .brand h1 { margin:0; font-size:19px; font-weight:650; letter-spacing:-.2px; }
  .brand-sub { color:var(--muted); font-size:12px; margin-top:1px; }
  .auth-page { min-height:100vh; display:grid; place-items:center; padding:28px; background:radial-gradient(circle at 50% 10%,#e6f5ef 0,#f7f9fa 48%); }
  .auth-card { width:min(460px,100%); background:#fff; border:1px solid #e2e8f0; border-radius:20px; padding:30px; box-shadow:0 20px 60px rgba(28,46,80,.09); }
  .auth-card .brand { margin-bottom:26px; }
  .eyebrow { font-size:11px; letter-spacing:1.2px; color:var(--brand-high); font-weight:600; margin-bottom:8px; }
  .auth-card h2 { margin:0 0 8px; font-size:23px; letter-spacing:-.4px; }
  .auth-intro { color:var(--muted); margin:0 0 22px; font-size:13px; }
  .field-label { display:block; font-size:12px; font-weight:600; margin:0 0 7px; }
  .token-input { width:100%; border:1px solid #ccd5e1; border-radius:10px; padding:11px 12px; outline:none; background:#fbfcfe; }
  .token-input:focus { border-color:var(--brand); box-shadow:0 0 0 3px var(--brand-low); background:#fff; }
  .primary { width:100%; border:0; border-radius:10px; padding:11px 16px; color:#fff; background:var(--brand); font-weight:600; margin-top:14px; }
  .primary:hover { background:var(--brand-high); }
  .auth-error { display:none; margin:10px 0 0; padding:9px 11px; color:#a32d2d; background:#fff1f1; border:1px solid #f4cccc; border-radius:8px; font-size:12px; }
  .auth-error.on { display:block; }
  .auth-help { margin-top:22px; padding-top:18px; border-top:1px solid var(--line); }
  .auth-help h3 { margin:0 0 7px; font-size:12px; font-weight:600; }
  .auth-help p { color:var(--muted); font-size:12px; margin:5px 0; }
  .command { display:flex; align-items:center; gap:8px; margin-top:10px; background:#f3f6fa; border:1px solid #e2e8f0; border-radius:9px; padding:9px 10px; }
  .command code { flex:1; font-size:11px; overflow-wrap:anywhere; color:#334155; }
  .copy { border:0; background:transparent; color:var(--brand-high); padding:2px 4px; font-size:11px; white-space:nowrap; }
  .auth-foot { margin-top:16px; display:flex; align-items:center; gap:7px; color:#738095; font-size:11px; }
  .lock { width:14px; height:14px; border:1.5px solid #8290a4; border-radius:3px; position:relative; flex:none; }
  .lock:before { content:""; position:absolute; width:7px; height:6px; border:1.5px solid #8290a4; border-bottom:0; border-radius:5px 5px 0 0; left:1.5px; top:-6px; }

  /* ---------- 主面板 ---------- */
  .shell { max-width:1440px; margin:0 auto; padding:26px 30px 38px; }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:18px; margin-bottom:24px; }
  .top-right { display:flex; align-items:center; gap:10px; }
  .env-pill { display:inline-flex; align-items:center; gap:7px; padding:6px 11px; border:1px solid #cde8dc; background:var(--brand-low); color:var(--brand-high); border-radius:999px; font-size:11.5px; }
  .env-dot { width:7px; height:7px; border-radius:50%; background:var(--brand); box-shadow:0 0 0 3px #d7eee4; }
  .version { color:#8792a2; font-size:11px; }
  .stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-bottom:20px; }
  .stat { background:#fff; border:1px solid var(--line); border-radius:14px; padding:16px 18px; position:relative; overflow:hidden; }
  .stat:before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--accent,#8aa0bd); }
  .stat-label { color:var(--muted); font-size:12px; display:flex; justify-content:space-between; }
  .stat-value { font-size:28px; font-weight:650; line-height:1.2; margin-top:5px; font-variant-numeric:tabular-nums; }
  .stat-note { font-size:11px; color:#8b96a6; margin-top:4px; }
  .panel { background:#fff; border:1px solid var(--line); border-radius:15px; overflow:hidden; box-shadow:0 2px 8px rgba(25,42,70,.025); }
  .panel-head { display:flex; justify-content:space-between; align-items:center; padding:17px 20px; border-bottom:1px solid var(--line); }
  .panel-title { font-size:14px; font-weight:650; }
  .panel-desc { color:var(--muted); font-size:11.5px; margin-top:2px; }
  .capacity { font-size:11.5px; color:#5d6b7f; background:#f5f7fa; padding:6px 10px; border-radius:7px; white-space:nowrap; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; }
  th { padding:11px 14px; text-align:left; color:#718096; font-size:11px; font-weight:600; letter-spacing:.15px; background:#fafbfd; border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:13px 14px; border-bottom:1px solid #edf1f5; vertical-align:middle; font-size:12.5px; }
  tbody tr:last-child td { border-bottom:0; }
  tbody tr:hover { background:#fbfcfe; }
  .task-id { color:#334155; font-size:11.5px; }
  .agent { font-weight:550; color:#344258; }
  .state { display:inline-flex; align-items:center; gap:7px; white-space:nowrap; font-size:12px; }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex:none; }
  .st-running { background:#378add; box-shadow:0 0 0 3px #e3f0ff; }
  .st-queued { background:#e69b28; box-shadow:0 0 0 3px #fff3db; }
  .st-success { background:var(--brand); box-shadow:0 0 0 3px var(--brand-low); }
  .st-failed { background:#db4b4b; box-shadow:0 0 0 3px #fde7e7; }
  .st-cancelled { background:#9aa3af; }
  .step-text { display:inline-block; max-width:290px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:middle; color:#4d5a6d; }
  td.step-col { max-width:370px; white-space:nowrap; }
  .elapsed { color:#687386; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .link { border:0; background:transparent; color:var(--brand-high); text-decoration:underline; text-underline-offset:2px; padding:0 0 0 7px; font-size:11.5px; white-space:nowrap; }
  .btn { border:1px solid #d4dce7; background:#fff; color:#3d4b60; border-radius:7px; padding:5px 10px; font-size:11.5px; white-space:nowrap; }
  .btn:hover:not(:disabled) { border-color:#9fb0c4; background:#f8fafc; }
  .empty { text-align:center; padding:44px 20px !important; color:#8a96a6; }

  /* ---------- 弹窗骨架 ---------- */
  .mask { position:fixed; inset:0; z-index:30; display:none; align-items:center; justify-content:center; padding:3vh 3vw; background:rgba(17,28,45,.46); backdrop-filter:blur(3px); }
  .mask.on { display:flex; }
  .mask.full-host { padding:0; }
  .modal { width:min(1180px,90vw); height:min(800px,88vh); background:#fff; border:1px solid rgba(255,255,255,.4); border-radius:17px; box-shadow:0 28px 90px rgba(15,29,50,.24); display:flex; flex-direction:column; overflow:hidden; }
  .modal.timeline { width:min(820px,84vw); }
  .modal.fullscreen { width:100vw; height:100vh; max-width:none; max-height:none; border-radius:0; border:0; }
  .modal-head { flex:none; display:flex; align-items:center; gap:12px; padding:16px 20px; border-bottom:1px solid var(--line); background:#fff; }
  .modal-heading { min-width:0; flex:1; }
  .modal-title { margin:0; font-size:15px; font-weight:650; }
  .modal-sub { margin-top:2px; color:var(--muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .modal-actions { display:flex; align-items:center; gap:7px; flex:none; }
  .icon-btn { border:1px solid #d9e0e9; background:#fff; color:#526174; border-radius:7px; padding:5px 9px; font-size:11px; }
  .icon-btn:hover { background:#f4f7fb; }
  .close-btn { font-size:17px; line-height:1; padding:4px 9px; }
  .tag { display:inline-flex; align-items:center; gap:5px; padding:3px 8px; border-radius:999px; font-size:10.5px; background:#edf4ff; color:#2763b7; white-space:nowrap; }
  .tag.live:before { content:""; width:6px; height:6px; border-radius:50%; background:#378add; }
  .modal-body { flex:1; min-height:0; overflow:hidden; }
  @media (max-width:760px) {
    .shell { padding:18px 14px; }
    .stats { grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
    .topbar { align-items:flex-start; }
    .version { display:none; }
    .mask { padding:1.5vh 1.5vw; }
    .modal,.modal.timeline { width:96vw; height:94vh; border-radius:12px; }
    .step-text { max-width:170px; }
    .hide-small { display:none; }
  }

  /* ---------- 结构化日志 ---------- */
  .log-layout { height:100%; display:flex; flex-direction:column; background:#f6f8fb; }
  .log-toolbar { flex:none; display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:11px 18px; border-bottom:1px solid var(--line); background:#fff; }
  .search { flex:1; min-width:180px; max-width:360px; border:1px solid #d8e0ea; border-radius:8px; padding:7px 10px; outline:none; font-size:12px; }
  .search:focus { border-color:var(--brand); box-shadow:0 0 0 3px var(--brand-low); }
  .chips { display:flex; gap:4px; flex-wrap:wrap; }
  .chip { border:1px solid transparent; background:transparent; color:#66758a; border-radius:7px; padding:5px 9px; font-size:11px; }
  .chip.on { background:var(--brand-low); color:var(--brand-high); border-color:#cde8dc; }
  .follow { display:flex; align-items:center; gap:5px; color:#65748a; font-size:11px; margin-left:auto; }
  .log-summary { flex:none; display:flex; gap:15px; padding:8px 20px; color:#758297; font-size:11px; border-bottom:1px solid #e8edf3; background:#fafbfd; }
  .log-scroll { flex:1; min-height:0; overflow:auto; padding:16px 20px 24px; }
  .log-list { max-width:1120px; margin:0 auto; display:flex; flex-direction:column; gap:9px; }
  .log-more { display:block; margin:0 auto 12px; }
  .event { background:#fff; border:1px solid #e1e7ef; border-radius:11px; padding:11px 13px; display:grid; grid-template-columns:30px minmax(0,1fr); gap:11px; }
  .event.tool { border-left:3px solid var(--brand); }
  .event.message { border-left:3px solid #76a69a; }
  .event.error { border-left:3px solid #db5555; background:#fffdfd; }
  .event.status { border-left:3px solid #9ba8b7; }
  .event.metric { border-left:3px solid #51a58b; }
  .event-icon { width:28px; height:28px; border-radius:8px; display:flex; align-items:center; justify-content:center; background:var(--brand-low); color:var(--brand-high); font-size:10px; font-weight:700; }
  .event.message .event-icon { background:#e9f3f0; color:#417d6d; }
  .event.error .event-icon { background:#fdecec; color:#b63a3a; }
  .event.metric .event-icon { background:#e9f6f1; color:#397c65; }
  .event-main { min-width:0; }
  .event-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .event-title { font-size:12.5px; font-weight:650; color:#2b3b50; }
  .event-time { color:#97a2b0; font-size:10.5px; margin-left:auto; font-variant-numeric:tabular-nums; }
  .event-badge { font-size:10px; color:#65748a; background:#f1f4f8; border-radius:5px; padding:2px 6px; }
  .event-badge.done { color:var(--brand-high); background:var(--brand-low); }
  .event-badge.live { color:#2864ae; background:#eaf2ff; }
  .event-badge.fail { color:#a63838; background:#fdeeee; }
  .event-detail { color:#4b596b; font-size:12px; line-height:1.65; margin-top:6px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .event-code { margin:8px 0 0; max-height:250px; overflow:auto; padding:10px 12px; border-radius:8px; background:#151b26; color:#dce4ef; font:11px/1.6 ui-monospace,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
  .raw-details { margin-top:8px; }
  .raw-details summary { cursor:pointer; color:#8793a3; font-size:10.5px; }
  .raw-details pre { max-height:240px; overflow:auto; padding:9px; background:#f5f7fa; border:1px solid #e5eaf0; border-radius:7px; font:10px/1.55 ui-monospace,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; color:#627083; }

  /* ---------- 时间线与结果 ---------- */
  .timeline-wrap { height:100%; overflow:auto; background:#f7f9fc; padding:18px 22px 24px; }
  .section-title { display:flex; align-items:center; gap:8px; margin:4px 0 12px; font-size:12px; font-weight:650; color:#48576c; }
  .section-count { color:#8390a1; font-weight:400; font-size:11px; }
  .plan-grid { display:grid; gap:8px; margin-bottom:20px; }
  .plan-item { display:flex; align-items:flex-start; gap:10px; padding:11px 12px; background:#fff; border:1px solid #e2e8f0; border-radius:10px; }
  .plan-item .txt { flex:1; font-size:12.5px; }
  .plan-item .state-txt { font-size:10.5px; white-space:nowrap; color:#7b8798; }
  .plan-item.live { border-color:#a9c8ef; background:#f7fbff; }
  .plan-item.done .txt { color:#6c7888; }
  .plan-mark { width:18px; height:18px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex:none; font-size:10px; }
  .done .plan-mark { background:var(--brand-low); color:var(--brand-high); }
  .live .plan-mark { background:#e4efff; color:#2b6abe; }
  .todo .plan-mark { border:1.5px dashed #a3adba; }
  .steps { display:flex; flex-direction:column; }
  .step { display:grid; grid-template-columns:24px minmax(0,1fr); gap:12px; }
  .step-rail { display:flex; flex-direction:column; align-items:center; }
  .step-node { width:20px; height:20px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:11px; flex:none; z-index:1; }
  .step-node.done { background:var(--brand); color:#fff; }
  .step-node.fail { background:#dc5252; color:#fff; }
  .step-node.live { background:#e6f1fb; border:2px solid #378add; }
  .step-node.todo { border:1.5px dashed #a3a19a; }
  .step-line { width:1.5px; background:#d6dde7; flex:1; min-height:12px; }
  .step-card { flex:1; min-width:0; margin-bottom:11px; padding:11px 13px; background:#fff; border:1px solid #e2e8f0; border-radius:10px; }
  .step-card.live { border-color:#a7c8f1; box-shadow:0 2px 8px rgba(55,138,221,.06); }
  .step-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .step-seq { color:#8592a4; font-size:10.5px; }
  .step-action { font-weight:650; font-size:12.5px; color:#314158; }
  .step-status { margin-left:auto; font-size:10.5px; color:#7b899b; }
  .step-label { margin-top:6px; color:#5d6b7f; font:11px/1.6 ui-monospace,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
  .step-time { margin-top:5px; color:#98a3b1; font-size:10.5px; }
  .tabs { flex:none; display:flex; gap:3px; padding:0 18px; border-bottom:1px solid var(--line); background:#fff; }
  .tab { padding:10px 12px; font-size:12px; color:#6c798b; cursor:pointer; border-bottom:2px solid transparent; }
  .tab.on { color:var(--brand-high); border-bottom-color:var(--brand); font-weight:600; }
  .result-body { height:100%; overflow:auto; padding:18px 22px; background:#fbfcfe; }
  .md { max-width:850px; }
  .md h1,.md h2,.md h3 { margin:12px 0 7px; line-height:1.35; }
  .md h1 { font-size:20px; } .md h2 { font-size:17px; } .md h3 { font-size:14px; }
  .md p { margin:7px 0; }
  .md code { background:hsl(158,30%,95%); border-radius:4px; padding:1px 5px; font:11px ui-monospace,Consolas,monospace; }
  .md pre { background:#151b26; color:#e3eaf3; padding:12px 14px; border-radius:9px; overflow:auto; }
  .md pre code { background:none; color:inherit; padding:0; }
  .md ul { margin:7px 0; padding-left:22px; }
  .md a { color:var(--brand-high); }
  .filelist { display:grid; gap:7px; }
  .file-table { display:flex; flex-direction:column; border:1px solid var(--line); border-radius:10px; overflow:hidden; background:#fff; }
  .file-row { display:grid; grid-template-columns:minmax(0,1fr) 86px 86px 76px; gap:12px; align-items:center; padding:10px 12px; border-bottom:1px solid #edf1f5; }
  .file-row:last-child { border-bottom:0; }
  .file-row.head { padding:8px 12px; background:#fafbfd; color:#758297; font-size:11px; }
  .file-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#36516f; font:11px ui-monospace,Consolas,monospace; }
  .file-type { color:#718096; font-size:11px; white-space:nowrap; }
  .file-size { color:#718096; font-size:11px; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .file-preview-head { display:flex; align-items:center; gap:10px; margin-top:16px; padding:11px 12px; background:#fff; border:1px solid var(--line); border-radius:10px; }
  .file-preview-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#36516f; font:11px ui-monospace,Consolas,monospace; }
  .file-preview-meta { margin-left:auto; color:#8290a1; font-size:11px; white-space:nowrap; }
  .file-preview-body { margin-top:10px; min-height:80px; }
  .file-preview-body .code-view { max-height:520px; overflow:auto; }
  .csv-table { width:100%; border-collapse:collapse; background:#fff; font-size:11px; }
  .csv-table th,.csv-table td { padding:7px 9px; border:1px solid #e3e8ef; text-align:left; white-space:pre-wrap; overflow-wrap:anywhere; }
  .csv-table th { background:#f4f7fa; color:#53637a; font-weight:600; }
  .file-note { padding:18px; color:#7c8999; font-size:12px; background:#fff; border:1px dashed #d7e0ea; border-radius:10px; }
  .zoom-mask { position:fixed; inset:0; z-index:60; display:none; align-items:center; justify-content:center; padding:28px; background:rgba(10,18,28,.86); }
  .zoom-mask.on { display:flex; }
  .zoom-mask img { max-width:96vw; max-height:90vh; object-fit:contain; box-shadow:0 18px 70px rgba(0,0,0,.4); }
  .zoom-close { position:absolute; top:18px; right:20px; color:#fff; background:rgba(255,255,255,.12); border-color:rgba(255,255,255,.3); font-size:20px; }
  iframe.preview { width:100%; min-height:440px; border:1px solid var(--line); border-radius:10px; background:#fff; }
  img.preview { max-width:100%; border-radius:10px; border:1px solid var(--line); cursor:zoom-in; }
</style>
</head>
<body>
<!-- 授权页 -->
<div class="auth-page hidden" id="gate">
  <section class="auth-card" aria-labelledby="authTitle">
    <div class="brand"><div class="brand-mark">${BRAND_LOGO}</div><div><h1>Agent Bridge</h1><div class="brand-sub">LOCAL CONTROL PLANE</div></div></div>
    <div class="eyebrow">SECURE ACCESS</div>
    <h2 id="authTitle">连接到任务面板</h2>
    <p class="auth-intro">使用只读服务令牌查看本机任务。令牌仅保存在当前浏览器，不会上传到其他服务。</p>
    <label class="field-label" for="tokenInput">服务令牌</label>
    <input id="tokenInput" class="token-input mono" type="password" placeholder="粘贴 abs_ 开头的令牌" autocomplete="off">
    <div class="auth-error" id="authError">令牌无效或已过期，请检查后重试。</div>
    <button class="primary" id="authSubmit">验证并进入面板</button>
    <div class="auth-help">
      <h3>没有令牌？</h3>
      <p>在终端执行以下命令生成只读令牌；也可以直接打开 serve 打印的带令牌链接。</p>
      <div class="command"><code>agent-bridge services issue --scopes=task:read,device:read</code><button class="copy" id="copyCommand">复制</button></div>
    </div>
    <div class="auth-foot"><span class="lock"></span><span>仅回环访问 · 只读权限 · 可随时清除浏览器存储</span></div>
  </section>
</div>

<!-- 主面板 -->
<div id="board" class="hidden">
  <div class="shell">
    <header class="topbar">
      <div class="brand"><div class="brand-mark">${BRAND_LOGO}</div><div><h1>Agent Bridge 任务面板</h1><div class="brand-sub">本机任务、执行步骤与产物，一处掌握</div></div></div>
      <div class="top-right"><span class="env-pill"><span class="env-dot"></span>已授权 · 只读</span><span class="version">loopback</span></div>
    </header>
    <div class="stats">
      <div class="stat" style="--accent:#378add"><div class="stat-label">执行中</div><div class="stat-value" id="cRunning" style="color:#286fbf">0</div><div class="stat-note">正在调用 Agent</div></div>
      <div class="stat" style="--accent:#e69b28"><div class="stat-label">排队中</div><div class="stat-value" id="cQueued" style="color:#bd7c18">0</div><div class="stat-note">等待执行空位</div></div>
      <div class="stat" style="--accent:var(--brand)"><div class="stat-label">成功</div><div class="stat-value" id="cSuccess" style="color:var(--brand-high)">0</div><div class="stat-note">已完成的任务</div></div>
      <div class="stat" style="--accent:#db4b4b"><div class="stat-label">失败</div><div class="stat-value" id="cFailed" style="color:#bd4141">0</div><div class="stat-note">需要关注的任务</div></div>
    </div>
    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">任务列表</div><div class="panel-desc" id="meta">正在同步本机状态…</div></div><div class="capacity" id="capacity">容量 —</div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>状态</th><th>任务</th><th>工具</th><th>当前步骤</th><th style="text-align:right">耗时</th><th>日志</th><th>结果</th></tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
    </section>
  </div>
</div>

<!-- 日志弹窗 -->
<div class="mask" id="logMask" role="dialog" aria-modal="true" aria-label="任务日志">
  <div class="modal" id="logModal">
    <header class="modal-head">
      <div class="modal-heading"><h2 class="modal-title">执行日志</h2><div class="modal-sub" id="logTitle">—</div></div>
      <span class="tag live hidden" id="logLive">实时接收</span>
      <div class="modal-actions"><button class="icon-btn" id="logFull">全屏</button><button class="icon-btn close-btn" data-close="logMask" aria-label="关闭">×</button></div>
    </header>
    <div class="modal-body log-layout">
      <div class="log-toolbar">
        <input class="search" id="logSearch" placeholder="搜索工具、命令或输出内容">
        <div class="chips" id="logFilters">
          <button class="chip on" data-filter="all">全部</button><button class="chip" data-filter="message">对话</button><button class="chip" data-filter="tool">工具</button><button class="chip" data-filter="system">系统</button><button class="chip" data-filter="error">错误</button>
        </div>
        <label class="follow"><input type="checkbox" id="logFollow" checked>自动跟随</label>
      </div>
      <div class="log-summary"><span id="logCount">0 条事件</span><span id="logTools">0 次工具调用</span><span id="logErrors">0 个错误</span><span id="logTruncated" class="hidden">仅保留最近 600 条</span></div>
      <div class="log-scroll" id="logScroll"><button class="btn log-more hidden" id="logMore">加载更早的事件</button><div class="log-list" id="logEvents"></div></div>
    </div>
  </div>
</div>

<!-- 步骤弹窗 -->
<div class="mask" id="tlMask" role="dialog" aria-modal="true" aria-label="步骤时间线">
  <div class="modal timeline" id="tlModal">
    <header class="modal-head">
      <div class="modal-heading"><h2 class="modal-title">步骤时间线</h2><div class="modal-sub" id="tlTitle">—</div></div>
      <span class="tag" id="tlMeta"></span>
      <div class="modal-actions"><button class="icon-btn" id="tlFull">全屏</button><button class="icon-btn close-btn" data-close="tlMask" aria-label="关闭">×</button></div>
    </header>
    <div class="modal-body"><div class="timeline-wrap" id="tlBody">加载中…</div></div>
  </div>
</div>

<!-- 结果弹窗 -->
<div class="mask" id="rsMask" role="dialog" aria-modal="true" aria-label="任务结果">
  <div class="modal" id="rsModal">
    <header class="modal-head">
      <div class="modal-heading"><h2 class="modal-title">任务结果</h2><div class="modal-sub" id="rsTitle">—</div></div>
      <div class="modal-actions"><button class="icon-btn" id="rsFull">全屏</button><button class="icon-btn close-btn" data-close="rsMask" aria-label="关闭">×</button></div>
    </header>
    <div class="tabs" id="rsTabs"></div>
    <div class="modal-body"><div class="result-body" id="rsBody">加载中…</div></div>
  </div>
</div>

<div class="zoom-mask" id="imageZoom"><button class="icon-btn zoom-close" id="zoomClose" aria-label="关闭原图">×</button><img id="zoomImage" alt="原图预览"></div>

<script>
var token = new URLSearchParams(location.search).get('token') || localStorage.getItem('ab-ui-token') || '';
if (token) {
  localStorage.setItem('ab-ui-token', token);
  if (location.search.indexOf('token=') >= 0) history.replaceState(null, '', location.pathname);
}
var es = null;
var pollTimer = null;
var boardSignature = '';
var boardTasks = [];
var STATE_LABEL = { running:'执行中', queued:'排队中', success:'成功', failed:'失败', cancelled:'已取消' };
function byId(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
var BS = String.fromCharCode(92);
function jsq(s) { return String(s).split(BS).join(BS + BS).split("'").join(BS + "'"); }
function short(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0,n) + '…' : s; }
function fmtMs(a,b) { var s=Math.max(0,Math.round((b-a)/1000)); return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }
function fmtTime(ms) { var d=new Date(ms||Date.now()); return [d.getHours(),d.getMinutes(),d.getSeconds()].map(function(n){return String(n).padStart(2,'0');}).join(':'); }
function stateOf(t) { if(t.status==='running') return t.phase==='queued'?'queued':'running'; if(t.status==='success') return 'success'; if(t.status==='cancelled') return 'cancelled'; return 'failed'; }
function authHeaders() { return token ? {authorization:'Bearer '+token} : {}; }

/* ---------- 弹窗通用行为 ---------- */
function openModal(id) { byId(id).classList.add('on'); document.body.style.overflow='hidden'; }
function closeModal(id) {
  byId(id).classList.remove('on');
  if (!document.querySelector('.mask.on')) document.body.style.overflow='';
  if (id==='logMask' && es) { es.close(); es=null; }
}
function toggleFull(modalId,buttonId) {
  var full=byId(modalId).classList.toggle('fullscreen');
  byId(modalId).closest('.mask').classList.toggle('full-host',full);
  byId(buttonId).textContent=full?'退出全屏':'全屏';
}
byId('logFull').onclick=function(){toggleFull('logModal','logFull');};
byId('tlFull').onclick=function(){toggleFull('tlModal','tlFull');};
byId('rsFull').onclick=function(){toggleFull('rsModal','rsFull');};
Array.prototype.forEach.call(document.querySelectorAll('[data-close]'),function(b){b.onclick=function(){closeModal(b.getAttribute('data-close'));};});
Array.prototype.forEach.call(document.querySelectorAll('.mask'),function(m){m.onclick=function(e){if(e.target===m)closeModal(m.id);};});
document.addEventListener('keydown',function(e){
  if(e.key!=='Escape') return;
  var full=document.querySelector('.modal.fullscreen');
  if(full) { full.classList.remove('fullscreen'); full.closest('.mask').classList.remove('full-host'); var map={logModal:'logFull',tlModal:'tlFull',rsModal:'rsFull'}; byId(map[full.id]).textContent='全屏'; return; }
  var open=document.querySelector('.mask.on'); if(open) closeModal(open.id);
});

/* ---------- 授权 ---------- */
function showGate(invalid) {
  byId('board').classList.add('hidden');
  byId('gate').classList.remove('hidden');
  byId('authError').classList.toggle('on',invalid===true);
  setTimeout(function(){byId('tokenInput').focus();},0);
}
function saveToken() {
  var v=byId('tokenInput').value.trim(); if(!v) return;
  token=v; localStorage.setItem('ab-ui-token',v); byId('authError').classList.remove('on'); boot();
}
byId('authSubmit').onclick=saveToken;
byId('tokenInput').addEventListener('keydown',function(e){if(e.key==='Enter')saveToken();});
byId('copyCommand').onclick=function(){
  var cmd='agent-bridge services issue --scopes=task:read,device:read';
  if(navigator.clipboard) navigator.clipboard.writeText(cmd);
  byId('copyCommand').textContent='已复制'; setTimeout(function(){byId('copyCommand').textContent='复制';},1200);
};

/* ---------- 主面板：变化才重绘，耗时单独更新 ---------- */
function signatureOf(data) {
  return JSON.stringify({c:data.counts,cap:data.capacity,t:data.tasks.map(function(t){return [t.taskId,t.status,t.phase,t.queuePosition,t.stepCount,t.currentStep,t.error,t.settledAt];})});
}
function stepCell(t) {
  var text;
  if(t.status==='running'&&t.phase==='queued') text='<span class="muted">第 '+(t.queuePosition||'-')+' 位 · 等待空位</span>';
  else if(t.status==='running') text=t.currentStep?'#'+t.currentStep.seq+' '+esc(t.currentStep.action)+(t.currentStep.label?' '+esc(t.currentStep.label):''):'<span class="muted">等待首个步骤事件</span>';
  else if(t.status==='success') text=t.stepCount>0?'完成 · 共 '+t.stepCount+' 步':'完成';
  else text='<span style="color:#a32d2d">'+esc(t.error||'失败')+'</span>';
  var tl=(t.phase!=='queued'&&(t.stepCount>0||t.status==='running'))?'<button class="link" onclick="openTl(\\''+jsq(t.taskId)+'\\')">预览完整步骤</button>':'';
  return '<span class="step-text">'+text+'</span>'+tl;
}
function renderBoard(data,force) {
  boardTasks=data.tasks||[];
  var c=data.counts,cap=data.capacity;
  byId('cRunning').textContent=c.running; byId('cQueued').textContent=c.queued; byId('cSuccess').textContent=c.success; byId('cFailed').textContent=c.failed;
  byId('capacity').textContent='容量 '+cap.running+' / '+cap.maxTasks+' · 排队 '+cap.queued;
  byId('meta').textContent='共 '+boardTasks.length+' 个任务 · 每 2 秒同步 · 仅更新变化内容';
  var sig=signatureOf(data);
  if(force||sig!==boardSignature) {
    var now=Date.now();
    var rows=boardTasks.slice().reverse().map(function(t){
      var st=stateOf(t),from=t.startedAt||t.createdAt,to=t.settledAt||now;
      var logBtn=st==='queued'?'<button class="btn" disabled>日志</button>':'<button class="btn" onclick="openLog(\\''+jsq(t.taskId)+'\\','+(t.status==='running')+')">'+(t.status==='running'?'实时日志':'查看日志')+'</button>';
      var rsBtn=t.status==='running'?'<button class="btn" disabled>结果</button>':'<button class="btn" onclick="openRs(\\''+jsq(t.taskId)+'\\')">查看结果</button>';
      return '<tr><td><span class="state"><span class="dot st-'+st+'"></span>'+STATE_LABEL[st]+'</span></td>'+
        '<td class="task-id mono" title="'+esc(t.taskId)+'">'+esc(t.taskId)+'</td><td class="agent">'+esc(t.agentType)+'</td>'+
        '<td class="step-col">'+stepCell(t)+'</td>'+
        '<td class="elapsed mono" data-from="'+from+'" data-to="'+(t.settledAt||0)+'">'+fmtMs(from,to)+'</td>'+
        '<td>'+logBtn+'</td><td>'+rsBtn+'</td></tr>';
    });
    byId('rows').innerHTML=rows.join('')||'<tr><td colspan="7" class="empty">暂无任务。平台或本机服务下发任务后，会在这里实时出现。</td></tr>';
    boardSignature=sig;
  }
  updateElapsed();
}
function updateElapsed() {
  var now=Date.now();
  Array.prototype.forEach.call(document.querySelectorAll('[data-from]'),function(el){
    var from=Number(el.getAttribute('data-from')),to=Number(el.getAttribute('data-to'))||now;
    el.textContent=fmtMs(from,to);
  });
}
function poll() {
  if(document.hidden) return;
  fetch('/v1/board',{headers:authHeaders()}).then(function(r){
    if(r.status===401){showGate(true);return null;}
    if(!r.ok) throw new Error('board '+r.status);
    return r.json();
  }).then(function(data){if(data)renderBoard(data,false);}).catch(function(){});
}

/* ---------- 结构化日志模型 ---------- */
var LOG_MAX=600,LOG_PAGE=120;
var log={taskId:'',live:false,buffer:'',events:[],byRef:{},seq:0,filter:'all',search:'',follow:true,limit:LOG_PAGE,renderedIds:[],renderedRevs:{},timer:null,dropped:false};
function resetLog(taskId,live) {
  log={taskId:taskId,live:live,buffer:'',events:[],byRef:{},seq:0,filter:'all',search:'',follow:true,limit:LOG_PAGE,renderedIds:[],renderedRevs:{},timer:null,dropped:false};
  byId('logSearch').value=''; byId('logFollow').checked=true;
  Array.prototype.forEach.call(byId('logFilters').children,function(c){c.classList.toggle('on',c.getAttribute('data-filter')==='all');});
}
function textOf(v,depth) {
  if(v==null||depth>4)return '';
  if(typeof v==='string')return v;
  if(typeof v==='number'||typeof v==='boolean')return String(v);
  if(Array.isArray(v))return v.map(function(x){return textOf(x,depth+1);}).filter(Boolean).join('\\n');
  if(typeof v==='object') {
    var keys=['text','content','output','aggregated_output','stdout','stderr','answer','result','message','error'];
    for(var i=0;i<keys.length;i++){var k=keys[i];if(v[k]!=null){var s=textOf(v[k],depth+1);if(s)return s;}}
  }
  return '';
}
function inputSummary(v) {
  if(v==null)return '';
  if(typeof v==='string')return short(v,500);
  if(typeof v!=='object')return String(v);
  var keys=['command','cmd','pattern','file_path','path','filePath','file','query','url','name','todos','plan','input'];
  for(var i=0;i<keys.length;i++){var k=keys[i];if(v[k]!=null){var val=v[k];var s=typeof val==='string'?val:(k==='todos'?'更新 '+val.length+' 项待办':JSON.stringify(val));return short(s,500);}}
  var first=Object.keys(v)[0]; return first?short(first+': '+textOf(v[first],0),500):'';
}
function evt(kind,title,detail,state,ref,raw,at) {
  return {id:++log.seq,kind:kind,title:title,detail:short(detail||'',8000),state:state||'done',ref:ref,raw:raw||'',at:at||Date.now(),rev:1};
}
function rawOf(o) { try{return short(JSON.stringify(o,null,1),16000);}catch(e){return String(o);} }
function atOf(o) { return o.timestampMs||o.timestamp||o.at||o.time||Date.now(); }
function pushEvent(e) {
  if(e.kind==='metric') {
    var old=log.byRef.__metric;
    if(old){old.detail=e.detail;old.raw=e.raw;old.at=e.at;old.rev++;return;}
    log.byRef.__metric=e;
  }
  if(e.ref&&log.byRef[e.ref]) {
    var cur=log.byRef[e.ref];
    cur.state=e.state||cur.state;
    if(e.detail)cur.detail=e.detail;
    if(e.raw)cur.raw=(cur.raw?cur.raw+'\\n\\n--- 结果 ---\\n':'')+e.raw;
    cur.at=e.at; cur.rev++;
    if(e.state==='error')cur.kind='error';
    return;
  }
  log.events.push(e);
  if(e.ref)log.byRef[e.ref]=e;
  if(log.events.length>LOG_MAX){var removed=log.events.splice(0,50);log.dropped=true;removed.forEach(function(x){if(x.ref&&log.byRef[x.ref]===x)delete log.byRef[x.ref];});}
}
function toolEvent(name,input,state,ref,raw,at) {
  return evt('tool',name,inputSummary(input),state||'live',ref,raw,at);
}
function statusEvent(title,detail,raw,at,state) { return evt('status',title,detail,state||'done',null,raw,at); }
function errorEvent(title,detail,ref,raw,at) { return evt('error',title,detail,'error',ref,raw,at); }

/* 7 族 CLI 事件 → 统一事件卡。tool_use/tool_result 按 ref 合并，不重复占行。 */
function consumeObject(o) {
  var type=o.type||'',raw=rawOf(o),at=atOf(o),msg=o.message||{},content=msg.content;
  if(type==='assistant'&&Array.isArray(content)) {
    content.forEach(function(b){
      if(b.type==='tool_use')pushEvent(toolEvent(b.name,b.input,'live',b.id,raw,at));
      else if(b.type==='text'&&textOf(b.text))pushEvent(evt('message','Agent',b.text,'done',null,raw,at));
    }); return;
  }
  if(type==='user'&&Array.isArray(content)) {
    content.forEach(function(b){if(b.type==='tool_result')pushEvent(evt(b.is_error?'error':'tool','工具结果',textOf(b.content||b.output),b.is_error?'error':'done',b.tool_use_id,raw,at));}); return;
  }
  if(type==='result') {
    if(o.is_error||o.subtype==='error')pushEvent(errorEvent('执行失败',textOf(o.result||o.error),null,raw,at));
    else pushEvent(statusEvent('执行完成',textOf(o.result),raw,at,'done')); return;
  }
  if(type==='system') {
    if(o.subtype==='init')pushEvent(statusEvent('会话已启动',o.model||o.qodercli_version||o.version||'',raw,at));
    else if(o.estimated_tokens!=null||o.estimated_tokens_delta!=null)pushEvent(evt('metric','模型用量','思考 token：'+(o.estimated_tokens||0)+(o.estimated_tokens_delta?'（+'+o.estimated_tokens_delta+'）':''),'done',null,raw,at));
    return;
  }
  if(type==='thread.started'){pushEvent(statusEvent('会话已启动','',raw,at));return;}
  if(type==='turn.started'){pushEvent(statusEvent('开始本轮执行','',raw,at));return;}
  if(type==='turn.completed'||type==='turn.failed'){pushEvent(statusEvent('本轮执行结束','',raw,at,type==='turn.failed'?'error':'done'));return;}
  if(type.indexOf('item.')===0) {
    var item=o.item||{};
    if(item.type==='agent_message'&&type==='item.completed'){pushEvent(evt('message','Agent',textOf(item.text||item.content),'done',null,raw,at));return;}
    if(item.type==='reasoning')return;
    if(item.type==='tool_call') {
      var call=item.toolCall||{};
      if(type==='item.started')pushEvent(toolEvent(call.name,call.input,'live',call.id,raw,at));
      else if(type==='item.completed')pushEvent(evt(call.error?'error':'tool',call.name||'工具结果',textOf(call.output)||inputSummary(call.input),call.error?'error':'done',call.id,raw,at));
      return;
    }
    if(type==='item.started'||type==='item.completed') {
      pushEvent(toolEvent(item.type,item, type==='item.started'?'live':(item.exit_code===0?'done':'error'),item.id,raw,at));
      if(type==='item.completed')pushEvent(evt(item.exit_code?'error':'tool',item.type,textOf(item.output||item.aggregated_output),item.exit_code?'error':'done',item.id,raw,at));
      return;
    }
  }
  if(type==='exec.started'){pushEvent(statusEvent('会话已启动','',raw,at));return;}
  if(type==='exec.completed') {
    var result=o.result||{},out=textOf(result.output||result.answer);
    if(out)pushEvent(statusEvent('执行完成',out,raw,at,result.status==='failed'?'error':'done'));return;
  }
  if(type==='tool_use'&&o.part) {
    var part=o.part,st=part.state||{};
    pushEvent(toolEvent(part.tool,st.input,st.status==='error'?'error':'done',part.callID,raw,at));
    if(st.output)pushEvent(evt(st.status==='error'?'error':'tool',part.tool,st.output,st.status==='error'?'error':'done',part.callID,raw,at));
    return;
  }
  if(type==='text'&&o.part){pushEvent(evt('message','Agent',textOf(o.part.text),'done',null,raw,at));return;}
  if(type==='step_start'||type==='step_finish'){pushEvent(statusEvent(type==='step_start'?'开始步骤':'步骤结束','',raw,at));return;}
  if(type==='tool_use') {
    pushEvent(toolEvent(o.tool_name||o.name,o.parameters||o.args||o.input,'live',o.tool_id||o.id,raw,at));return;
  }
  if(type==='tool_result') {
    pushEvent(evt(o.status==='error'||o.isError===true||o.is_error===true?'error':'tool','工具结果',textOf(o.output||o.result),o.status==='error'||o.isError===true||o.is_error===true?'error':'done',o.tool_id||o.id||o.callId,raw,at));return;
  }
  if(type==='message') {
    if(o.role==='assistant'&&textOf(o.content))pushEvent(evt('message','Agent',textOf(o.content),'done',null,raw,at));
    return;
  }
  if(o.role==='assistant') {
    if(textOf(o.content))pushEvent(evt('message','Agent',textOf(o.content),'done',null,raw,at));
    (o.tool_calls||[]).forEach(function(call){
      var fn=call.function||{},input=fn.arguments;
      try{input=JSON.parse(input);}catch(e){}
      pushEvent(toolEvent(fn.name,input,'live',call.id,raw,at));
    }); return;
  }
  if(o.role==='tool'){pushEvent(evt('tool','工具结果',textOf(o.content),'done',o.tool_call_id,raw,at));return;}
  if(type==='session'){pushEvent(statusEvent('会话已启动','',raw,at));return;}
  if(type==='status') {
    if(o.phase==='turn_end'&&o.reason&&o.reason.kind==='error')pushEvent(errorEvent('执行失败',textOf(o.reason.error),null,raw,at));
    return;
  }
  if(type==='tool_call') {
    pushEvent(toolEvent(o.name||o.tool,o.arguments||o.input||o.args,'live',o.callId,raw,at));return;
  }
  if(type==='final'){pushEvent(statusEvent('执行完成',textOf(o.text),raw,at));return;}
  if(type==='error'){pushEvent(errorEvent('执行错误',textOf(o.error||o.message),null,raw,at));return;}
  pushEvent(evt('status',type||'系统事件',textOf(o.text||o.message), 'done',null,raw,at));
}
function ingestLine(line) {
  line=line.trim(); if(!line)return;
  try{var o=JSON.parse(line);if(o&&typeof o==='object'){consumeObject(o);return;}}catch(e){}
  pushEvent(evt('plain','输出',line,'done',null,line,Date.now()));
}
function ingestLog(data) {
  log.buffer+=data;
  if(log.buffer.length>262144)log.buffer=log.buffer.slice(-131072);
  var idx;
  while((idx=log.buffer.indexOf('\\n'))>=0){var line=log.buffer.slice(0,idx);log.buffer=log.buffer.slice(idx+1);ingestLine(line);}
  scheduleLog();
}
function eventMatches(e) {
  if(log.filter==='error'&&e.kind!=='error'&&e.state!=='error')return false;
  if(log.filter==='tool'&&e.kind!=='tool')return false;
  if(log.filter==='message'&&e.kind!=='message')return false;
  if(log.filter==='system'&&['tool','message','error'].indexOf(e.kind)>=0)return false;
  if(log.search&&(e.title+' '+e.detail).toLowerCase().indexOf(log.search)<0)return false;
  return true;
}
function eventHtml(e) {
  var badge=e.state==='live'?'<span class="event-badge live">进行中</span>':e.state==='error'?'<span class="event-badge fail">失败</span>':'<span class="event-badge done">完成</span>';
  var icon=e.kind==='tool'?'TOOL':e.kind==='message'?'AI':e.kind==='error'?'ERR':e.kind==='metric'?'STAT':'SYS';
  var detail=e.detail?(e.kind==='tool'||e.kind==='plain'?'<pre class="event-code">'+esc(e.detail)+'</pre>':'<div class="event-detail">'+esc(e.detail)+'</div>'):'';
  var raw=e.raw?'<details class="raw-details"><summary>查看原始事件（调试用）</summary><pre>'+esc(e.raw)+'</pre></details>':'';
  return '<article class="event '+e.kind+'" data-eid="'+e.id+'"><div class="event-icon">'+icon+'</div><div class="event-main"><div class="event-head"><span class="event-title">'+esc(e.title)+'</span>'+badge+'<span class="event-time">'+fmtTime(e.at)+'</span></div>'+detail+raw+'</div></article>';
}
function sameIds(a,b){if(a.length!==b.length)return false;for(var i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
function renderLog() {
  log.timer=null;
  var filtered=log.events.filter(eventMatches),visible=filtered.slice(-log.limit),ids=visible.map(function(e){return e.id;});
  var full=!sameIds(ids,log.renderedIds);
  if(full) {
    byId('logEvents').innerHTML=visible.map(eventHtml).join('')||'<div class="empty">当前筛选条件下没有事件。</div>';
    log.renderedRevs={};
  } else {
    visible.forEach(function(e){if(log.renderedRevs[e.id]!==e.rev){var el=document.querySelector('[data-eid="'+e.id+'"]');if(el)el.outerHTML=eventHtml(e);}});
  }
  visible.forEach(function(e){log.renderedRevs[e.id]=e.rev;});log.renderedIds=ids;
  byId('logMore').classList.toggle('hidden',filtered.length<=log.limit);
  byId('logCount').textContent=log.events.length+' 条事件'+(filtered.length!==log.events.length?' · 筛选后 '+filtered.length:'');
  byId('logTools').textContent=log.events.filter(function(e){return e.kind==='tool';}).length+' 次工具调用';
  byId('logErrors').textContent=log.events.filter(function(e){return e.kind==='error'||e.state==='error';}).length+' 个错误';
  byId('logTruncated').classList.toggle('hidden',!log.dropped);
  if(log.follow)byId('logScroll').scrollTop=byId('logScroll').scrollHeight;
}
function scheduleLog(){if(log.timer)return;log.timer=setTimeout(renderLog,120);}
function openLog(taskId,live) {
  resetLog(taskId,live);
  byId('logTitle').textContent=taskId+' · 结构化事件视图（工具调用与结果自动合并）';
  byId('logLive').classList.toggle('hidden',!live);
  byId('logEvents').innerHTML='<div class="empty">正在接收事件…</div>';
  openModal('logMask');
  if(es)es.close();
  es=new EventSource('/v1/tasks/'+encodeURIComponent(taskId)+'/events?token='+encodeURIComponent(token));
  es.onmessage=function(ev){
    try{var m=JSON.parse(ev.data);
      if(m.type==='task_log')ingestLog(m.data);
      else if(m.type==='task_status'&&m.status!=='running')pushEvent(evt(m.status==='success'?'status':'error','任务'+(STATE_LABEL[m.status]||m.status),m.error||m.result||'','done',null,rawOf(m),Date.now()));
    }catch(e){}
  };
  es.onerror=function(){};
}
byId('logSearch').addEventListener('input',function(){log.search=this.value.trim().toLowerCase();log.limit=LOG_PAGE;log.renderedIds=[];scheduleLog();});
Array.prototype.forEach.call(byId('logFilters').children,function(c){c.onclick=function(){log.filter=c.getAttribute('data-filter');log.limit=LOG_PAGE;log.renderedIds=[];Array.prototype.forEach.call(byId('logFilters').children,function(x){x.classList.toggle('on',x===c);});scheduleLog();};});
byId('logFollow').onchange=function(){log.follow=this.checked;if(log.follow)byId('logScroll').scrollTop=byId('logScroll').scrollHeight;};
byId('logMore').onclick=function(){log.limit+=LOG_PAGE;log.renderedIds=[];scheduleLog();};

/* ---------- 步骤时间线 ---------- */
function openTl(taskId) {
  byId('tlTitle').textContent=taskId;
  byId('tlMeta').textContent='加载中';
  byId('tlBody').innerHTML='<div class="empty">正在读取步骤…</div>';
  openModal('tlMask');
  fetch('/v1/tasks/'+encodeURIComponent(taskId)+'/steps',{headers:authHeaders()}).then(function(r){return r.json();}).then(function(d){
    byId('tlMeta').textContent=(STATE_LABEL[stateOf(d)]||d.status)+' · '+(d.stepCount||0)+' 步';
    var html='';
    if(Array.isArray(d.plan)&&d.plan.length) {
      var done=d.plan.filter(function(p){return p.state==='completed';}).length;
      html+='<div class="section-title">执行待办 <span class="section-count">'+done+' / '+d.plan.length+' 已完成</span></div><div class="plan-grid">';
      html+=d.plan.map(function(p){var cls=p.state==='completed'?'done':p.state==='in_progress'?'live':'todo';var mark=p.state==='completed'?'✓':p.state==='in_progress'?'…':'';var txt=p.state==='completed'?'已完成':p.state==='in_progress'?'执行中':'待做';return '<div class="plan-item '+cls+'"><span class="plan-mark">'+mark+'</span><span class="txt">'+esc(p.text)+'</span><span class="state-txt">'+txt+'</span></div>';}).join('');
      html+='</div>';
    }
    html+='<div class="section-title">实际执行步骤 <span class="section-count">逐步追加</span></div><div class="steps">';
    html+=(d.steps||[]).map(function(s,i){
      var cls=s.state==='started'?'live':s.ok===false?'fail':'done',node=cls==='live'?'':cls==='fail'?'×':'✓';
      var when=s.state==='finished'&&s.finishedAt?fmtMs(s.at,s.finishedAt):fmtMs(s.at,Date.now());
      return '<div class="step"><div class="step-rail"><span class="step-node '+cls+'">'+node+'</span>'+(i<d.steps.length-1||d.status==='running'?'<span class="step-line"></span>':'')+'</div><div class="step-card '+cls+'"><div class="step-top"><span class="step-seq">#'+s.seq+'</span><span class="step-action">'+esc(s.action)+'</span><span class="step-status">'+(s.state==='started'?'进行中':s.ok===false?'失败':'完成')+'</span></div>'+(s.label?'<div class="step-label">'+esc(s.label)+'</div>':'')+'<div class="step-time">'+when+'</div></div></div>';
    }).join('');
    if(d.status==='running')html+='<div class="step"><div class="step-rail"><span class="step-node todo"></span></div><div class="step-card"><div class="step-top"><span class="step-action muted">后续步骤由模型实时规划</span></div><div class="step-time">没有预定义总步数，出现即追加</div></div></div>';
    html+='</div>';
    byId('tlBody').innerHTML=html;
  }).catch(function(){byId('tlBody').innerHTML='<div class="empty">步骤读取失败，请稍后重试。</div>';});
}

/* ---------- 结果查看 ---------- */
function miniMd(src) {
  var out=[],inCode=false;
  esc(src).split('\\n').forEach(function(line){
    if(line.slice(0,3)==='\`\`\`'){out.push(inCode?'</code></pre>':'<pre><code>');inCode=!inCode;return;}
    if(inCode){out.push(line+'\\n');return;}
    var h=line.match(/^(#{1,3})\\s+(.*)$/);if(h){out.push('<h'+h[1].length+'>'+inlineMd(h[2])+'</h'+h[1].length+'>');return;}
    if(/^\\s*[-*]\\s+/.test(line)){out.push('<ul><li>'+inlineMd(line.replace(/^\\s*[-*]\\s+/,''))+'</li></ul>');return;}
    if(line.trim()===''){out.push('');return;}out.push('<p>'+inlineMd(line)+'</p>');
  });
  if(inCode)out.push('</code></pre>');
  return out.join('\\n').replace(/<\\/ul>\\n<ul>/g,'');
}
function inlineMd(s){return s.replace(/\`([^\`]+)\`/g,'<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>').replace(/\\[([^\\]]+)\\]\\((https?:[^)]+)\\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');}
function diffHtml(src){return esc(src).split('\\n').map(function(l){if(l.slice(0,4)==='diff'||l.slice(0,3)==='---'||l.slice(0,3)==='+++')return '<span class="diff-hd">'+l+'</span>';if(l[0]==='+')return '<span class="diff-add">'+l+'</span>';if(l[0]==='-')return '<span class="diff-del">'+l+'</span>';return l+'\\n';}).join('');}
var rsData=null;
function openRs(taskId) {
  rsData={taskId:taskId,steps:null,diff:null};
  byId('rsTitle').textContent=taskId;
  byId('rsTabs').innerHTML='';byId('rsBody').innerHTML='<div class="empty">正在读取任务产物…</div>';
  openModal('rsMask');
  Promise.all([
    fetch('/v1/tasks/'+encodeURIComponent(taskId)+'/steps',{headers:authHeaders()}).then(function(r){return r.json();}),
    fetch('/v1/tasks/'+encodeURIComponent(taskId)+'/diff',{headers:authHeaders()}).then(function(r){return r.ok?r.json():{};})
  ]).then(function(arr){
    rsData.steps=arr[0];rsData.diff=arr[1];
    var tabs=[['answer','最终回答'],['diff','变更 diff'],['files','文件 ('+((rsData.diff.changedFiles||[]).length)+')']];
    byId('rsTabs').innerHTML=tabs.map(function(t){return '<span class="tab" data-tab="'+t[0]+'" onclick="rsTab(\\''+t[0]+'\\')">'+t[1]+'</span>';}).join('');rsTab('answer');
  });
}
function rsTab(tab) {
  Array.prototype.forEach.call(byId('rsTabs').children,function(el){el.classList.toggle('on',el.getAttribute('data-tab')===tab);});
  var body=byId('rsBody');
  if(tab==='answer') {
    var t=rsData.steps&&rsData.steps.finalText;
    body.innerHTML=t?'<div class="md">'+miniMd(t)+'</div>':'<div class="empty">该任务没有提取到最终回答文本。</div>';
  } else if(tab==='diff') {
    var d=rsData.diff&&rsData.diff.diff;
    body.innerHTML=d?'<pre class="code-view">'+diffHtml(d)+'</pre>':'<div class="empty">无 diff 产物（任务未开启 captureDiff，或工作目录无改动）。</div>';
  } else {
    var files=(rsData.diff&&rsData.diff.changedFiles)||[];
    if(!files.length){body.innerHTML='<div class="empty">无变更文件清单。</div>';return;}
    body.innerHTML='<div class="file-table"><div class="file-row head"><div>文件</div><div>类型</div><div style="text-align:right">大小</div><div></div></div>'+files.map(function(f,i){var ext=fileExt(f);return '<div class="file-row"><div class="file-name" title="'+esc(f)+'">'+esc(f)+'</div><div class="file-type">'+esc(fileTypeLabel(ext))+'</div><div class="file-size" data-file-size="'+i+'">—</div><button class="btn" onclick="previewFile(\\''+jsq(f)+'\\','+i+')">预览</button></div>';}).join('')+'</div><div id="filePreview" class="file-preview-body"><div class="empty">正在读取第一个文件…</div></div>';
    files.forEach(function(f,i){loadFileMeta(f,i);});
    previewFile(files[0],0);
  }
}
function fileExt(rel){var p=rel.split('.');return p.length>1?p.pop().toLowerCase():'';}
function fileTypeLabel(ext){
  var names={md:'Markdown',markdown:'Markdown',html:'HTML',htm:'HTML',png:'PNG 图片',jpg:'JPEG 图片',jpeg:'JPEG 图片',gif:'GIF 图片',webp:'WebP 图片',svg:'SVG 图片',json:'JSON',csv:'CSV',tsv:'TSV',pdf:'PDF',docx:'Word 文档',xlsx:'Excel 工作簿',pptx:'PowerPoint 演示文稿',txt:'文本',log:'日志',js:'JavaScript',ts:'TypeScript',tsx:'TSX',jsx:'JSX',py:'Python',go:'Go',rs:'Rust',java:'Java',c:'C',cpp:'C++',h:'C/C++ 头文件',css:'CSS',scss:'SCSS',yaml:'YAML',yml:'YAML',toml:'TOML',ini:'INI',cfg:'配置',conf:'配置',sh:'Shell',bash:'Shell',sql:'SQL',xml:'XML',vue:'Vue',svelte:'Svelte'};
  return names[ext]||ext.toUpperCase()||'文件';
}
function formatBytes(n){if(!Number.isFinite(n)||n<0)return '—';if(n<1024)return n+' B';if(n<1024*1024)return (n/1024).toFixed(1)+' KB';return (n/1024/1024).toFixed(1)+' MB';}
function loadFileMeta(rel,index){
  fetch('/v1/tasks/'+encodeURIComponent(rsData.taskId)+'/file?path='+encodeURIComponent(rel)+'&token='+encodeURIComponent(token),{method:'HEAD',headers:authHeaders()})
    .then(function(r){if(!r.ok)throw new Error('meta');var el=document.querySelector('[data-file-size="'+index+'"]');if(el)el.textContent=formatBytes(Number(r.headers.get('content-length')));})
    .catch(function(){var el=document.querySelector('[data-file-size="'+index+'"]');if(el)el.textContent='—';});
}
function previewKind(ext){
  if(['png','jpg','jpeg','gif','webp','svg'].indexOf(ext)>=0)return 'image';
  if(['html','htm'].indexOf(ext)>=0)return 'html';
  if(ext==='pdf')return 'pdf';
  if(['docx','xlsx','pptx'].indexOf(ext)>=0)return 'office';
  if(ext==='md'||ext==='markdown')return 'md';
  if(ext==='json')return 'json';
  if(ext==='csv'||ext==='tsv')return 'csv';
  if(['txt','log','js','ts','tsx','jsx','py','go','rs','java','c','cpp','h','css','scss','yaml','yml','toml','ini','cfg','conf','sh','bash','sql','xml','vue','svelte'].indexOf(ext)>=0)return 'text';
  return 'unsupported';
}
function previewFile(rel,index){
  var url='/v1/tasks/'+encodeURIComponent(rsData.taskId)+'/file?path='+encodeURIComponent(rel)+'&token='+encodeURIComponent(token);
  var ext=fileExt(rel),kind=previewKind(ext),box=byId('filePreview');
  box.innerHTML='<div class="file-preview-head"><span class="file-preview-name" title="'+esc(rel)+'">'+esc(rel)+'</span><span class="file-preview-meta">'+esc(fileTypeLabel(ext))+'</span><a class="btn" href="'+url+'" download>下载</a></div><div class="file-preview-body" id="filePreviewBody"><div class="empty">正在加载预览…</div></div>';
  var body=byId('filePreviewBody');
  if(kind==='image'){body.innerHTML='<img class="preview" src="'+url+'" alt="'+esc(rel)+'" onclick="openImageZoom(\\''+jsq(url)+'\\')">';return;}
  if(kind==='pdf'){body.innerHTML='<iframe class="preview" src="'+url+'" type="application/pdf" title="PDF 预览"></iframe>';return;}
  if(kind==='office'){
    fetch(url+'&render=1',{headers:authHeaders()}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();}).then(function(html){
      body.innerHTML='';var ifr=document.createElement('iframe');ifr.className='preview';ifr.setAttribute('sandbox','');ifr.title='Office 内容预览';body.appendChild(ifr);ifr.srcdoc=html;
    }).catch(function(e){body.innerHTML='<div class="file-note">Office 内容预览失败：'+esc(e.message)+'。可点击「下载」查看原文件。</div>';});
    return;
  }
  if(kind==='unsupported'){body.innerHTML='<div class="file-note">此格式暂不支持在线预览，请点击「下载」后用本地应用打开。</div>';return;}
  fetch(url,{headers:authHeaders()}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();}).then(function(text){
    if(kind==='html'){
      body.innerHTML='';var ifr=document.createElement('iframe');ifr.className='preview';ifr.setAttribute('sandbox','');ifr.title='HTML 预览';body.appendChild(ifr);ifr.srcdoc=text;return;
    }
    if(kind==='md'){body.innerHTML='<div class="md">'+miniMd(text)+'</div>';return;}
    if(kind==='json'){
      var pretty=text;try{pretty=JSON.stringify(JSON.parse(text),null,2);}catch(e){}
      body.innerHTML='<pre class="code-view">'+esc(pretty)+'</pre>';return;
    }
    if(kind==='csv'){
      var lines=text.split(/\\r?\\n/).filter(function(x){return x.trim()!=='';}).slice(0,80);
      body.innerHTML='<div style="overflow:auto"><table class="csv-table">'+lines.map(function(line,i){var cells=(ext==='tsv'?line.split('\t'):line.split(','));return '<tr>'+cells.map(function(c){return '<'+(i===0?'th':'td')+'>'+esc(c)+'</'+(i===0?'th':'td')+'>';}).join('')+'</tr>';}).join('')+'</table></div>';return;
    }
    body.innerHTML='<pre class="code-view">'+esc(text)+'</pre>';
  }).catch(function(e){body.innerHTML='<div class="file-note">预览加载失败：'+esc(e.message)+'。可点击「下载」查看原文件。</div>';});
}

byId('zoomClose').onclick=function(){byId('imageZoom').classList.remove('on');};
byId('imageZoom').onclick=function(e){if(e.target===this)this.classList.remove('on');};

function openImageZoom(url){byId('zoomImage').src=url;byId('imageZoom').classList.add('on');}
function boot() {
  if(!token){showGate(false);return;}
  byId('gate').classList.add('hidden');byId('board').classList.remove('hidden');
  if(pollTimer)clearInterval(pollTimer);
  poll();pollTimer=setInterval(poll,2000);
}
boot();
</script>
</body>
</html>
`;

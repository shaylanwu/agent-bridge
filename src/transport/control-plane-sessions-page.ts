/**
 * Minimal session console (local control plane).
 * No data is embedded: the shell loads /v1/sessions and /v1/sessions/{id} with the operator token.
 */
export const SESSIONS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sessions · Agent Bridge</title>
<style>
:root{--bg:#f4f6f9;--card:#fff;--ink:#17212b;--muted:#66758a;--line:#dbe2ea;--brand:#2f6fed;--danger:#c0392b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:2;display:flex;gap:12px;align-items:center;padding:12px 20px;background:#fff;border-bottom:1px solid var(--line)}
header h1{margin:0;font-size:16px}header .grow{flex:1}
input,button{font:inherit;border:1px solid var(--line);border-radius:8px;padding:7px 10px;background:#fff;color:var(--ink)}
button{cursor:pointer}button.primary{background:var(--brand);border-color:var(--brand);color:#fff}
main{display:grid;grid-template-columns:320px minmax(0,1fr);gap:16px;padding:16px;max-width:1400px;margin:0 auto}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.panel h2{margin:0;padding:10px 12px;font-size:13px;color:var(--muted);border-bottom:1px solid var(--line);background:#fafbfd}
#list{max-height:calc(100vh - 150px);overflow:auto}
.sess{padding:10px 12px;border-bottom:1px solid #eef2f6;cursor:pointer}.sess:hover{background:#f5f8ff}
.sess .id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.sess .meta{display:flex;gap:8px;color:var(--muted);font-size:12px;margin-top:4px;flex-wrap:wrap}
.badge{padding:1px 7px;border-radius:999px;background:#eef2f7;color:#46566b;font-size:11px}
.badge.running{background:#e8f1ff;color:#1f5fce}.badge.success{background:#e8f7ee;color:#1f7a45}.badge.failed{background:#fdeceb;color:#b03a2e}
#detail{padding:12px;min-height:300px}
pre{margin:0;background:#0f1720;color:#dbe7f3;padding:12px;border-radius:10px;overflow:auto;max-height:36vh;font:12px/1.5 ui-monospace,Consolas,monospace}
#events{max-height:34vh;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px;background:#fbfcfe;margin-top:10px}
.ev{padding:6px;border-bottom:1px dashed #e5ebf2;font:12px/1.4 ui-monospace,Consolas,monospace;white-space:pre-wrap}
.muted{color:var(--muted)}.err{color:var(--danger)}
#gate{display:none;position:fixed;inset:0;background:rgba(15,23,32,.45);align-items:center;justify-content:center;padding:20px}
#gate .box{background:#fff;border-radius:14px;padding:22px;max-width:460px;width:100%}
#gate h2{margin:0 0 8px;font-size:17px}#gate p{margin:0 0 14px;color:var(--muted)}
#gate input{width:100%;margin-bottom:10px}
@media(max-width:840px){main{grid-template-columns:1fr}#list{max-height:38vh}}
</style>
</head>
<body>
<header><h1>Sessions</h1><span class="muted" id="count"></span><span class="grow"></span>
<button id="refresh">刷新</button><a href="/" style="color:var(--brand);text-decoration:none">任务面板</a></header>
<main>
  <section class="panel"><h2>持久会话</h2><div id="list"><div class="muted" style="padding:12px">加载中…</div></div></section>
  <section class="panel"><h2 id="title">会话详情</h2><div id="detail"><div class="muted">选择左侧会话</div></div></section>
</main>
<div id="gate"><div class="box"><h2>需要本机控制面令牌</h2><p>令牌仅保存在本浏览器 localStorage，不会写入页面或 URL。</p>
<input id="token" type="password" placeholder="abs_ 开头的服务令牌" autocomplete="off"><button class="primary" id="save">继续</button></div></div>
<script>
var token=localStorage.getItem('ab-ui-token')||'';
var sessions=[],current=null,es=null;
function $(id){return document.getElementById(id)}
function auth(){return token?{authorization:'Bearer '+token}:{}}
function gate(on){$('gate').style.display=on?'flex':'none';if(on)setTimeout(function(){$('token').focus()},0)}
$('save').onclick=function(){var v=$('token').value.trim();if(!v)return;token=v;localStorage.setItem('ab-ui-token',v);gate(false);load()};
$('token').addEventListener('keydown',function(e){if(e.key==='Enter')$('save').click()});
$('refresh').onclick=load;
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function badge(s){return '<span class="badge '+(esc(s)||'')+'">'+esc(s)+'</span>'}
function render(){var h='';sessions.forEach(function(s){
  h+='<div class="sess" data-id="'+esc(s.sessionId)+'"><div class="id">'+esc(s.sessionId)+'</div>'+
     '<div class="meta">'+badge(s.status)+badge(s.phase)+'<span>'+esc(s.agentType)+'</span><span>'+esc(s.mode)+'</span></div>'+
     '<div class="meta"><span>'+esc(s.updatedAt)+'</span><span>seq '+esc(s.latestEventSeq==null?'-':s.latestEventSeq)+'</span></div></div>';
});$('list').innerHTML=h||'<div class="muted" style="padding:12px">暂无会话</div>';$('count').textContent=sessions.length+' 个';}
$('list').addEventListener('click',function(e){var row=e.target.closest('.sess');if(!row)return;open(row.getAttribute('data-id'))});
function load(){if(!token){gate(true);return}
 fetch('/v1/sessions?limit=100',{headers:auth()}).then(function(r){if(r.status===401||r.status===403)throw new Error('unauthorized');if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
 .then(function(d){sessions=d.sessions||[];render()}).catch(function(err){if(err.message==='unauthorized'){gate(true);return}$('list').innerHTML='<div class="err" style="padding:12px">'+esc(err.message)+'</div>'})}
function open(id){current=id;if(es){es.close();es=null}
 $('title').textContent=id;$('detail').innerHTML='<div class="muted">加载中…</div>';
 fetch('/v1/sessions/'+encodeURIComponent(id),{headers:auth()}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
 .then(function(s){$('detail').innerHTML='<pre>'+esc(JSON.stringify(s,null,2))+'</pre><div class="muted" style="margin:10px 0 0">实时事件</div><div id="events"></div>';subscribe(id,s.latestEventSeq||0)})
 .catch(function(err){$('detail').innerHTML='<div class="err">'+esc(err.message)+'</div>'})}
function subscribe(id,after){var box=$('events');es=new EventSource('/v1/sessions/'+encodeURIComponent(id)+'/events?afterEventSeq='+encodeURIComponent(after)+'&token='+encodeURIComponent(token));
 function push(kind,data){var el=document.createElement('div');el.className='ev';el.textContent=kind+'  '+JSON.stringify(data);box.appendChild(el);box.scrollTop=box.scrollHeight}
 es.addEventListener('event',function(e){push('event',JSON.parse(e.data))});
 es.addEventListener('wire',function(e){push('wire',JSON.parse(e.data))});
 es.addEventListener('done',function(e){push('done',JSON.parse(e.data));es.close();es=null});
 es.onerror=function(){/* browser auto-retries; keep UI quiet */};
}
if(token)load();else gate(true);
</script>
</body></html>`;

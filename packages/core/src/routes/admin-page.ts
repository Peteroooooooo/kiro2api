/**
 * The admin page: one self-contained HTML document (no external assets, so it
 * works on hosts without internet access). The page script must not contain
 * backticks or dollar-brace sequences because it lives in a template literal.
 */

export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kiro2api 后台</title>
<style>
:root {
  --bg: #f5f6f8; --panel: #ffffff; --text: #1d2129; --muted: #6b7280; --line: #e5e7eb;
  --accent: #2563eb; --accent-text: #ffffff; --ok: #15803d; --warn: #b45309; --bad: #b91c1c;
  --chip-ok: #dcfce7; --chip-warn: #fef3c7; --chip-bad: #fee2e2; --bar: #e5e7eb; --row-hover: #f9fafb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111318; --panel: #1a1d24; --text: #e5e7eb; --muted: #9ca3af; --line: #2b303b;
    --accent: #3b82f6; --accent-text: #ffffff; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171;
    --chip-ok: #14532d; --chip-warn: #78350f; --chip-bad: #7f1d1d; --bar: #2b303b; --row-hover: #20242c;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 20px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 16px; }
h1 { font-size: 20px; margin: 0; font-weight: 650; }
h2 { font-size: 15px; margin: 0 0 12px; font-weight: 600; }
.spacer { flex: 1; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.stats { display: flex; flex-wrap: wrap; gap: 8px; }
.stat { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.stat b { color: var(--text); }
input, textarea, select { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line);
  border-radius: 6px; padding: 7px 9px; }
textarea { width: 100%; min-height: 120px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
button { font: inherit; border: 1px solid var(--line); background: var(--panel); color: var(--text);
  border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button.danger { color: var(--bad); }
button:disabled { opacity: .5; cursor: default; }
.tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--line); }
.tab { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 6px 12px; color: var(--muted); }
.tab.active { color: var(--text); border-bottom-color: var(--accent); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.row label { color: var(--muted); min-width: 72px; }
.row input { flex: 1; min-width: 200px; }
.hint { color: var(--muted); font-size: 12px; margin: 6px 0 0; }
.login-box { margin-top: 12px; padding: 12px; border: 1px dashed var(--line); border-radius: 8px; }
.code { font: 600 26px/1.2 ui-monospace, Consolas, monospace; letter-spacing: 3px; margin: 6px 0; }
.msg { margin-top: 10px; white-space: pre-wrap; word-break: break-word; }
.msg.ok { color: var(--ok); } .msg.bad { color: var(--bad); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; min-width: 900px; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
td .sub { color: var(--muted); font-size: 12px; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; }
.chip.ok { background: var(--chip-ok); color: var(--ok); }
.chip.cooling { background: var(--chip-warn); color: var(--warn); }
.chip.disabled { background: var(--chip-bad); color: var(--bad); }
.bar { height: 6px; border-radius: 3px; background: var(--bar); overflow: hidden; margin-top: 4px; width: 120px; }
.bar i { display: block; height: 100%; background: var(--accent); }
.actions { display: flex; gap: 4px; flex-wrap: wrap; }
.actions button { padding: 3px 8px; font-size: 12px; }
.empty { color: var(--muted); padding: 16px 0; text-align: center; }
#auth { max-width: 420px; margin: 80px auto; }
.conn { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; align-items: center; }
.conn-label { color: var(--muted); }
.conn-value { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
.conn-value code { font: 13px/1.4 ui-monospace, Consolas, monospace; background: var(--bg); border: 1px solid var(--line);
  border-radius: 6px; padding: 4px 8px; word-break: break-all; }
.conn-value button { padding: 3px 10px; font-size: 12px; }
.models { display: flex; flex-wrap: wrap; gap: 4px; }
.models span { font: 12px ui-monospace, Consolas, monospace; padding: 1px 6px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); }
@media (max-width: 640px) { .conn { grid-template-columns: 1fr; } }
.nav { display: flex; gap: 4px; }
.nav button { border: none; background: none; padding: 6px 12px; color: var(--muted); }
.nav button.active { background: var(--panel); color: var(--text); box-shadow: 0 0 0 1px var(--line); }
.panel-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }
.panel-head h2 { margin: 0; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.seg button { border: none; border-radius: 0; padding: 5px 12px; background: var(--panel); color: var(--muted); }
.seg button + button { border-left: 1px solid var(--line); }
.seg button.active { background: var(--accent); color: var(--accent-text); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.card .k { color: var(--muted); font-size: 12px; }
.card .v { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 2px; }
.card .s { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.filters input[type=search] { min-width: 220px; flex: 1; max-width: 320px; }
.filters label.chk { color: var(--muted); display: inline-flex; gap: 4px; align-items: center; }
table.logs { min-width: 1100px; }
table.logs th, table.logs td { padding: 7px 6px; white-space: nowrap; }
table.logs th.n, table.logs td.n { text-align: right; font-variant-numeric: tabular-nums; }
table.logs tr.r { cursor: pointer; }
table.logs tr.r:hover, table.logs tr.r.open { background: var(--row-hover); }
table.logs td.est { color: var(--muted); }
table.logs tr.detail td { background: var(--row-hover); white-space: normal; padding: 10px 14px 14px; }
.chip.bad { background: var(--chip-bad); color: var(--bad); }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.slow { color: var(--warn); }
.kv { display: grid; grid-template-columns: max-content 1fr max-content 1fr; gap: 4px 16px; font-size: 13px; }
.kv .k { color: var(--muted); }
.kv .v { word-break: break-all; }
.kv .err { color: var(--bad); white-space: pre-wrap; }
@media (max-width: 760px) { .kv { grid-template-columns: max-content 1fr; } }
.pager { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 10px; color: var(--muted); }
.hidden { display: none !important; }
a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <section id="auth" class="panel hidden">
    <h2>输入管理密钥</h2>
    <p class="hint">即服务端环境变量 KIRO2CLAUDE_ADMIN_KEY 的值，只保存在本浏览器。</p>
    <div class="row"><input id="keyInput" type="password" autocomplete="current-password" placeholder="管理密钥"></div>
    <button class="primary" id="keySave">进入</button>
    <div id="authMsg" class="msg bad"></div>
  </section>

  <div id="app" class="hidden">
    <header>
      <h1>kiro2api</h1>
      <nav class="nav hidden" id="nav">
        <button data-view="pool" class="active">账号池</button>
        <button data-view="logs">请求日志</button>
      </nav>
      <div class="stats" id="stats"></div>
      <div class="spacer"></div>
      <button id="refreshAll">刷新全部额度</button>
      <button id="logout">退出</button>
    </header>

    <div id="logsView" class="hidden">
      <section class="panel">
        <div class="panel-head">
          <h2>汇总</h2>
          <div class="seg" id="lRange">
            <button data-range="1h">1 小时</button>
            <button data-range="today" class="active">今天</button>
            <button data-range="7d">7 天</button>
            <button data-range="30d">30 天</button>
          </div>
          <span class="hint" style="margin:0">跟随下方的账号和模型筛选</span>
        </div>
        <div class="cards" id="lCards"></div>
        <p class="hint">输入是未命中缓存的部分。缓存读和缓存写是 derived 插件根据 credits 反推的估算值（上游不直接报告缓存），所以用灰色显示。总输入 = 输入 + 缓存读 + 缓存写。</p>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>请求列表</h2></div>
        <div class="filters">
          <select id="lAccount"><option value="">全部账号</option></select>
          <select id="lModel"><option value="">全部模型</option></select>
          <select id="lStatus">
            <option value="">全部状态</option>
            <option value="ok">成功</option>
            <option value="error">失败</option>
          </select>
          <input id="lSearch" type="search" placeholder="搜索请求 ID / IP / User-Agent">
          <div class="spacer"></div>
          <label class="chk"><input type="checkbox" id="lAuto" checked> 自动刷新</label>
          <button id="lRefresh">刷新</button>
        </div>
        <div class="table-wrap">
          <table class="logs">
            <thead><tr>
              <th>时间</th><th>账号</th><th>模型</th><th>状态</th>
              <th class="n">总耗时</th><th class="n">首字</th>
              <th class="n">输入</th><th class="n">缓存读</th><th class="n">缓存写</th><th class="n">输出</th>
              <th class="n">credits</th><th>客户端</th>
            </tr></thead>
            <tbody id="lRows"></tbody>
          </table>
        </div>
        <div class="pager">
          <span id="lPageInfo"></span>
          <button id="lPrev">上一页</button>
          <button id="lNext">下一页</button>
        </div>
        <p class="hint">点击一行查看详情。只记录元数据，不记录请求和回复的正文。</p>
      </section>
    </div>

    <div id="poolView">
    <section class="panel">
      <h2>接入信息</h2>
      <div class="conn">
        <div class="conn-label">Claude 格式 Base URL</div>
        <div class="conn-value"><code id="cClaude"></code><button data-copy="cClaude">复制</button></div>
        <div class="conn-label">OpenAI 格式 Base URL</div>
        <div class="conn-value"><code id="cOpenai"></code><button data-copy="cOpenai">复制</button></div>
        <div class="conn-label">API Key</div>
        <div class="conn-value"><code id="cKey">••••••••••••••••</code><button id="cKeyShow">显示</button><button data-copy="cKey">复制</button></div>
        <div class="conn-label">可用模型</div>
        <div class="conn-value"><span id="cModels" class="models"></span></div>
      </div>
      <p class="hint">Claude Code 等 Anthropic 客户端填 Claude 格式地址（客户端会自动补 /v1/messages）；New API 选 Anthropic Claude 类型的渠道，填同一个地址和 API Key。思考由客户端的请求参数决定，模型名后面加不加 -thinking 都一样。API Key 由服务端环境变量 KIRO2CLAUDE_API_KEY 决定，要更换请在 Portainer 的 stack 里改这个变量。</p>
    </section>

    <section class="panel">
      <h2>添加账号</h2>
      <div class="tabs">
        <button class="tab active" data-tab="builder">Builder ID 登录</button>
        <button class="tab" data-tab="idc">IAM Identity Center 登录</button>
        <button class="tab" data-tab="paste">粘贴凭据</button>
      </div>

      <div data-pane="builder">
        <div class="row"><label>备注名</label><input id="bName" placeholder="可选，例如 学校邮箱"></div>
        <button class="primary" id="bStart">开始登录</button>
        <p class="hint">点击后会给出一个验证码和链接。用任意浏览器打开链接、登录 AWS Builder ID 并确认，页面会自动完成添加。</p>
      </div>

      <div data-pane="idc" class="hidden">
        <div class="row"><label>Start URL</label><input id="iUrl" placeholder="https://xxx.awsapps.com/start"></div>
        <div class="row"><label>Region</label><input id="iRegion" value="us-east-1"></div>
        <div class="row"><label>备注名</label><input id="iName" placeholder="可选"></div>
        <button class="primary" id="iStart">开始登录</button>
        <p class="hint">企业或学校的 IAM Identity Center 账号。Start URL 和 Region 由管理员提供。</p>
      </div>

      <div data-pane="paste" class="hidden">
        <textarea id="pText" placeholder='粘贴 JSON，例如 kiro.rs 的 credentials.json，或 kiro-cli / Kiro IDE 的 token 文件加上注册文件（可以前后连着粘贴）'></textarea>
        <div class="row" style="margin-top:8px"><label>备注名</label><input id="pName" placeholder="可选"></div>
        <button class="primary" id="pImport">导入</button>
        <p class="hint">需要 refreshToken 加 clientId / clientSecret。GitHub、Google 社交登录的账号不支持。</p>
      </div>

      <div id="loginBox" class="login-box hidden">
        <div>在浏览器打开：<a id="loginLink" target="_blank" rel="noopener noreferrer"></a></div>
        <div>确认验证码：</div>
        <div class="code" id="loginCode"></div>
        <div class="sub" id="loginState"></div>
        <button id="loginCancel" style="margin-top:8px">取消</button>
      </div>
      <div id="addMsg" class="msg"></div>
    </section>

    <section class="panel">
      <h2>账号列表</h2>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>名称</th><th>状态</th><th>额度</th><th>请求 / 失败</th><th>已用 credits</th><th>最近使用</th><th>来源</th><th>操作</th>
          </tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </section>
    </div>
  </div>
</main>
<script>
(function () {
  var KEY_STORE = 'kiro2api.adminKey';
  var key = '';
  try { key = localStorage.getItem(KEY_STORE) || ''; } catch (e) {}
  var loginId = null;
  var loginTimer = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtNum(n) { return n == null ? '-' : (Math.round(n * 100) / 100).toLocaleString(); }
  function fmtTime(s) {
    if (!s) return '-';
    var d = new Date(s); var diff = (Date.now() - d.getTime()) / 1000;
    if (diff >= 0 && diff < 60) return '刚刚';
    if (diff >= 0 && diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff >= 0 && diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    return d.toLocaleString();
  }
  function fmtUntil(s) {
    var sec = Math.max(0, Math.round((new Date(s).getTime() - Date.now()) / 1000));
    if (sec < 60) return sec + ' 秒';
    if (sec < 3600) return Math.ceil(sec / 60) + ' 分钟';
    return (Math.round(sec / 360) / 10) + ' 小时';
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { 'authorization': 'Bearer ' + key } };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(location.pathname.replace(/\\/+$/, '') + '/api' + path, opts).then(function (r) {
      return r.text().then(function (t) {
        var data = {}; try { data = t ? JSON.parse(t) : {}; } catch (e) { data = { error: t }; }
        if (r.status === 401) { showAuth('密钥不正确'); throw new Error('unauthorized'); }
        if (!r.ok) throw new Error((data.error && (data.error.message || data.error)) || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function showAuth(msg) {
    $('app').classList.add('hidden'); $('auth').classList.remove('hidden');
    $('authMsg').textContent = msg || '';
  }
  function showApp() {
    $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
    loadConnection();
    load();
  }
  function setMsg(text, ok) {
    var m = $('addMsg'); m.textContent = text || ''; m.className = 'msg ' + (ok ? 'ok' : 'bad');
  }

  var SOURCE = { 'builder-id': 'Builder ID', 'idc': 'IdC', 'import': '导入', 'kiro-cli': 'kiro-cli SQLite' };

  function render(accounts) {
    var tb = $('rows');
    if (!accounts.length) { tb.innerHTML = '<tr><td colspan="8" class="empty">还没有账号，在上面添加一个。</td></tr>'; return; }
    tb.innerHTML = accounts.map(function (a) {
      var st = a.status === 'ok' ? '<span class="chip ok">可用</span>'
        : a.status === 'cooling' ? '<span class="chip cooling">冷却中</span><div class="sub">' + esc(a.cooldownReason) + '，' + fmtUntil(a.cooldownUntil) + '后恢复</div>'
        : '<span class="chip disabled">已停用</span>' + (a.disabledReason ? '<div class="sub">' + esc(a.disabledReason) + '</div>' : '');
      if (a.stats.lastError && a.status === 'ok') st += '<div class="sub" title="' + esc(a.stats.lastError) + '">上次错误 ' + fmtTime(a.stats.lastErrorAt) + '</div>';
      var q = '-';
      if (a.quota) {
        var pct = a.quota.limit > 0 ? Math.min(100, a.quota.current / a.quota.limit * 100) : 0;
        q = fmtNum(a.quota.current) + ' / ' + fmtNum(a.quota.limit) + '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>'
          + '<div class="sub">查询于 ' + fmtTime(a.quota.checkedAt) + '</div>';
      }
      var name = '<b>' + esc(a.name) + '</b><div class="sub">' + esc(a.email || a.id) + (a.subscription ? ' · ' + esc(a.subscription) : '') + '</div>';
      var acts = '<div class="actions">'
        + '<button data-act="toggle" data-id="' + esc(a.id) + '" data-on="' + (a.enabled ? '1' : '0') + '">' + (a.enabled ? '停用' : '启用') + '</button>'
        + '<button data-act="quota" data-id="' + esc(a.id) + '">查额度</button>'
        + '<button data-act="rename" data-id="' + esc(a.id) + '" data-name="' + esc(a.name) + '">改名</button>'
        + (a.source === 'kiro-cli' ? '' : '<button class="danger" data-act="delete" data-id="' + esc(a.id) + '" data-name="' + esc(a.name) + '">删除</button>')
        + '</div>';
      return '<tr><td>' + name + '</td><td>' + st + '</td><td>' + q + '</td><td>' + a.stats.requests + ' / ' + a.stats.failures
        + '</td><td>' + fmtNum(a.stats.credits) + '</td><td>' + fmtTime(a.stats.lastUsedAt) + '</td><td>' + esc(SOURCE[a.source] || a.source)
        + (a.region ? '<div class="sub">' + esc(a.region) + '</div>' : '') + '</td><td>' + acts + '</td></tr>';
    }).join('');
  }

  var apiKey = '';
  var keyShown = false;
  function loadConnection() {
    var root = location.origin;
    $('cClaude').textContent = root + '/claude';
    $('cOpenai').textContent = root + '/openai/v1';
    api('GET', '/connection').then(function (c) {
      apiKey = c.apiKey;
      logsEnabled = Boolean(c.requestLog);
      $('nav').classList.toggle('hidden', !logsEnabled);
      if (logsEnabled && location.hash === '#logs') setView('logs');
      $('cKey').textContent = keyShown ? apiKey : '••••••••••••••••';
      $('cModels').innerHTML = c.models.map(function (m) { return '<span>' + esc(m) + '</span>'; }).join('');
    }).catch(function () {});
  }
  $('cKeyShow').onclick = function () {
    keyShown = !keyShown;
    $('cKey').textContent = keyShown ? apiKey : '••••••••••••••••';
    this.textContent = keyShown ? '隐藏' : '显示';
  };
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-copy');
      var text = id === 'cKey' ? apiKey : $(id).textContent;
      var done = function () { var t = b.textContent; b.textContent = '已复制'; setTimeout(function () { b.textContent = t; }, 1200); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done);
      else {
        var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
        ta.select(); try { document.execCommand('copy'); done(); } catch (e) {} document.body.removeChild(ta);
      }
    });
  });

  function load() {
    return Promise.all([api('GET', '/status'), api('GET', '/accounts')]).then(function (r) {
      var s = r[0];
      $('stats').innerHTML = '<span class="stat">共 <b>' + s.accounts + '</b></span>'
        + '<span class="stat">可用 <b>' + s.ok + '</b></span>'
        + '<span class="stat">冷却 <b>' + s.cooling + '</b></span>'
        + '<span class="stat">停用 <b>' + s.disabled + '</b></span>'
        + '<span class="stat">总额度 <b>' + fmtNum(s.quota.current) + ' / ' + fmtNum(s.quota.limit) + '</b></span>';
      render(r[1].accounts);
    }).catch(function (e) { if (e.message !== 'unauthorized') setMsg('加载失败：' + e.message); });
  }

  $('rows').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-act]'); if (!b) return;
    var id = b.getAttribute('data-id'); var act = b.getAttribute('data-act');
    var p;
    if (act === 'toggle') p = api('PATCH', '/accounts/' + id, { enabled: b.getAttribute('data-on') !== '1' });
    else if (act === 'quota') { b.disabled = true; p = api('POST', '/accounts/' + id + '/quota'); }
    else if (act === 'rename') {
      var n = prompt('新名称', b.getAttribute('data-name')); if (!n) return;
      p = api('PATCH', '/accounts/' + id, { name: n });
    } else if (act === 'delete') {
      if (!confirm('删除账号 ' + b.getAttribute('data-name') + '？凭据会从 accounts.json 中移除。')) return;
      p = api('DELETE', '/accounts/' + id);
    }
    p.then(load).catch(function (e) { if (e.message !== 'unauthorized') alert(e.message); load(); });
  });

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x === t); });
      document.querySelectorAll('[data-pane]').forEach(function (p) {
        p.classList.toggle('hidden', p.getAttribute('data-pane') !== t.getAttribute('data-tab'));
      });
    });
  });

  function stopLogin() {
    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = null; loginId = null; $('loginBox').classList.add('hidden');
    $('bStart').disabled = false; $('iStart').disabled = false;
  }

  function pollLogin() {
    if (!loginId) return;
    api('GET', '/login/' + loginId).then(function (s) {
      if (s.status === 'pending') {
        $('loginState').textContent = '等待在浏览器中确认… 验证码 ' + fmtUntil(s.expiresAt) + '后过期';
        loginTimer = setTimeout(pollLogin, 2500); return;
      }
      stopLogin();
      if (s.status === 'success') { setMsg('登录成功，账号已加入池子。', true); load(); }
      else setMsg('登录未完成（' + s.status + '）' + (s.error ? '：' + s.error : ''));
      if (s.accountId) load();
    }).catch(function (e) { setMsg('查询登录状态失败：' + e.message); loginTimer = setTimeout(pollLogin, 5000); });
  }

  function startLogin(body) {
    setMsg('');
    $('bStart').disabled = true; $('iStart').disabled = true;
    api('POST', '/login/start', body).then(function (s) {
      loginId = s.id;
      var link = s.verificationUriComplete || s.verificationUri;
      $('loginLink').href = link; $('loginLink').textContent = link;
      $('loginCode').textContent = s.userCode;
      $('loginBox').classList.remove('hidden');
      try { window.open(link, '_blank', 'noopener'); } catch (e) {}
      pollLogin();
    }).catch(function (e) { stopLogin(); setMsg('无法开始登录：' + e.message); });
  }

  $('bStart').onclick = function () { startLogin({ name: $('bName').value }); };
  $('iStart').onclick = function () {
    if (!$('iUrl').value.trim()) { setMsg('请填写 Start URL'); return; }
    startLogin({ startUrl: $('iUrl').value, region: $('iRegion').value, name: $('iName').value });
  };
  $('loginCancel').onclick = function () {
    var id = loginId; stopLogin(); if (id) api('DELETE', '/login/' + id).catch(function () {});
    setMsg('已取消登录');
  };
  $('pImport').onclick = function () {
    var b = this; b.disabled = true; setMsg('导入并验证中…', true);
    api('POST', '/accounts/import', { text: $('pText').value, name: $('pName').value }).then(function (r) {
      var ok = r.results.filter(function (x) { return x.verified; }).length;
      var lines = ['导入 ' + r.results.length + ' 个，验证通过 ' + ok + ' 个。'];
      r.results.forEach(function (x) { if (!x.verified) lines.push(x.id + ' 验证失败：' + x.error); });
      (r.errors || []).forEach(function (x) { lines.push(x); });
      setMsg(lines.join('\\n'), ok === r.results.length && !(r.errors || []).length);
      if (ok) $('pText').value = '';
      load();
    }).catch(function (e) { setMsg('导入失败：' + e.message); }).then(function () { b.disabled = false; });
  };
  $('refreshAll').onclick = function () {
    var b = this; b.disabled = true;
    api('POST', '/accounts/quota').then(load).catch(function (e) { alert(e.message); }).then(function () { b.disabled = false; });
  };
  $('logout').onclick = function () {
    key = ''; try { localStorage.removeItem(KEY_STORE); } catch (e) {}
    showAuth('');
  };
  $('keySave').onclick = function () {
    key = $('keyInput').value.trim(); if (!key) return;
    api('GET', '/status').then(function () {
      try { localStorage.setItem(KEY_STORE, key); } catch (e) {}
      showApp();
    }).catch(function (e) { if (e.message !== 'unauthorized') $('authMsg').textContent = e.message; });
  };
  $('keyInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('keySave').click(); });

  // ---------- 请求日志 ----------
  var logsEnabled = false;
  var view = 'pool';
  var DAY = 86400000;
  var lRange = 'today';
  var lPage = 0;
  var L_PAGE = 50;
  var lOpenId = null;
  var lItems = [];
  var lTotal = 0;
  var lFacetsLoaded = false;
  var dfTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  var dfDayTime = new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  var dfFull = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  var STOP = { end_turn: '正常结束', tool_use: '调用工具', max_tokens: '达到输出上限', stop_sequence: '遇到停止序列', model_context_window_exceeded: '上下文已满' };
  var ERR = { rate_limit_error: '限流', overloaded_error: '上游过载', billing_error: '额度耗尽', invalid_request_error: '请求无效',
    api_error: '服务错误', authentication_error: '认证失败', permission_error: '无权限', not_found_error: '未找到', internal_error: '内部错误' };

  function startOfToday() {
    var off = new Date().getTimezoneOffset() * 60000;
    return Math.floor((Date.now() - off) / DAY) * DAY + off;
  }
  function rangeSince(r) {
    var now = Date.now();
    if (r === '1h') return now - 3600000;
    if (r === '7d') return now - 7 * DAY;
    if (r === '30d') return now - 30 * DAY;
    return startOfToday();
  }
  function fmtTok(n) {
    if (n == null) return '-';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }
  function fmtMs(ms) {
    if (ms == null) return '-';
    ms = Math.round(ms);
    return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s';
  }
  function fmtLogTime(ts) { return ts >= startOfToday() ? dfTime.format(ts) : dfDayTime.format(ts); }
  function fmtCredits(n, digits) { return n == null ? '-' : n.toFixed(digits); }
  function protoOf(p) {
    if (p.indexOf('/chat/completions') >= 0) return 'OpenAI Chat';
    if (p.indexOf('/responses') >= 0) return 'OpenAI Responses';
    return 'Claude';
  }
  function reasoningOf(l) {
    if (l.thinking === 'disabled') return '不思考';
    if (l.thinking === 'adaptive') return '思考' + (l.effort ? ' ' + l.effort : '');
    if (l.effort) return l.effort === 'none' ? '不推理' : '推理 ' + l.effort;
    return '';
  }
  function clientOf(ua) {
    if (!ua) return '-';
    var s = ua.toLowerCase();
    if (s.indexOf('claude-cli') >= 0 || s.indexOf('claude-code') >= 0) return 'Claude Code';
    if (s.indexOf('codex') >= 0) return 'Codex';
    if (s.indexOf('anthropic') >= 0) return 'Anthropic SDK';
    if (s.indexOf('openai') >= 0) return 'OpenAI SDK';
    return ua.split(/[ (]/)[0];
  }
  function failed(l) { return l.status >= 400 || Boolean(l.errorType); }
  function stopOf(l) { return l.stopReason ? (STOP[l.stopReason] || l.stopReason) : ''; }

  function logQuery(forList) {
    var q = [];
    var add = function (k, v) { if (v !== '' && v != null) q.push(k + '=' + encodeURIComponent(v)); };
    add('account', $('lAccount').value);
    add('model', $('lModel').value);
    if (forList) {
      add('status', $('lStatus').value);
      add('q', $('lSearch').value.trim());
      add('limit', L_PAGE);
      add('offset', lPage * L_PAGE);
    } else {
      add('since', rangeSince(lRange));
    }
    return q.length ? '?' + q.join('&') : '';
  }

  function loadFacets() {
    return api('GET', '/logs/facets').then(function (f) {
      var fill = function (sel, items, label) {
        var cur = sel.value;
        sel.innerHTML = '<option value="">' + label + '</option>' + items.map(function (it) {
          return '<option value="' + esc(it.value) + '">' + esc(it.text) + '</option>';
        }).join('');
        sel.value = cur;
        if (sel.value !== cur) sel.value = '';
      };
      fill($('lAccount'), f.accounts.map(function (a) { return { value: a.id, text: a.name }; }), '全部账号');
      fill($('lModel'), f.models.map(function (m) { return { value: m, text: m }; }), '全部模型');
      lFacetsLoaded = true;
    });
  }

  function renderCards(s) {
    var totalIn = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
    var cards = [
      ['请求数', s.requests.toLocaleString(), '成功 ' + (s.requests - s.failed) + ' · 失败 ' + s.failed],
      ['输入', fmtTok(s.inputTokens), '总输入 ' + fmtTok(totalIn)],
      ['缓存读 ≈', fmtTok(s.cacheReadTokens), '命中率 ' + (totalIn ? (s.cacheReadTokens / totalIn * 100).toFixed(1) : '0') + '%'],
      ['缓存写 ≈', fmtTok(s.cacheWriteTokens), ''],
      ['输出', fmtTok(s.outputTokens), ''],
      ['credits', s.credits.toFixed(2), '平均每次 ' + (s.requests ? (s.credits / s.requests).toFixed(3) : '0')],
      ['平均耗时', fmtMs(s.avgDurationMs), '平均首字 ' + fmtMs(s.avgTtftMs)]
    ];
    $('lCards').innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div><div class="s">' + (c[2] || '&nbsp;') + '</div></div>';
    }).join('');
  }

  function statusCell(l) {
    if (failed(l)) {
      return '<span class="chip bad">' + (l.status >= 400 ? l.status : '出错') + '</span><div class="sub">'
        + esc(ERR[l.errorType] || l.errorType || '') + '</div>';
    }
    if (l.clientDisconnected) return '<span class="chip cooling">' + l.status + '</span><div class="sub">客户端断开</div>';
    if (l.stopReason === 'max_tokens' || l.stopReason === 'model_context_window_exceeded') {
      return '<span class="chip cooling">' + l.status + '</span><div class="sub">' + esc(stopOf(l)) + '</div>';
    }
    return '<span class="chip ok">' + l.status + '</span><div class="sub">' + esc(stopOf(l)) + '</div>';
  }

  function detailRow(l) {
    var acct = esc(l.accountName || '-');
    if (l.accountsTried) acct += ' <span class="sub">（先后用过 ' + esc(l.accountsTried.join(' → ')) + '）</span>';
    var err = '无';
    if (l.errorType) {
      err = '<span class="err">' + esc(l.errorType) + (l.errorMessage ? '：' + esc(l.errorMessage) : '')
        + (l.errorDetail ? '\\n' + esc(l.errorDetail) : '') + '</span>';
    }
    var credits = fmtCredits(l.credits, 4);
    if (l.meteringLost) credits += ' <span class="err">计量帧丢失：上游可能已扣费但没有记账</span>';
    var tokens = [l.inputTokens, l.cacheReadTokens, l.cacheWriteTokens, l.outputTokens].map(function (n) {
      return n == null ? '-' : n.toLocaleString();
    }).join(' / ');
    var kv = [
      ['请求 ID', '<span class="mono">' + esc(l.reqId) + '</span>'],
      ['时间', dfFull.format(l.ts)],
      ['账号', acct],
      ['接口', esc(protoOf(l.path)) + ' · ' + (l.stream ? '流式' : '非流式')],
      ['路径', '<span class="mono">' + esc(l.method + ' ' + l.path) + '</span>'],
      ['模型', '<span class="mono">' + esc(l.model || '-') + '</span>'],
      ['思考 / 推理', esc(reasoningOf(l) || '-')],
      ['结束原因', l.stopReason ? esc(stopOf(l)) + ' <span class="sub">(' + esc(l.stopReason) + ')</span>' : '-'],
      ['总耗时 / 首字', fmtMs(l.durationMs) + ' / ' + fmtMs(l.ttftMs)],
      ['错误', err],
      ['上游报告的上下文', l.contextTokens == null ? '-' : l.contextTokens.toLocaleString()],
      ['输入 / 缓存读 / 缓存写 / 输出', tokens],
      ['credits', credits],
      ['空流重试', l.emptyAttempts + ' 次'],
      ['调用的工具', l.toolNames ? esc(l.toolNames.join('、')) : '-'],
      ['客户端断开', l.clientDisconnected ? '是' : '否'],
      ['客户端 IP', '<span class="mono">' + esc(l.clientIp || '-') + '</span>'],
      ['User-Agent', '<span class="mono">' + esc(l.userAgent || '-') + '</span>']
    ];
    return '<tr class="detail"><td colspan="12"><div class="kv">' + kv.map(function (p) {
      return '<div class="k">' + p[0] + '</div><div class="v">' + p[1] + '</div>';
    }).join('') + '</div></td></tr>';
  }

  function renderLogRows() {
    var pages = Math.max(1, Math.ceil(lTotal / L_PAGE));
    $('lPageInfo').textContent = '共 ' + lTotal + ' 条 · 第 ' + (lPage + 1) + ' / ' + pages + ' 页';
    $('lPrev').disabled = lPage === 0;
    $('lNext').disabled = lPage >= pages - 1;
    if (!lItems.length) { $('lRows').innerHTML = '<tr><td colspan="12" class="empty">没有符合条件的请求</td></tr>'; return; }
    $('lRows').innerHTML = lItems.map(function (l) {
      var sub = [protoOf(l.path), l.stream ? '流式' : '非流式', reasoningOf(l)].filter(Boolean).join(' · ');
      var row = '<tr class="r' + (lOpenId === l.id ? ' open' : '') + '" data-id="' + l.id + '">'
        + '<td>' + fmtLogTime(l.ts) + '</td>'
        + '<td>' + esc(l.accountName || '-') + '</td>'
        + '<td><span class="mono">' + esc(l.model || '-') + '</span><div class="sub">' + esc(sub) + '</div></td>'
        + '<td>' + statusCell(l) + '</td>'
        + '<td class="n' + (l.durationMs > 60000 ? ' slow' : '') + '">' + fmtMs(l.durationMs) + '</td>'
        + '<td class="n' + (l.ttftMs > 5000 ? ' slow' : '') + '">' + fmtMs(l.ttftMs) + '</td>'
        + '<td class="n">' + fmtTok(l.inputTokens) + '</td>'
        + '<td class="n est">' + fmtTok(l.cacheReadTokens) + '</td>'
        + '<td class="n est">' + fmtTok(l.cacheWriteTokens) + '</td>'
        + '<td class="n">' + fmtTok(l.outputTokens) + '</td>'
        + '<td class="n">' + fmtCredits(l.credits, 3) + '</td>'
        + '<td>' + esc(clientOf(l.userAgent)) + '<div class="sub mono">' + esc(l.clientIp || '') + '</div></td>'
        + '</tr>';
      return lOpenId === l.id ? row + detailRow(l) : row;
    }).join('');
  }

  function loadSummary() {
    return api('GET', '/logs/summary' + logQuery(false)).then(renderCards);
  }
  function loadLogRows() {
    return api('GET', '/logs' + logQuery(true)).then(function (r) {
      var pages = Math.max(1, Math.ceil(r.total / L_PAGE));
      if (lPage > pages - 1) { lPage = pages - 1; return loadLogRows(); }
      lItems = r.items;
      lTotal = r.total;
      renderLogRows();
    });
  }
  function logError(e) {
    if (e.message !== 'unauthorized') $('lRows').innerHTML = '<tr><td colspan="12" class="empty">加载失败：' + esc(e.message) + '</td></tr>';
  }
  function loadLogs() {
    var p = lFacetsLoaded ? Promise.resolve() : loadFacets();
    return p.then(function () { return Promise.all([loadSummary(), loadLogRows()]); }).catch(logError);
  }

  function setView(v) {
    view = v;
    document.querySelectorAll('#nav button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-view') === v); });
    $('poolView').classList.toggle('hidden', v !== 'pool');
    $('logsView').classList.toggle('hidden', v !== 'logs');
    $('stats').classList.toggle('hidden', v !== 'pool');
    $('refreshAll').classList.toggle('hidden', v !== 'pool');
    try { history.replaceState(null, '', v === 'logs' ? '#logs' : location.pathname); } catch (e) {}
    if (v === 'logs') { lFacetsLoaded = false; loadLogs(); } else load();
  }
  document.querySelectorAll('#nav button').forEach(function (b) {
    b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
  });
  $('lRange').addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b) return;
    lRange = b.getAttribute('data-range');
    this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x === b); });
    loadSummary().catch(logError);
  });
  ['lAccount', 'lModel'].forEach(function (id) {
    $(id).addEventListener('change', function () { lPage = 0; lOpenId = null; loadLogs(); });
  });
  $('lStatus').addEventListener('change', function () { lPage = 0; lOpenId = null; loadLogRows().catch(logError); });
  var searchTimer = null;
  $('lSearch').addEventListener('input', function () {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { lPage = 0; lOpenId = null; loadLogRows().catch(logError); }, 300);
  });
  $('lPrev').onclick = function () { if (lPage > 0) { lPage--; lOpenId = null; loadLogRows().catch(logError); } };
  $('lNext').onclick = function () { lPage++; lOpenId = null; loadLogRows().catch(logError); };
  $('lRefresh').onclick = function () { lFacetsLoaded = false; loadLogs(); };
  $('lRows').addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr.r'); if (!tr) return;
    var id = Number(tr.getAttribute('data-id'));
    lOpenId = lOpenId === id ? null : id;
    renderLogRows();
  });

  setInterval(function () {
    if (!key || $('app').classList.contains('hidden')) return;
    if (view === 'logs') { if ($('lAuto').checked && lOpenId === null) loadLogs(); } else load();
  }, 15000);
  if (key) showApp(); else showAuth('');
})();
</script>
</body>
</html>
`;

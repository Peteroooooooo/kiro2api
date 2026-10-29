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
<title>kiro2api 账号池</title>
<style>
:root {
  --bg: #f5f6f8; --panel: #ffffff; --text: #1d2129; --muted: #6b7280; --line: #e5e7eb;
  --accent: #2563eb; --accent-text: #ffffff; --ok: #15803d; --warn: #b45309; --bad: #b91c1c;
  --chip-ok: #dcfce7; --chip-warn: #fef3c7; --chip-bad: #fee2e2; --bar: #e5e7eb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111318; --panel: #1a1d24; --text: #e5e7eb; --muted: #9ca3af; --line: #2b303b;
    --accent: #3b82f6; --accent-text: #ffffff; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171;
    --chip-ok: #14532d; --chip-warn: #78350f; --chip-bad: #7f1d1d; --bar: #2b303b;
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
      <h1>kiro2api 账号池</h1>
      <div class="stats" id="stats"></div>
      <div class="spacer"></div>
      <button id="refreshAll">刷新全部额度</button>
      <button id="logout">退出</button>
    </header>

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
      <p class="hint">Claude Code 等 Anthropic 客户端填 Claude 格式地址（客户端会自动补 /v1/messages）；New API 选 Anthropic Claude 类型的渠道，填同一个地址和 API Key。模型名带 -thinking 后缀即开启思考。API Key 由服务端环境变量 KIRO2CLAUDE_API_KEY 决定，要更换请在 Portainer 的 stack 里改这个变量。</p>
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

  setInterval(function () { if (key && !$('app').classList.contains('hidden')) load(); }, 15000);
  if (key) showApp(); else showAuth('');
})();
</script>
</body>
</html>
`;

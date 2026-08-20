// popup 逻辑：显示当前标签页检测到的流（一个名字 + 一键下载），进度就地展示

const $ = (id) => document.getElementById(id);

let activeTabId = null;
let streams = [];
const downloading = new Set();
const dlStatus = new Map(); // id -> { state, progress, filename, downloadId, error }
let autoScanned = false;
const lastTick = new Map(); // id -> 最近一次进度消息时间（用于卡住检测）

function hasActiveDownloads() {
  return (
    downloading.size > 0 ||
    [...dlStatus.values()].some((s) => s.state === 'running')
  );
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function fmtBytes(b) {
  if (!b) return '';
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
  if (b >= 1 << 10) return (b >> 10) + ' KB';
  return b + ' B';
}

const GENERIC_SEG = /^(index|master|playlist|play|stream|media|video|default|hls|audio|sub|main)$/i;
function deriveName(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    let core = '';
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i].replace(/\.(m3u8?|mpd)$/i, '');
      if (s && !GENERIC_SEG.test(s)) {
        core = s;
        break;
      }
    }
    const q = url.match(/(\d{2,4}p|\d+kb(?:ps)?)/i);
    if (q && q[1]) core = core ? `${core} · ${q[1].toLowerCase()}` : q[1].toLowerCase();
    return core ? `${u.hostname} · ${core}` : u.hostname;
  } catch {
    return truncate(url, 40);
  }
}

let noticeTimer = null;
function showNotice(msg, isError = false, sticky = false) {
  const el = $('notice');
  el.textContent = msg;
  el.className = 'notice visible' + (isError ? ' error' : '');
  clearTimeout(noticeTimer);
  if (!sticky) {
    noticeTimer = setTimeout(() => (el.className = 'notice hidden'), 4000);
  }
}

async function pingSw() {
  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ type: 'ping' }),
      new Promise((r) => setTimeout(() => r(null), 800)),
    ]);
    return !!(res && res.pong);
  } catch {
    return false;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const tab = await getActiveTab();
  if (!tab) return;
  activeTabId = tab.id;
  $('tab-title').textContent = truncate(tab.title || tab.url || '当前标签页', 24);
  const res = await chrome.runtime.sendMessage({ type: 'get-streams', tabId: tab.id }).catch(() => null);
  streams = res?.streams || [];
  // 恢复上次会话的下载状态（弹窗关闭后再打开）
  const dlRes = await chrome.runtime.sendMessage({ type: 'get-downloads', tabId: tab.id }).catch(() => null);
  dlStatus.clear();
  for (const d of dlRes?.downloads || []) dlStatus.set(d.id, d);
  render();
}

function render() {
  const ul = $('streams');
  ul.innerHTML = '';
  const isEmpty = streams.length === 0;
  $('empty').classList.toggle('hidden', !isEmpty);
  $('btn-clear').disabled = isEmpty;
  for (const s of streams) {
    const li = buildRow(s);
    const st = dlStatus.get(s.id);
    if (st) applyStatus(li, st);
    ul.appendChild(li);
  }
  if (isEmpty) showDebug();
}

// 依据持久化状态恢复行内 UI（运行中 / 已完成 / 失败）
function applyStatus(li, st) {
  const detail = li.querySelector('.detail');
  const btn = li.querySelector('.btn-primary');
  detail.classList.remove('hidden');
  detail.innerHTML = '';

  if (st.state === 'running') {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '下载中…';
    }
    const hint = document.createElement('div');
    hint.textContent = '正在下载分片并合并… 弹窗可随时关闭，进度会自动保留';
    const barWrap = document.createElement('div');
    barWrap.className = 'progress';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const pct = document.createElement('div');
    pct.className = 'pct';
    const p = st.progress || { done: 0, total: 1 };
    const per = Math.min(100, Math.round((p.done / Math.max(p.total, 1)) * 100));
    bar.style.width = per + '%';
    pct.textContent = `${per}% · ${fmtBytes(p.done)}/${fmtBytes(p.total)}`;
    barWrap.append(bar, pct);
    detail.append(hint, barWrap);
    return;
  }

  const line = document.createElement('div');
  line.className = 'done-line';
  if (st.state === 'done') {
    const ok = document.createElement('span');
    ok.className = 'ok';
    ok.textContent = `✔ 已保存 ${st.filename || ''}`;
    const open = document.createElement('button');
    open.className = 'btn';
    open.textContent = '打开';
    open.addEventListener('click', () => {
      if (st.downloadId) chrome.downloads.show(st.downloadId);
    });
    line.append(ok, open);
  } else if (st.state === 'cancelled') {
    const err = document.createElement('span');
    err.style.color = '#fbbf24';
    err.textContent = '已取消';
    line.appendChild(err);
    line.appendChild(retryBtn(li));
  } else {
    const err = document.createElement('span');
    err.style.color = '#f87171';
    err.textContent = '✕ ' + (st.error || '下载失败');
    line.appendChild(err);
    line.appendChild(retryBtn(li));
  }
  detail.appendChild(line);
}

function retryBtn(li) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = '重试';
  b.addEventListener('click', () => doDownload(li.dataset.id, li));
  return b;
}

async function scanPage() {
  const btn = $('btn-scan');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '扫描中…';
  }
  const res = await chrome.runtime
    .sendMessage({ type: 'page-scan', tabId: activeTabId })
    .catch(() => null);
  if (btn) {
    btn.disabled = false;
    btn.textContent = '扫描页面媒体资源';
  }
  if (res?.error) {
    showNotice('扫描失败：' + res.error, true);
    const wrap = $('debug-wrap');
    const log = $('debug-log');
    log.textContent = '错误：' + res.error;
    wrap.classList.remove('hidden');
  } else if (res?.found) {
    showNotice(`✔ 已从页面层面找回 ${res.found} 个播放列表（共 ${res.total} 个媒体资源）`);
    if ((res.raw || []).length) {
      const wrap = $('debug-wrap');
      const log = $('debug-log');
      log.textContent = '扫描到的媒体资源地址：\n' + res.raw.join('\n');
      wrap.classList.remove('hidden');
    }
  } else {
    showNotice('未扫描到媒体资源：请先在播放页播放一遍视频再点此处');
  }
  refresh();
}

async function showDebug() {
  const wrap = $('debug-wrap');
  const log = $('debug-log');
  const res = await chrome.runtime.sendMessage({ type: 'get-debug' }).catch(() => null);
  const arr = res?.debug || [];
  log.textContent = arr.length
    ? arr.map((d) => `${new Date(d.ts).toLocaleTimeString()}  ${d.msg}`).join('\n')
    : '（暂无日志）';
  wrap.classList.toggle('hidden', false);
}

function buildRow(s) {
  const li = document.createElement('li');
  li.className = 'stream';
  li.dataset.id = s.id;

  const name = document.createElement('div');
  name.className = 'stream-name';
  name.textContent = deriveName(s.url);
  name.title = s.url;
  li.appendChild(name);

  const sub = document.createElement('div');
  sub.className = 'stream-sub';
  sub.textContent = truncate(s.url, 90);
  sub.title = s.url;
  li.appendChild(sub);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const btnCopy = document.createElement('button');
  btnCopy.className = 'btn btn-icon';
  btnCopy.textContent = '复制';
  btnCopy.title = '复制链接';
  btnCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(s.url);
      btnCopy.textContent = '✓';
      setTimeout(() => (btnCopy.textContent = '复制'), 1200);
    } catch {
      showNotice('复制失败', true);
    }
  });

  const btnDownload = document.createElement('button');
  btnDownload.className = 'btn btn-primary';
  btnDownload.textContent = '下载';
  btnDownload.addEventListener('click', () => doDownload(s.id, li));

  actions.append(btnCopy, btnDownload);
  li.appendChild(actions);

  const detail = document.createElement('div');
  detail.className = 'detail hidden';
  li.appendChild(detail);

  return li;
}

function doDownload(id, li) {
  if (downloading.has(id)) return;
  if (!li) li = document.querySelector(`li[data-id="${id}"]`);
  downloading.add(id);
  const btn = li && li.querySelector('.btn-primary');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '下载中…';
  }

  dlStatus.set(id, { state: 'running', stage: '准备中…', progress: { done: 0, total: 1 } });

  if (li) {
    const detail = li.querySelector('.detail');
    if (detail) {
      detail.classList.remove('hidden');
      detail.innerHTML = '';
      const hint = document.createElement('div');
      hint.textContent = '正在拉取分片并合并，请勿关闭本弹窗…';
      const barWrap = document.createElement('div');
      barWrap.className = 'progress';
      const bar = document.createElement('div');
      bar.className = 'bar';
      const pct = document.createElement('div');
      pct.className = 'pct';
      pct.textContent = '0%';
      barWrap.append(bar, pct);
      detail.append(hint, barWrap);
    }
  }

  // 自动选择最高画质：variantIndex 缺省由后台选最佳变体
  chrome.runtime.sendMessage({ type: 'download', tabId: activeTabId, id });
}

function updateProgress(id, msg) {
  const done = msg.done;
  const total = msg.total || 1;
  lastTick.set(id, Date.now());
  dlStatus.set(id, { state: 'running', stage: msg.phase || 'downloading', progress: { done, total } });
  const li = document.querySelector(`li[data-id="${id}"]`);
  if (!li) return;
  const barWrap = li.querySelector('.progress');
  if (!barWrap) return;
  const bar = barWrap.querySelector('.bar');
  const pctEl = barWrap.querySelector('.pct');
  if (msg.phase === 'count') {
    // 按分片数计进度（未探测大小，避免整段重复下载拖慢速度）
    bar.classList.add('busy');
    bar.style.width = '';
    pctEl.textContent = `下载分片 ${done}/${total} · 已获取 ${fmtBytes(msg.bytes || 0)}`;
  } else if (msg.phase === 'assemble') {
    // 把分块传送给 offscreen（以真实字节计）
    const pct = Math.min(100, Math.round((done / Math.max(total, 1)) * 100));
    bar.classList.remove('busy');
    bar.style.width = pct + '%';
    pctEl.textContent = `写入准备 ${pct}% · ${fmtBytes(done)}/${fmtBytes(total)}`;
  } else {
    bar.classList.remove('busy');
    const pct = Math.min(100, Math.round((done / Math.max(total, 1)) * 100));
    bar.style.width = pct + '%';
    pctEl.textContent = `${pct}% · ${fmtBytes(done)}/${fmtBytes(total)}`;
  }
}

function finishRow(id, btn, doneHtml) {
  downloading.delete(id);
  const li = document.querySelector(`li[data-id="${id}"]`);
  if (!li) return;
  const detail = li.querySelector('.detail');
  if (detail) {
    detail.innerHTML = '';
    detail.appendChild(doneHtml);
  }
  const b = li.querySelector('.btn-primary');
  if (b) {
    b.disabled = false;
    b.textContent = '下载';
  }
}

function onDownloadDone(id, payload) {
  lastTick.delete(id);
  dlStatus.set(id, {
    state: 'done',
    filename: payload.filename || '',
    downloadId: payload.downloadId,
    bytes: payload.bytes,
    ts: Date.now(),
  });
  const done = document.createElement('div');
  done.className = 'done-line';
  const ok = document.createElement('span');
  ok.className = 'ok';
  ok.textContent = `✔ 已保存 ${payload.filename || ''}`;
  if (payload.renamed && payload.filename) {
    const tip = document.createElement('span');
    tip.className = 'ok-tip';
    tip.textContent = '（浏览器改写了文件名）';
    ok.appendChild(tip);
  }
  const open = document.createElement('button');
  open.className = 'btn';
  open.textContent = '打开';
  open.addEventListener('click', () => chrome.downloads.show(payload.downloadId));
  done.append(ok, open);
  finishRow(id, null, done);
}

function onDownloadFailed(id, msg) {
  lastTick.delete(id);
  dlStatus.set(id, { state: 'failed', error: msg || '下载失败', ts: Date.now() });
  const done = document.createElement('div');
  done.className = 'done-line';
  const err = document.createElement('span');
  err.style.color = '#f87171';
  err.textContent = '✕ ' + (msg || '下载失败');
  done.appendChild(err);
  finishRow(id, null, done);
}

$('btn-refresh').addEventListener('click', refresh);
$('btn-scan').addEventListener('click', scanPage);
$('btn-clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clear-tab', tabId: activeTabId });
  streams = [];
  render();
});

$('ck-saveas').addEventListener('change', (e) => {
  chrome.runtime.sendMessage({ type: 'set-saveas', saveAs: e.target.checked });
});

$('sel-concur').addEventListener('change', (e) => {
  chrome.runtime.sendMessage({ type: 'set-concurrency', concurrency: parseInt(e.target.value, 10) || 16 });
});

(async () => {
  const ver = document.getElementById('ver');
  if (ver) ver.textContent = chrome.runtime.getManifest().version;
  let alive = await pingSw();
  if (!alive) {
    showNotice('⚠ 后台服务未响应：请到 chrome://extensions 点击本插件的「刷新」重新加载', true, true);
    return;
  }
  const stRes = await chrome.runtime.sendMessage({ type: 'get-settings' }).catch(() => null);
  if (stRes) {
    $('ck-saveas').checked = !!stRes.saveAs;
    $('sel-concur').value = String(stRes.concurrency || 16);
  }
  await refresh();

  // 卡住检测：运行中的任务若超过 60 秒无任何进度消息，提示用户查日志
  setInterval(() => {
    const now = Date.now();
    for (const [id, st] of dlStatus) {
      if (st.state === 'running' && lastTick.has(id)) {
        const idle = now - lastTick.get(id);
        if (idle > 60000 && idle < 66000) {
          showNotice('60 秒无进展？请查看下方检测日志', true);
        }
      }
    }
  }, 5000);
  if (streams.length === 0 && !autoScanned) {
    autoScanned = true;
    scanPage();
  }
})();

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.tabId !== activeTabId) return;
  switch (msg.type) {
    case 'streams-updated':
      if (!document.hidden && !hasActiveDownloads()) refresh();
      break;
    case 'download-progress':
      updateProgress(msg.id, msg);
      break;
    case 'download-writing':
      lastTick.set(msg.id, Date.now());
      dlStatus.set(msg.id, { state: 'running', stage: 'writing', progress: { done: 1, total: 1 } });
      {
        const li = document.querySelector(`li[data-id="${msg.id}"]`);
        if (li) {
          const barWrap = li.querySelector('.progress');
          if (barWrap) {
            const bar = barWrap.querySelector('.bar');
            bar.classList.remove('busy');
            bar.style.width = '100%';
            barWrap.querySelector('.pct').textContent = '分片已合并，正在写入磁盘…';
          }
          const hint = li.querySelector('.detail > div');
          if (hint) hint.textContent = '正在写入磁盘（文件较大时需等待）…';
        }
      }
      break;
    case 'download-done':
      onDownloadDone(msg.id, msg);
      break;
    case 'download-failed':
      onDownloadFailed(msg.id, msg.error);
      break;
    case 'download-cancelled':
      dlStatus.set(msg.id, { state: 'cancelled', ts: Date.now() });
      onDownloadFailed(msg.id, '操作已取消');
      break;
  }
});
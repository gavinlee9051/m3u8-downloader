// M3u8 Sniffer 后台服务 worker：
// 1) webRequest 嗅探 m3u8/mpd 请求 → 存入 storage.session → 更新 badge
// 2) 响应 popup：列表 / 解析 / 下载 / 取消 / 清空
// 3) 下载编排：拉取-解析 → 交给 offscreen 文档合并并写入下载列表 → 持久化状态

import { parsePlaylist, pickBestVariant } from './lib/m3u8-parser.js';
import { downloadAndMerge } from './lib/segment-fetcher.js';
import * as store from './lib/store.js';

chrome.action.setBadgeBackgroundColor({ color: '#2962ff' });

chrome.runtime.onInstalled.addListener(async () => {
  await addDebug(`扩展已激活 ${chrome.runtime.getManifest().version}`);
  console.log('[m3u8-sniffer] installed', chrome.runtime.getManifest().version);
  ensureWriter(); // 预热合并器
});
chrome.runtime.onStartup.addListener(async () => {
  await addDebug('浏览器启动，服务已就绪');
  console.log('[m3u8-sniffer] startup');
  ensureWriter(); // 预热合并器
});

const PLAYLIST_URL_RE = /\.(m3u8?|mpegurl|mpd)(?:$|[?#])/i;
const PLAYLIST_CONTENT_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/x-mpegURL',
  'vnd.apple.mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/mpegurl',
]);

function looksLikePlaylistUrl(url) {
  return PLAYLIST_URL_RE.test(url);
}

function isPlaylistContentType(ct) {
  if (!ct) return false;
  return PLAYLIST_CONTENT_TYPES.has(ct.toLowerCase().split(';')[0].trim());
}

function getContentType(headers) {
  if (!headers) return '';
  const h = headers.find((x) => x.name.toLowerCase() === 'content-type');
  return h ? h.value : '';
}

let lastBadge = new Map();
async function updateBadge(tabId) {
  if (tabId < 0) return;
  const streams = await store.getTab(tabId);
  const count = streams.length;
  if (count === 0) {
    lastBadge.delete(tabId);
  } else {
    lastBadge.set(tabId, count);
  }
  try {
    await chrome.action.setBadgeText({ tabId, text: count === 0 ? '' : String(Math.min(count, 99)) });
  } catch {
    // 标签页可能已关闭
  }
}

function broadcast(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {
    // 没有打开的监听者（popup 未打开），忽略
  });
}

// ---------- 调试日志（弹窗空列表时展示，便于定位） ----------

const DEBUG_KEY = 'debug_v1';
const MAX_DEBUG = 40;

function lget(key) {
  return new Promise((resolve) =>
    chrome.storage.local.get(key, (data) => resolve(data && data[key]))
  );
}
function lset(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function addDebug(msg) {
  try {
    const arr = (await lget(DEBUG_KEY)) || [];
    arr.unshift({ ts: Date.now(), msg });
    await lset({ [DEBUG_KEY]: arr.slice(0, MAX_DEBUG) });
  } catch {
    /* ignore */
  }
}

// ---------- 嗅探 ----------

// webRequest 在请求来自页面 Service Worker / Worker 时 tabId 为 -1，
// 通过 initiator 主机名与真实标签页关联（结果缓存 20s）。
const hostTabMap = new Map();
async function resolveTabId(details) {
  if (details.tabId >= 0) return details.tabId;
  const ref = details.initiator || details.documentUrl || details.url;
  let host = '';
  try {
    host = new URL(ref).hostname;
  } catch {
    /* ignore */
  }
  if (!host) return -1;
  const hit = hostTabMap.get(host);
  if (hit && Date.now() - hit.ts < 20000) return hit.tabId;
  let found = -1;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      let th = '';
      try {
        th = new URL(t.url || '').hostname;
      } catch {
        /* ignore */
      }
      if (th === host) {
        found = t.id;
        break;
      }
    }
  } catch {
    /* ignore */
  }
  hostTabMap.set(host, { tabId: found, ts: Date.now() });
  return found;
}

async function record(details) {
  const tabId = await resolveTabId(details);
  if (tabId < 0) {
    const note = `丢弃(无法关联标签页): ${details.url.slice(0, 90)}`;
    console.warn('[m3u8-sniffer]', note);
    await addDebug(note);
    return false;
  }
  const entry = {
    id: crypto.randomUUID(),
    tabId,
    url: details.url,
    pageUrl: details.documentUrl || details.initiator || '',
    contentType: details.contentType || '',
    resourceType: details.type || '',
    ts: Date.now(),
    inspected: false,
  };
  await store.addStream(entry);
  await updateBadge(tabId);
  broadcast({ type: 'streams-updated', tabId });
  const note = `检测到流: ${details.url.slice(0, 90)} | tabId=${tabId}`;
  console.log('[m3u8-sniffer]', note);
  await addDebug(note);
  return true;
}

// ---------- .ts 分片 → 反推播放列表 ----------

const SEGMENT_URL_RE = /\.(ts|m4s)(?:$|[?#])/i;
function looksLikeSegmentUrl(url) {
  return SEGMENT_URL_RE.test(url);
}

const derivedCache = new Map(); // "tabId|dir" -> { ts, ok }
const PLAYLIST_CANDIDATES = [
  'index.m3u8', 'master.m3u8', 'playlist.m3u8', 'main.m3u8', 'manifest.m3u8', 'media.m3u8',
  '../index.m3u8', '../master.m3u8', '../playlist.m3u8', '../main.m3u8', '../manifest.m3u8',
  '../../index.m3u8', '../../master.m3u8', '../../playlist.m3u8', '../../manifest.m3u8',
];

async function maybeDerivePlaylist(details) {
  const tabId = await resolveTabId(details);
  if (tabId < 0) return;
  const m = details.url.match(/^(.*)\/[^/]+$/);
  if (!m) return;
  const dir = m[1];
  const key = `${tabId}|${dir}`;
  const cached = derivedCache.get(key);
  if (cached && Date.now() - cached.ts < 30000) return;
  derivedCache.set(key, { ts: Date.now(), ok: false });

  for (const name of PLAYLIST_CANDIDATES) {
    const cand = new URL(name, dir + '/').href;
    try {
      const res = await fetch(cand, { credentials: 'include' });
      if (!res.ok) continue;
      const text = await res.text();
      if (/^#EXTM3U/s.test(text.trim())) {
        await record({
          tabId,
          url: cand,
          pageUrl: details.documentUrl || details.initiator || '',
          contentType: (res.headers.get('content-type') || '').split(';')[0].trim(),
          type: 'derived',
          resourceType: 'm3u8',
        });
        derivedCache.set(key, { ts: Date.now(), ok: true });
        console.log('[m3u8-sniffer] 反推成功:', cand);
        return;
      }
    } catch {
      /* 网络错误，尝试下一个候选 */
    }
  }
  await addDebug(`分片反推无结果: ${details.url.slice(0, 80)} (dir=${dir})`);
}

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.tabId < 0 && !details.initiator) return;
    if (details.type === 'main_frame') {
      const tabId = await resolveTabId(details);
      if (tabId >= 0) {
        await store.clearTab(tabId);
        await updateBadge(tabId);
      }
      return;
    }
    if (looksLikePlaylistUrl(details.url)) {
      await record(details);
    } else if (looksLikeSegmentUrl(details.url)) {
      await maybeDerivePlaylist(details);
    }
  },
  { urls: ['*://*/*.m3u8*', '*://*/*.m3u*', '*://*/*.mpegurl*', '*://*/*.mpd*', '<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
  []
);

// 兜底：URL 不带扩展名但响应头表明是播放列表（如 token 化 / 反代接口）
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (looksLikePlaylistUrl(details.url)) return; // 已由上一条记录
    const ct = getContentType(details.responseHeaders);
    if (isPlaylistContentType(ct)) {
      await record(details);
    }
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media'] },
  ['responseHeaders']
);

// ---------- 下载会话 ----------

const SETTINGS_KEY = 'settings_v1';
const DEFAULT_CONCURRENCY = 16;

async function getSettings() {
  try {
    const data = await lget(SETTINGS_KEY);
    return {
      saveAs: !!(data && data.saveAs),
      concurrency: Number(data && data.concurrency) || DEFAULT_CONCURRENCY,
    };
  } catch {
    return { saveAs: false, concurrency: DEFAULT_CONCURRENCY };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 写盘器（小型隐藏窗口） ----------
// 部分 Chromium 内核浏览器没有 chrome.offscreen API，改用普通扩展窗口实现同样的
// “合并后在页面环境写入下载列表”的能力；协议与 offscreen 版完全一致（分块 ArrayBuffer）。
const WRITER_URL = chrome.runtime.getURL('writer.html');
let writerErr = '';
let writerLastUse = 0;
let writerWindow = null;

async function writerAlive() {
  try {
    const pong = await chrome.runtime.sendMessage({ type: 'dl-ping' }).catch(() => null);
    return !!(pong && pong.pong && pong.v === 3);
  } catch {
    return false;
  }
}

async function closeWriterWindows() {
  try {
    const tabs = await chrome.tabs.query({ url: WRITER_URL });
    for (const t of tabs) {
      if (t.windowId != null) await chrome.windows.remove(t.windowId).catch(() => {});
    }
    writerWindow = null;
  } catch {
    /* ignore */
  }
}

// 确保写盘器窗口存在且可响应；否则清除残留后重建
async function ensureWriter() {
  if (await writerAlive()) return true;
  await closeWriterWindows();
  try {
    let w = null;
    try {
      // 最小化窗口：不打扰用户，页面照常运行（不允许负坐标/屏幕外窗口）
      w = await chrome.windows.create({
        url: WRITER_URL,
        type: 'popup',
        state: 'minimized',
        width: 300,
        height: 180,
        focused: false,
      });
    } catch (e1) {
      w = await chrome.windows.create({
        url: WRITER_URL,
        type: 'popup',
        width: 300,
        height: 180,
        focused: false,
      });
    }
    writerWindow = w;
    writerLastUse = Date.now();
    console.log('[m3u8-sniffer] 写盘器窗口已创建', w && w.id);
    return true;
  } catch (e) {
    writerErr = (e && e.message) || String(e);
    console.warn('[m3u8-sniffer] 写盘器创建失败', e);
    await addDebug('写盘器创建失败: ' + writerErr);
    return false;
  }
}

// 向写盘器发送指令：每次实时探活，窗口被关闭时立即重建再发
async function sendToWriter(msg, tries = 8) {
  for (let i = 0; i < tries; i++) {
    if (await writerAlive()) {
      const r = await chrome.runtime.sendMessage(msg).catch(() => null);
      if (r && typeof r === 'object' && ('ok' in r || 'started' in r || 'pong' in r)) return r;
      writerLastUse = Date.now();
    }
    await ensureWriter();
    await sleep(400);
  }
  return null;
}

// 空闲 60 秒后自动关闭写盘器窗口，避免残留
setInterval(() => {
  if (writerLastUse && Date.now() - writerLastUse > 60000) {
    writerLastUse = 0;
    closeWriterWindows();
  }
}, 15000);

// 在持久化历史中就地更新某条下载记录
async function patchDownloadInfo(id, fn) {
  try {
    const prev = (await lget(DL_HISTORY_KEY)) || [];
    const e = prev.find((x) => x && x.id === id);
    if (e) {
      fn(e);
      await lset({ [DL_HISTORY_KEY]: prev.slice(0, DL_HISTORY_MAX) });
    }
  } catch {
    /* ignore */
  }
}

// 下载状态持久化：弹窗重开后恢复 running / done / failed，不依赖弹窗存活。
const DL_HISTORY_KEY = 'downloads_v1';
const DL_HISTORY_MAX = 30;
const dlSaveTimers = new Map(); // id -> timeout

async function persistDownloadInfo(info) {
  try {
    const prev = (await lget(DL_HISTORY_KEY)) || [];
    const idx = prev.findIndex((e) => e && e.id === info.id);
    if (idx >= 0) prev[idx] = info;
    else prev.unshift(info);
    await lset({ [DL_HISTORY_KEY]: prev.slice(0, DL_HISTORY_MAX) });
  } catch {
    /* ignore */
  }
}

function queuePersistDownloadInfo(info) {
  const t = dlSaveTimers.get(info.id);
  if (t) clearTimeout(t);
  dlSaveTimers.set(
    info.id,
    setTimeout(() => {
      dlSaveTimers.delete(info.id);
      persistDownloadInfo(info);
    }, 600)
  );
}

async function fetchText(url, signal) {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function sanitize(name) {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return s || 'video';
}

const GENERIC_NAME = /^(index|master|playlist|play|stream|media|video|default|hls|audio|sub|main)$/i;

// 从流媒体地址推导可读的“原视频名”（如 kkzycdn.com:65/20221130/RlkKQth9/… → RlkKQth9）
function deriveNameFromUrl(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    let core = '';
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i].replace(/\.(m3u8?|mpd)$/i, '');
      if (s && !GENERIC_NAME.test(s)) {
        core = s;
        break;
      }
    }
    return core || '';
  } catch {
    return '';
  }
}

async function buildFilename(tabId, ext, url) {
  // 优先用页面标题（通常是片名），去掉末尾的站点后缀如 " - jable.tv"
  let base = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.title) {
      base = tab.title
        .replace(/\s*[-–—_|·]\s*[a-z0-9.-]+\.[a-z]{2,6}\s*$/i, '')
        .replace(/[-–—_|·]\s*$/i, '')
        .trim();
    }
  } catch {
    // ignore
  }
  if (!base) base = deriveNameFromUrl(url);
  const name = sanitize(base);
  return `${name || 'video'}.${ext}`;
}

// 把分片字节写入共享 IndexedDB，再让写盘器拼装成 Blob 写入下载列表。
// 二进制不再走 runtime 消息（部分 Chromium 内核的二进制序列化不可靠），
// 消息里只传纯 JSON 元信息。
async function streamBlobToWriter(parts, meta) {
  const why = writerErr ? `（${writerErr}）` : '';
  const fail = async (stage, detail) => {
    const msg = `分块传输失败(${stage}) 写盘器无响应${why}${detail ? ' ' + detail : ''}`;
    console.warn('[m3u8-sniffer]', msg);
    await addDebug(msg);
    throw new Error(msg);
  };

  if (!(await ensureWriter())) return fail('writer');

  let db, tx, os;
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('m3u8-writer', 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    tx = db.transaction(DB_STORE_NAME, 'readwrite');
    os = tx.objectStore(DB_STORE_NAME);
    os.clear();
  } catch (e) {
    await addDebug('写盘器存储打开失败: ' + ((e && e.message) || e));
    return fail('idb-open');
  }

  const total = parts.length;
  let sentBytes = 0;
  let lastEmit = 0;
  let putErr = '';
  try {
    for (let i = 0; i < total; i++) {
      const r = os.put(parts[i], i);
      await new Promise((resolve, reject) => {
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error || new Error('IDB put error'));
      });
      sentBytes += parts[i].byteLength;
      const now = Date.now();
      if (now - lastEmit > 250) {
        lastEmit = now;
        broadcast({
          type: 'download-progress',
          tabId: meta.tabId,
          id: meta.id,
          done: sentBytes,
          total: meta.bytes || sentBytes,
          phase: 'assemble',
        });
      }
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('tx error'));
      tx.onabort = () => reject(tx.error || new Error('tx abort'));
    });
  } catch (e) {
    putErr = (e && e.name ? e.name + ': ' : '') + ((e && e.message) || e);
    await addDebug('分片写入存储失败: ' + putErr);
    return fail('idb-put', putErr);
  } finally {
    db.close();
  }

  broadcast({
    type: 'download-progress',
    tabId: meta.tabId,
    id: meta.id,
    done: sentBytes,
    total: meta.bytes || sentBytes,
    phase: 'assemble',
  });

  const r = await sendToWriter(
    {
      type: 'dl-run-idb',
      filename: meta.filename,
      saveAs: meta.saveAs,
      mime: meta.mime,
      count: total,
      bytes: meta.bytes,
      segmentCount: meta.segmentCount,
      ext: meta.ext,
      tabId: meta.tabId,
      id: meta.id,
    },
    20
  );
  if (!r || !r.started) return fail('assemble', '');
}

const DB_STORE_NAME = 'store';

async function startDownload(msg) {
  const { tabId, id } = msg;
  const ver = chrome.runtime.getManifest().version;
  await addDebug(`开始下载 (v${ver}) tabId=${tabId}`);
  const info = {
    id,
    tabId,
    state: 'running',
    stage: '准备中…',
    progress: { done: 0, total: 1 },
    ts: Date.now(),
  };
  await persistDownloadInfo(info);

  try {
    const entry = await store.getById(tabId, id);
    if (!entry) throw new Error('找不到该流媒体条目');

    let playlistText = await fetchText(entry.url);
    let parsed = parsePlaylist(playlistText, entry.url);

    if (parsed.isMaster) {
      if (!parsed.variants.length) throw new Error('master 播放列表没有变体');
      const variant =
        msg.variantIndex != null && msg.variantIndex < parsed.variants.length
          ? parsed.variants[msg.variantIndex]
          : pickBestVariant(parsed.variants);
      playlistText = await fetchText(variant.uri);
      parsed = parsePlaylist(playlistText, variant.uri);
    }

    if (parsed.isMaster || parsed.segments.length === 0) throw new Error('无法解析出可下载的分片');

    const ext = parsed.segments[0] && parsed.segments[0].init ? 'mp4' : 'ts';
    const filename = await buildFilename(tabId, ext, entry.url);

    const { saveAs, concurrency } = await getSettings();
    let lastProgressAt = 0;
    const result = await downloadAndMerge(parsed, {
      concurrent: concurrency,
      onProgress: (p) => {
        if (p.phase === 'probe') {
          broadcast({ type: 'download-progress', tabId, id, done: p.done, total: p.total || 1, phase: 'probe' });
          return;
        }
        const now = Date.now();
        if (now - lastProgressAt < 200) return;
        lastProgressAt = now;
        info.state = 'running';
        info.stage = '下载分片并合并…';
        info.progress = { done: p.done, total: p.total || 1 };
        info.ts = Date.now();
        queuePersistDownloadInfo(info);
        broadcast({ type: 'download-progress', tabId, id, done: p.done, total: p.total || 1, phase: 'segment' });
      },
    });

    const meta = {
      tabId,
      id,
      filename,
      saveAs,
      mime: result.mime,
      bytes: result.totalBytes,
      segmentCount: result.segmentCount,
      ext: result.ext,
    };

    // 合并结果分块交给 offscreen 拼装并写入下载列表
    await ensureWriter();
    await streamBlobToWriter(result.parts, meta);

    info.stage = '已提交保存…';
    queuePersistDownloadInfo(info);
    return { started: true };
  } catch (err) {
    info.state = 'failed';
    info.stage = '失败';
    info.error = err.message || String(err);
    info.ts = Date.now();
    await persistDownloadInfo(info);
    broadcast({ type: 'download-failed', tabId, id, error: info.error });
    return { error: info.error };
  }
}

function cancelDownload(msg) {
  // 取消转发到 offscreen 执行合并的控制器
  chrome.runtime.sendMessage({ type: 'dl-cancel', id: msg.id }).catch(() => {});
  return { cancelled: true };
}

// ---------- 消息路由 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'ping':
      sendResponse({ pong: true, ts: Date.now(), version: chrome.runtime.getManifest().version });
      return false;
    case 'get-streams': {
      store.getTab(msg.tabId).then((streams) => {
        store.idFor(streams).then(() => sendResponse({ streams }));
      });
      return true;
    }
    case 'clear-tab': {
      store.clearTab(msg.tabId).then(async () => {
        await updateBadge(msg.tabId);
        sendResponse({ ok: true });
      });
      return true;
    }
    case 'page-stream': {
      // 主世界内容脚本上报
      const tabId = sender.tab ? sender.tab.id : -1;
      if (tabId < 0) return false;
      if (looksLikeSegmentUrl(msg.url)) {
        maybeDerivePlaylist({ tabId, url: msg.url, documentUrl: msg.pageUrl, initiator: msg.pageUrl, type: 'content-script' });
      }
      record({
        tabId,
        url: msg.url,
        documentUrl: msg.pageUrl,
        initiator: msg.pageUrl,
        contentType: msg.contentType,
        type: msg.kind || 'content-script',
      });
      return false;
    }
    case 'get-debug': {
      lget(DEBUG_KEY).then((arr) => sendResponse({ debug: arr || [] }));
      return true;
    }
    case 'get-settings': {
      getSettings().then((s) => sendResponse(s));
      return true;
    }
    case 'set-saveas': {
      (async () => {
        const cur = await getSettings();
        await lset({ [SETTINGS_KEY]: { ...cur, saveAs: !!msg.saveAs } });
        sendResponse({ ok: true });
      })();
      return true;
    }
    case 'set-concurrency': {
      (async () => {
        const cur = await getSettings();
        const n = Math.max(1, Math.min(64, parseInt(msg.concurrency, 10) || DEFAULT_CONCURRENCY));
        await lset({ [SETTINGS_KEY]: { ...cur, concurrency: n } });
        sendResponse({ ok: true });
      })();
      return true;
    }
    case 'get-downloads': {
      // 弹窗重开时恢复下载状态（running / done / failed）
      (async () => {
        const prev = (await lget(DL_HISTORY_KEY)) || [];
        const byId = new Map();
        for (const e of prev) {
          if (e && e.tabId === msg.tabId) byId.set(e.id, e);
        }
        const list = [...byId.values()]
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))
          .slice(0, 6);
        sendResponse({ downloads: list });
      })();
      return true;
    }
    case 'page-scan': {
      // 用 chrome.scripting 现场注入扫描器（所有 frame），
      // 不依赖 manifest 内容脚本是否已注入到页面。
      (async () => {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: msg.tabId, allFrames: true },
            func: () => {
              const RE = /\.(m3u8?|mpd|ts|m4s|mpegurl)(?:$|[?#])/i;
              const found = [];
              try {
                for (const e of performance.getEntriesByType('resource')) {
                  const u = String(e.name || '');
                  if (RE.test(u)) found.push(u);
                }
              } catch (err) {
                /* ignore */
              }
              try {
                document.querySelectorAll('video, audio, source').forEach((el) => {
                  const s = (el.currentSrc || el.src || '').toString();
                  if (RE.test(s) && !found.includes(s)) found.push(s);
                });
              } catch (err) {
                /* ignore */
              }
              return { urls: found, pageUrl: location.href, title: document.title };
            },
          });

          const unique = new Map(); // url -> pageUrl
          for (const r of results) {
            const res = r && r.result;
            if (!res || !Array.isArray(res.urls)) continue;
            for (const u of res.urls) {
              if (!unique.has(u)) unique.set(u, res.pageUrl || '');
            }
          }

          let playlists = 0;
          for (const [u, pageUrl] of unique) {
            if (looksLikePlaylistUrl(u)) {
              await record({
                tabId: msg.tabId,
                url: u,
                documentUrl: pageUrl,
                initiator: pageUrl,
                contentType: '',
                type: 'scan',
              });
              playlists++;
            } else if (looksLikeSegmentUrl(u)) {
              await maybeDerivePlaylist({
                tabId: msg.tabId,
                url: u,
                documentUrl: pageUrl,
                initiator: pageUrl,
                type: 'scan',
              });
            }
          }

          const note = `页面扫描: 共 ${unique.size} 个媒体资源，其中播放列表 ${playlists} 个`;
          console.log('[m3u8-sniffer]', note);
          await addDebug(note);
          sendResponse({
            ok: true,
            found: playlists,
            total: unique.size,
            raw: [...unique.keys()].slice(0, 40),
          });
        } catch (e) {
          console.warn('[m3u8-sniffer] 扫描失败', e);
          await addDebug('页面扫描注入失败: ' + (e && e.message));
          sendResponse({ error: (e && e.message) || '扫描注入失败' });
        }
      })();
      return true;
    }
    case 'inspect': {
      (async () => {
        const entry = await store.getById(msg.tabId, msg.id);
        if (!entry) return sendResponse({ error: '找不到条目' });
        const text = await fetchText(entry.url, new AbortController().signal);
        const parsed = parsePlaylist(text, entry.url);
        if (parsed.isMaster) {
          entry.inspected = true;
          await store.addStream(entry);
          return sendResponse({
            type: 'master',
            variants: parsed.variants.map((v) => ({
              name: v.name,
              resolution: v.resolution,
              bandwidth: v.bandwidth,
            })),
          });
        }
        const encrypted = parsed.segments.some((s) => s.key);
        return sendResponse({
          type: 'media',
          segmentCount: parsed.segments.length,
          duration: parsed.segments.reduce((a, s) => a + (s.duration || 0), 0),
          encrypted,
          endList: parsed.endList,
          firstSegName: parsed.segments[0]?.uri.split('/').pop(),
        });
      })();
      return true;
    }
    case 'download':
      // startDownload 为异步流程，弹窗不依赖其返回值（进度由广播传递）
      startDownload(msg);
      return false;
    case 'cancel':
      return sendResponse(cancelDownload(msg));
    // 以下消息由 offscreen 文档执行合并时广播而来（弹窗同步收到），
    // 后台仅负责把状态写入持久化历史，供弹窗重开时恢复。
    case 'download-start':
      patchDownloadInfo(msg.id, (e) => {
        e.state = 'running';
        e.stage = '开始合并';
        e.ts = Date.now();
      });
      return false;
    case 'download-writing':
      patchDownloadInfo(msg.id, (e) => {
        e.state = 'running';
        e.stage = '写入磁盘';
        e.ts = Date.now();
      });
      return false;
    case 'download-progress':
      patchDownloadInfo(msg.id, (e) => {
        e.state = 'running';
        e.stage = '下载分片并合并…';
        e.progress = { done: msg.done, total: msg.total || 1 };
        e.ts = Date.now();
      });
      return false;
    case 'download-done':
      patchDownloadInfo(msg.id, (e) => {
        e.state = 'done';
        e.stage = '已完成';
        e.filename = msg.filename || e.filename || '';
        e.downloadId = msg.downloadId;
        e.bytes = msg.bytes;
        e.segmentCount = msg.segmentCount;
        e.ts = Date.now();
      });
      return false;
    case 'download-failed':
      patchDownloadInfo(msg.id, (e) => {
        e.state = 'failed';
        e.stage = '失败';
        e.error = msg.error || '下载失败';
        e.ts = Date.now();
      });
      return false;
    case 'download-cancelled':
      patchDownloadInfo(msg.id, (e) => {
        e.state = 'cancelled';
        e.stage = '已取消';
        e.ts = Date.now();
      });
      return false;
    case 'dl-beat':
      return false; // offscreen 心跳，仅用于保持服务唤醒
    default:
      return false;
  }
});

// 清理：刷新时清空不再存在的标签页的角标
chrome.tabs.onRemoved.addListener((tabId) => {
  lastBadge.delete(tabId);
});

console.log('[m3u8-sniffer] service worker ready');
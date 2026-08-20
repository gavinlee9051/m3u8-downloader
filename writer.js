// 写盘器（经典脚本，无任何 import）：
// 从 IndexedDB 读取后台写入的分片字节 → 拼回 Blob → 写进浏览器下载列表。
// 二进制不经过 runtime 消息（部分内核的二进制序列化不可靠），只走共享的 IndexedDB。
// 部分浏览器会忽略 downloads.download 的 filename 参数（保存名变成随机 UUID），
// 此时自动取消并在本窗口提供 <a download> 点击保存（该属性几乎被所有内核尊重）。
'use strict';

const DB_NAME = 'm3u8-writer';
const STORE = 'store';
let busy = false;

const $ = (id) => document.getElementById(id);
$('fb-save').addEventListener('click', () => {
  if (!pendingClick || !pendingClick.meta) return;
  const name = safeFilename($('fb-name').value, pendingClick.meta.ext);
  const a = document.createElement('a');
  a.href = pendingClick.url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  $('fb-tip').textContent = '已触发保存，请在弹出的对话框中选择位置（或在下载列表查看）';
});

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function clearStore(db, mode) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getAllParts(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(tx.error);
  });
}

setInterval(() => {
  // 合并中、等待点击或文件写入中都要保持后台存活
  if (busy) chrome.runtime.sendMessage({ type: 'dl-beat' }).catch(() => {});
}, 5000);

chrome.downloads.onChanged.addListener((delta) => {
  const job = pendingJobs.get(delta.id);
  if (!job || !delta.state) return;
  if (delta.state.current === 'complete') {
    pendingJobs.delete(delta.id);
    expectedNames.delete(delta.id);
    clearTimeout(job.fallbackRevoke);
    URL.revokeObjectURL(job.url);
    chrome.downloads.search({ id: delta.id }, (items) => {
      const actual = (items && items[0] && items[0].filename) || job.filename;
      emit('download-done', {
        tabId: job.meta.tabId,
        id: job.meta.id,
        filename: actual,
        renamed: actual.toLowerCase() !== job.filename.toLowerCase(),
        downloadId: delta.id,
        bytes: job.meta.bytes,
        segmentCount: job.meta.segmentCount,
        ext: job.meta.ext,
      });
    });
    afterJob();
  } else if (delta.state.current === 'interrupted') {
    pendingJobs.delete(delta.id);
    expectedNames.delete(delta.id);
    clearTimeout(job.fallbackRevoke);
    if (!job.ignoreInterrupt) {
      URL.revokeObjectURL(job.url);
      emit('download-failed', { tabId: job.tabId, id: job.id, error: '下载被中断（磁盘空间或权限问题？）' });
      afterJob();
    }
  }
});

const pendingJobs = new Map(); // downloadId -> { url, meta, filename, fallbackRevoke, ignoreInterrupt }
const expectedNames = new Map(); // downloadId -> expected filename
let pendingClick = null; // { url, meta, expectedName }

window.addEventListener('unload', () => {
  if (pendingClick) URL.revokeObjectURL(pendingClick.url);
  pendingClick = null;
});

function afterJob() {
  if (pendingClick) {
    URL.revokeObjectURL(pendingClick.url);
    pendingClick = null;
  }
  $('fb-tip').textContent = '';
  $('fallback')?.classList.add('hidden');
  $('idle')?.classList.remove('hidden');
  busy = false;
}

function showClickFallback(meta, url, expectedName) {
  if (!meta || !url) return;
  pendingClick = { url, meta, expectedName };
  busy = true;
  chrome.windows.getCurrent((w) => {
    if (w) chrome.windows.update(w.id, { state: 'normal', focused: true }).catch(() => {});
  });
  if ($('fb-name')) $('fb-name').value = expectedName.replace(/\.\w+$/, '');
  $('idle')?.classList.add('hidden');
  $('fallback')?.classList.remove('hidden');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function sameName(a, b) {
  const norm = (s) =>
    String(s || '')
      .replace(/\s*\(\d+\)(?=\.[^.]+$|$)/i, '')
      .replace(/\s*-\d+(?=\.[^.]+$|$)/i, '')
      .toLowerCase();
  return norm(a) === norm(b) || (Boolean(a) && Boolean(b) && UUID_RE.test(a));
}

// 核验下载管理器实际采用的文件名；若被浏览器改写（随机 UUID），立即取消并走点击保存
chrome.downloads.onCreated.addListener((item) => {
  let exp = expectedNames.get(item.id);
  if (!exp && pendingClick && sameName(item.filename, pendingClick.expectedName)) {
    // 点击保存的下载：登记为我们的任务，完成时上报
    exp = pendingClick.expectedName;
    expectedNames.set(item.id, exp);
    const fbRev = setTimeout(() => URL.revokeObjectURL(pendingClick.url), 600000);
    pendingJobs.set(item.id, {
      url: pendingClick.url,
      filename: exp,
      meta: pendingClick.meta,
      fallbackRevoke: fbRev,
      ignoreInterrupt: false,
    });
    return;
  }
  if (!exp) return; // 非本插件发起的下载
  if (sameName(item.filename, exp)) return; // 文件名符合预期
  // 浏览器忽略了 filename（随机 UUID）：取消，改用 <a download> 点击保存
  const job = pendingJobs.get(item.id);
  if (job) job.ignoreInterrupt = true;
  chrome.downloads.cancel(item.id, () => {});
  pendingJobs.delete(item.id);
  expectedNames.delete(item.id);
  showClickFallback(job ? job.meta : null, job ? job.url : '', exp);
});

const EXT_MIME = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  ts: 'video/mp2t',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
};

function mimeFor(ext) {
  return EXT_MIME[ext] || 'video/mp4';
}

function safeFilename(name, ext) {
  let s = String(name || 'video')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!s) s = 'video';
  const extRe = ext ? new RegExp(`\\.${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') : null;
  if (ext && !extRe.test(s)) s += '.' + ext;
  return s;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  switch (msg.type) {
    case 'dl-ping':
      sendResponse({ pong: true, v: 3 });
      return false;
    case 'dl-run-idb':
      busy = true;
      assembleFromIdb(msg)
        .catch(() => {})
        .finally(() => (busy = false));
      sendResponse({ started: true });
      return false;
    case 'dl-cancel':
      sendResponse({ cancelled: true });
      return false;
  }
});

function emit(type, extra) {
  try {
    chrome.runtime.sendMessage({ type, ...extra }).catch(() => {});
  } catch (e) {
    /* ignore */
  }
}

async function assembleFromIdb(meta) {
  try {
    const emitFail = (m) => emit('download-failed', { tabId: meta.tabId, id: meta.id, error: m });
    const db = await openIdb();
    const parts = await getAllParts(db);
    if (!meta.count || parts.length < meta.count) {
      emitFail('分片数据缺失，无法拼装');
      await clearStore(db, 'readwrite').catch(() => {});
      db.close();
      return;
    }
    const blob = new Blob(parts, { type: mimeFor(meta.ext) });
    await clearStore(db, 'readwrite').catch(() => {});
    db.close();

    const url = URL.createObjectURL(blob);
    const fallbackRevoke = setTimeout(() => URL.revokeObjectURL(url), 600000);
    const filename = safeFilename(meta.filename, meta.ext);
    chrome.downloads.download(
      {
        url,
        filename,
        conflictAction: 'uniquify',
        saveAs: !!meta.saveAs,
      },
      (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) {
          clearTimeout(fallbackRevoke);
          URL.revokeObjectURL(url);
          emitFail(err.message || '下载写入失败');
          return;
        }
        pendingJobs.set(downloadId, {
          url,
          fallbackRevoke,
          filename,
          meta,
          ignoreInterrupt: false,
        });
        expectedNames.set(downloadId, filename);
        emit('download-writing', {
          tabId: meta.tabId,
          id: meta.id,
          filename,
          bytes: meta.bytes,
        });
      }
    );
  } catch (e) {
    emit('download-failed', { tabId: meta.tabId, id: meta.id, error: (e && e.message) || String(e) });
  }
}
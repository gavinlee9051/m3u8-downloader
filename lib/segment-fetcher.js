// 分片拉取、AES-128 解密与拼接管线
// 依赖浏览器 fetch / WebCrypto；扩展后台因 host_permissions 可绕过 CORS。

import { deriveIv } from './m3u8-parser.js';

const DEFAULT_RETRIES = 3;
const DEFAULT_CONCURRENCY = 16;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRangeHeader(byteRange) {
  if (!byteRange) return null;
  const start = byteRange.offset ?? 0;
  return `bytes=${start}-${start + byteRange.length - 1}`;
}

// 拉取二进制，支持 Range 请求、指数退避重试、AbortSignal
export async function fetchBuffer(url, { range, retries = DEFAULT_RETRIES, signal } = {}) {
  const headers = {};
  if (range) headers.Range = toRangeHeader(range);
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers, credentials: 'include', signal });
      if (res.status !== 200 && res.status !== 206) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const buf = await res.arrayBuffer();
      if (range && res.status === 200) {
        // 服务器忽略 Range：手动截取
        const start = range.offset ?? 0;
        return buf.slice(start, start + range.length).buffer;
      }
      return buf;
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') throw err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr || new Error('拉取失败');
}

// 探测分片大小（用于进度计算），用 Range 请求取 Content-Range/Content-Length
async function probeSize(url, byteRange, { signal } = {}) {
  const headers = { Range: 'bytes=0-0' };
  const res = await fetch(url, { headers, credentials: 'include', signal });
  if (res.body) await res.body.cancel();
  if (res.status === 206) {
    const cr = res.headers.get('Content-Range');
    const m = cr && cr.match(/^bytes 0-0\/(\d+)$/);
    if (m) return parseInt(m[1], 10);
    const len = res.headers.get('Content-Length');
    if (len) return parseInt(len, 10) + 1;
    return Math.max((byteRange && byteRange.length) || 1, 0);
  }
  if (res.status === 200) {
    const len = res.headers.get('Content-Length');
    if (len) return parseInt(len, 10);
  }
  return byteRange ? byteRange.length || 1 : 1;
}

// 部分运行环境（如 Node webcrypto）解密后仍保留 PKCS7 填充，需手动校验并去除；
// 浏览器环境自动去除，此处校验后按需剥离，对两种行为都安全。
function stripPkcs7(bytes) {
  if (bytes.length === 0) return bytes;
  const padLen = bytes[bytes.length - 1];
  if (padLen >= 1 && padLen <= 16 && padLen <= bytes.length) {
    let valid = true;
    for (let i = bytes.length - padLen; i < bytes.length; i++) {
      if (bytes[i] !== padLen) {
        valid = false;
        break;
      }
    }
    if (valid) return bytes.slice(0, bytes.length - padLen);
  }
  return bytes;
}

// AES-128-CBC 解密单块（HLS 使用 PKCS#7 填充）
export async function aesDecrypt(keyBytes, ivBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  const out = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, data);
  return stripPkcs7(new Uint8Array(out));
}

// 探测分片容器类型：TS (0x47 同步字节) vs fMP4 (ftyp)
function detectContainer(firstBytes) {
  if (!firstBytes || firstBytes.length < 12) return 'unknown';
  const tag = String.fromCharCode(...firstBytes.subarray(4, 8));
  if (tag === 'ftyp') return 'mp4';
  if (firstBytes[0] === 0x47) return 'ts';
  return 'unknown';
}

export function containerInfo(container) {
  if (container === 'mp4') return { mime: 'video/mp4', ext: 'mp4' };
  return { mime: 'video/mp2t', ext: 'ts' };
}

/**
 * 下载并合并整个播放列表。
 * @param {object} playlist parsePlaylist 解析出的媒体播放列表
 * @param {object} opts { onProgress, signal, concurrent, retries }
 * @returns {Promise<{blob: Blob, ext, mime, totalBytes, segments}>}
 */
export async function downloadAndMerge(playlist, opts = {}) {
  const {
    onProgress = () => {},
    signal,
    concurrent = DEFAULT_CONCURRENCY,
    retries = DEFAULT_RETRIES,
  } = opts;

  const segments = playlist.segments;
  if (!segments.length) throw new Error('播放列表中没有任何分片');

  const abort = () => {
    if (signal && signal.aborted) throw signal.reason || new DOMException('已取消', 'AbortError');
  };

  // 收集需要一次性下载的 init segments（去重）
  const inits = [];
  const seenInit = new Set();
  for (const s of segments) {
    if (s.init) {
      const keyUri = s.init.uri + (s.init.byteRange ? `#${s.init.byteRange.offset || 0}` : '');
      if (!seenInit.has(keyUri)) {
        seenInit.add(keyUri);
        inits.push(s.init);
      }
    }
  }

  const keyCache = new Map();
  const queue = segments.map((seg, i) => i);
  const parts = new Array(segments.length);
  const initParts = inits.map(() => null);

  // 不做单独的“大小探测”：避免不支持 Range 的服务器导致每个分片被整段下载两次（翻倍耗时）。
  let doneBytes = 0;
  let doneCount = 0;

  const workers = Array.from({ length: Math.min(Math.max(concurrent, 1), segments.length) }, async () => {
    let idx;
    while ((idx = queue.shift()) !== undefined) {
      abort();
      const seg = segments[idx];

      const initIdx = seg.init ? inits.indexOf(seg.init) : -1;
      if (initIdx >= 0 && !initParts[initIdx]) {
        const initBytes = await fetchBuffer(seg.init.uri, {
          range: seg.init.byteRange || null,
          signal,
          retries,
        });
        initParts[initIdx] = new Uint8Array(initBytes);
        doneBytes += initBytes.byteLength;
        onProgress({ done: doneCount, total: segments.length, phase: 'count', bytes: doneBytes });
      }

      let raw = await fetchBuffer(seg.uri, {
        range: seg.byteRange || null,
        signal,
        retries,
      });

      if (seg.key) {
        if (!keyCache.has(seg.key.uri)) {
          const keyBytes = await fetchBuffer(seg.key.uri, { signal, retries });
          if (keyBytes.byteLength !== 16) throw new Error('AES-128 密钥长度不正确');
          keyCache.set(seg.key.uri, new Uint8Array(keyBytes));
        }
        const iv = seg.key.iv || deriveIv(seg.sequence);
        raw = await aesDecrypt(keyCache.get(seg.key.uri), iv, raw);
      }

      parts[idx] = new Uint8Array(raw);
      doneBytes += raw.byteLength;
      doneCount++;
      onProgress({ done: doneCount, total: segments.length, phase: 'count', bytes: doneBytes });
    }
  });

  await Promise.all(workers);

  // 组装输出
  const blobParts = [];
  for (let i = 0; i < initParts.length; i++) {
    if (initParts[i]) blobParts.push(initParts[i]);
  }
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) throw new Error(`分片 ${i} 下载失败`);
    blobParts.push(parts[i]);
  }

  const container = detectContainer(parts[0]);
  const { mime, ext } = containerInfo(container);

  onProgress({ done: doneBytes, total: doneBytes, phase: 'done' });

  return {
    blob: new Blob(blobParts, { type: mime }),
    parts: blobParts,
    ext,
    mime,
    totalBytes: doneBytes,
    segmentCount: segments.length,
    container,
  };
}
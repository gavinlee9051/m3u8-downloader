// 轻量 HLS 播放列表解析器（HLS v7 常用子集）
// 纯 ESM、无依赖，可同时用于扩展 Service Worker 与 Node 单元测试。

export function resolveUrl(ref, base) {
  if (!ref || !ref.trim()) throw new Error('空 URL');
  try {
    return new URL(ref, base).href;
  } catch {
    throw new Error('无法解析 URL: ' + ref);
  }
}

export function hexToBytes(hex) {
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

// 无显式 IV 时由媒体序号推导（16 字节大端）
export function deriveIv(sequence) {
  const iv = new Uint8Array(16);
  let val = BigInt(sequence);
  for (let i = 15; i >= 0; i--) {
    iv[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return iv;
}

// "length@offset" 或 "length"
export function parseByteRange(spec) {
  if (!spec) return null;
  const [lenStr, offStr] = spec.split('@');
  const length = parseInt(lenStr, 10);
  if (Number.isNaN(length)) return null;
  const offset = offStr ? parseInt(offStr, 10) : undefined;
  if (offStr && Number.isNaN(offset)) return { length };
  return { length, offset: offStr ? offset : undefined };
}

function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Za-z0-9-]+)=((?:"([^"]*)")|([^,\s]*))/g;
  let m;
  while ((m = re.exec(str))) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
  }
  return attrs;
}

function normalizeKey(key, baseUri) {
  if (!key) return null;
  return {
    uri: resolveUrl(key.uri, baseUri),
    iv: key.iv ?? null,
  };
}

export function parsePlaylist(text, baseUri) {
  const lines = String(text).split(/\r?\n/);
  let type = null; // 'master' | 'media'
  const variants = [];
  const segments = [];
  let pendingVariant = null;
  let pendingExtinf = false;
  let currentKey = null;
  let currentByteRange = null;
  let currentMap = null;
  let endList = false;
  let mediaSequence = 0;
  let version = 1;

  function pushSegment(uri) {
    const sequence = mediaSequence + segments.length;
    let key = null;
    if (currentKey && currentKey.method === 'AES-128') {
      let iv = currentKey.ivBytes || null;
      if (!iv) iv = deriveIv(sequence);
      key = {
        method: 'AES-128',
        uri: currentKey.uri ? resolveUrl(currentKey.uri, baseUri) : null,
        iv,
      };
    }
    segments.push({
      uri: resolveUrl(uri, baseUri),
      duration: pendingExtinf || 0,
      sequence,
      key,
      byteRange: currentByteRange || null,
      init: currentMap
        ? { uri: resolveUrl(currentMap.uri, baseUri), byteRange: currentMap.byteRange || null }
        : null,
    });
    pendingExtinf = false;
    currentByteRange = null;
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line === '#EXTM3U') continue;

    if (line.startsWith('#EXT-X-VERSION')) {
      version = parseInt(line.split(':')[1], 10) || 1;
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      type = 'master';
      const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      pendingVariant = {
        bandwidth: parseInt(attrs.BANDWIDTH, 10) || 0,
        avgBandwidth: parseInt(attrs['AVERAGE-BANDWIDTH'], 10) || 0,
        resolution: attrs.RESOLUTION || '',
        codecs: attrs.CODECS || '',
        name: attrs.NAME || attrs.RESOLUTION || 'bitrate_' + (parseInt(attrs.BANDWIDTH, 10) || 0),
      };
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA')) {
      // v1 暂忽略音轨/字幕渲染，全部由视频变体承担
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      if (attrs.METHOD === 'AES-128') {
        currentKey = {
          method: 'AES-128',
          uri: attrs.URI ? attrs.URI : null,
          ivBytes: attrs.IV ? hexToBytes(attrs.IV) : null,
        };
      } else if (attrs.METHOD === 'NONE') {
        currentKey = null;
      }
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      currentMap = { uri: attrs.URI, byteRange: parseByteRange(attrs.BYTERANGE) };
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      currentByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const val = line.slice('#EXTINF:'.length);
      pendingExtinf = parseFloat(val.split(',')[0]) || 0;
      continue;
    }
    if (line === '#EXT-X-ENDLIST') {
      endList = true;
      continue;
    }
    if (line.startsWith('#')) continue;

    if (type === 'master' && pendingVariant) {
      variants.push({
        uri: resolveUrl(line, baseUri),
        bandwidth: pendingVariant.bandwidth,
        avgBandwidth: pendingVariant.avgBandwidth,
        resolution: pendingVariant.resolution,
        codecs: pendingVariant.codecs,
        name: pendingVariant.name,
      });
      pendingVariant = null;
      continue;
    }
    // 媒体播放列表里的真实 URI：分片
    if (pendingExtinf !== false) {
      pushSegment(line);
      continue;
    }
    if (type !== 'master' && (line.startsWith('http') || !line.includes('=')) && !line.startsWith('#')) {
      // 无 EXTINF 的裸 URI（少见），按分片处理
      pushSegment(line);
    }
  }

  if (type === null) {
    type = segments.length > 0 ? 'media' : 'unknown';
  }

  return {
    type,
    version,
    variants,
    segments,
    endList,
    mediaSequence,
    isMaster: type === 'master',
  };
}

// 选择最高带宽（其次分辨率）的变体
export function pickBestVariant(variants) {
  if (!variants.length) return null;
  return variants.reduce((best, v) => {
    const vScore = v.bandwidth || v.avgBandwidth || 0;
    const bScore = best.bandwidth || best.avgBandwidth || 0;
    if (vScore !== bScore) return vScore > bScore ? v : best;
    const vRes = parseInt(v.resolution.split('x')[0], 10) || 0;
    const bRes = parseInt(best.resolution.split('x')[0], 10) || 0;
    return vRes > bRes ? v : best;
  }, variants[0]);
}
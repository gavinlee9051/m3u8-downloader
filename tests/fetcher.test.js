import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { downloadAndMerge, aesDecrypt } from '../lib/segment-fetcher.js';
import { deriveIv, parsePlaylist } from '../lib/m3u8-parser.js';

// ---------- 工具：在内存中生成测试流 ----------

function makeSegments(count, { encrypt = false, keyBytes, blockLen = 1024 } = {}) {
  const segs = [];
  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(blockLen);
    for (let j = 0; j < blockLen; j++) bytes[j] = (i * 31 + j) % 251;
    if (encrypt) {
      const iv = deriveIv(i);
      // 使用 WebCrypto 加密（PKCS7 填充），解密侧同样用 WebCrypto
      const raw = bytes;
      const padLen = 16 - (raw.length % 16);
      const padded = new Uint8Array(raw.length + padLen).fill(padLen);
      padded.set(raw);
      const enc = crypto.subtle
        .importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt'])
        .then((k) => crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, padded));
      segs.push(enc);
    } else {
      segs.push(Promise.resolve(bytes));
    }
  }
  return segs;
}

// 启动一个简单的 HLS 服务，返回 { url, close }
function startServer(scene) {
  const { segments, keyBytes, withMaster, byteRanges } = scene;
  const enc = Boolean(keyBytes);

  const routes = new Map();
  const segData = new Map(); // index -> Uint8Array

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (body, type = 'application/octet-stream', status = 200, extra = {}) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': buf.length,
        ...extra,
      });
      res.end(buf);
    };

    const mediaText = () => {
      const n = byteRanges ? byteRanges.length : segments.length;
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0'];
      if (enc) lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="/key.bin"`);
      for (let i = 0; i < n; i++) {
        lines.push(`#EXTINF:1.0,`);
        if (byteRanges && byteRanges[i]) {
          lines.push(`#EXT-X-BYTERANGE:${byteRanges[i].length}@${byteRanges[i].offset}`);
          lines.push(`seg.mp4`);
        } else {
          lines.push(`seg${i}.ts`);
        }
      }
      lines.push('#EXT-X-ENDLIST');
      return lines.join('\n');
    };

    if (u.pathname === '/key.bin') {
      send(Buffer.from(keyBytes));
      return;
    }
    if (u.pathname === '/playlist.m3u8' || u.pathname === '/low/playlist.m3u8') {
      send(mediaText(), 'application/vnd.apple.mpegurl');
      return;
    }
    if (u.pathname === '/master.m3u8') {
      send(
        [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360',
          'low/playlist.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080',
          'playlist.m3u8',
        ].join('\n'),
        'application/vnd.apple.mpegurl'
      );
      return;
    }
    // 分片：/segN.ts 与 /low/segN.ts
    const segMatch = u.pathname.match(/^\/(?:low\/)?seg(\d+)\.ts$/);
    if (segMatch) {
      const idx = parseInt(segMatch[1], 10);
      if (byteRanges) {
        const { offset, length } = byteRanges[idx];
        const full = await segments[0]; // 同一文件
        let range = req.headers.range;
        if (range) {
          const m = range.match(/bytes=(\d+)-(\d+)/);
          const s = m ? parseInt(m[1], 10) : offset;
          const e = m ? parseInt(m[2], 10) : offset + length - 1;
          res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Range': `bytes ${s}-${e}/${full.length}`,
            'Content-Length': e - s + 1,
          });
          res.end(full.slice(s, e + 1));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': full.length });
        res.end(full);
        return;
      }
      send(Buffer.from(await segments[idx]));
      return;
    }
    if (u.pathname === '/seg.mp4') {
      // BYTERANGE 场景：所有分片共用一个大文件
      const full = new Uint8Array(64 * 1024);
      for (let j = 0; j < full.length; j++) full[j] = (j * 7) % 253;
      let range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d+)/);
        const s = parseInt(m[1], 10);
        const e = parseInt(m[2], 10);
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${s}-${e}/${full.length}`,
          'Content-Length': e - s + 1,
        });
        res.end(full.slice(s, e + 1));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': full.length });
      res.end(full);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

// ---------- 测试 ----------

test('aesDecrypt 还原 PKCS7 填充密文', async () => {
  const keyBytes = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const msg = new TextEncoder().encode('hello m3u8 downloader');
  const padLen = 16 - (msg.length % 16);
  const padded = new Uint8Array(msg.length + padLen).fill(padLen);
  padded.set(msg);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  const enc = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, padded);
  const dec = await aesDecrypt(keyBytes, iv, enc);
  assert.deepEqual([...dec], [...msg]);
});

test('明文流：合并分片并拼出正确内容', async () => {
  const segments = await Promise.all(makeSegments(3));
  const expected = Buffer.concat(segments.map((s) => Buffer.from(s)));

  const srv = await startServer({ segments });
  try {
    const playlistText = await (await fetch(srv.base + '/playlist.m3u8')).text();
    const playlist = parsePlaylist(playlistText, srv.base + '/playlist.m3u8');
    assert.equal(playlist.segments.length, 3);

    let lastDone = 0;
    const result = await downloadAndMerge(playlist, {
      onProgress: (p) => (lastDone = p.done),
    });
    assert.equal(result.ext, 'ts');
    assert.equal(result.totalBytes, expected.length);
    assert.equal(lastDone, expected.length);
    const out = Buffer.from(await result.blob.arrayBuffer());
    assert.deepEqual(out, expected);
  } finally {
    srv.close();
  }
});

test('master 播放列表：解析变体，按各自 base 下载任意画质', async () => {
  const segments = await Promise.all(makeSegments(2));
  const srv = await startServer({ segments });
  try {
    const masterText = await (await fetch(srv.base + '/master.m3u8')).text();
    const master = parsePlaylist(masterText, srv.base + '/master.m3u8');
    assert.equal(master.isMaster, true);
    assert.equal(master.variants.length, 2);

    // 低/高画质各自解析并下载
    for (const variant of master.variants) {
      const text = await (await fetch(variant.uri)).text();
      const playlist = parsePlaylist(text, variant.uri);
      assert.equal(playlist.isMaster, false);
      const result = await downloadAndMerge(playlist);
      assert.equal(result.segmentCount, 2);
      assert.ok(result.blob.size > 0);
    }
  } finally {
    srv.close();
  }
});

test('AES-128 加密流：逐分片解密后合并', async () => {
  const keyBytes = crypto.getRandomValues(new Uint8Array(16));
  const segments = await Promise.all(makeSegments(4, { encrypt: true, keyBytes }));
  // 期望解密结果
  const plain = [];
  for (let i = 0; i < 4; i++) {
    const raw = new Uint8Array(1024);
    for (let j = 0; j < raw.length; j++) raw[j] = (i * 31 + j) % 251;
    plain.push(raw);
  }
  const expected = Buffer.concat(plain.map((s) => Buffer.from(s)));

  const srv = await startServer({ segments, keyBytes });
  try {
    const playlistText = await (await fetch(srv.base + '/playlist.m3u8')).text();
    const playlist = parsePlaylist(playlistText, srv.base + '/playlist.m3u8');
    assert.ok(playlist.segments.every((s) => s.key && s.key.iv));
    const result = await downloadAndMerge(playlist, { concurrent: 3, retries: 1 });
    const out = Buffer.from(await result.blob.arrayBuffer());
    assert.deepEqual(out, expected);
  } finally {
    srv.close();
  }
});

test('BYTERANGE 分片：Range 请求正确解析', async () => {
  // 构造 2 个 BYTERANGE 分片，指向同一文件不同区间
  const byteRanges = [
    { offset: 0, length: 1000 },
    { offset: 2000, length: 1500 },
  ];
  const serverSeg = [Promise.resolve(new Uint8Array(64 * 1024))];
  const srv = await startServer({ segments: serverSeg, byteRanges });
  try {
    const playlistText = await (await fetch(srv.base + '/playlist.m3u8')).text();
    const playlist = parsePlaylist(playlistText, srv.base + '/playlist.m3u8');
    assert.equal(playlist.segments.length, 2);
    assert.equal(playlist.segments[1].byteRange.length, 1500);
    const result = await downloadAndMerge(playlist, { retries: 1 });
    const out = new Uint8Array(await result.blob.arrayBuffer());
    assert.equal(out.length, 1000 + 1500);
    // 内容校验：区间 0-1000 来自大文件 [0,1000)，区间 1000-2500 来自大文件 [2000,3500)
    const full = new Uint8Array(64 * 1024);
    for (let j = 0; j < full.length; j++) full[j] = (j * 7) % 253;
    for (let j = 0; j < 1000; j++) assert.equal(out[j], full[j]);
    for (let j = 0; j < 1500; j++) assert.equal(out[1000 + j], full[2000 + j]);
  } finally {
    srv.close();
  }
});
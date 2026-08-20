import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlaylist,
  resolveUrl,
  deriveIv,
  parseByteRange,
  pickBestVariant,
  hexToBytes,
} from '../lib/m3u8-parser.js';

test('resolveUrl 相对路径', () => {
  assert.equal(
    resolveUrl('seg1.ts', 'https://cdn.example.com/video/index.m3u8'),
    'https://cdn.example.com/video/seg1.ts'
  );
  assert.equal(
    resolveUrl('../key.bin', 'https://cdn.example.com/video/index.m3u8'),
    'https://cdn.example.com/key.bin'
  );
  assert.throws(() => resolveUrl('', 'https://a.b/'));
});

test('解析 master 播放列表', () => {
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1200000,RESOLUTION=960x540,CODECS="avc1.4d401f,mp4a.40.2"
low/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720,NAME="720p"
mid/playlist.m3u8`;
  const p = parsePlaylist(text, 'https://cdn.example.com/video/master.m3u8');
  assert.equal(p.type, 'master');
  assert.equal(p.isMaster, true);
  assert.equal(p.variants.length, 2);
  assert.equal(p.variants[0].bandwidth, 1280000);
  assert.equal(p.variants[0].resolution, '960x540');
  assert.equal(p.variants[0].uri, 'https://cdn.example.com/video/low/playlist.m3u8');
  assert.equal(p.variants[1].name, '720p');
  assert.equal(p.segments.length, 0);
});

test('解析 media 播放列表 + AES-128 + IV 推导', () => {
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:7
#EXTINF:9.009,
seg1.ts
#EXTINF:9.009,
seg2.ts
#EXT-X-KEY:METHOD=AES-128,URI="/crypto/key.bin"
#EXTINF:9.009,
seg3.ts
#EXT-X-ENDLIST`;
  const p = parsePlaylist(text, 'https://cdn.example.com/video/index.m3u8');
  assert.equal(p.type, 'media');
  assert.equal(p.isMaster, false);
  assert.equal(p.endList, true);
  assert.equal(p.mediaSequence, 7);
  assert.equal(p.segments.length, 3);
  assert.equal(p.segments[0].sequence, 7);
  assert.equal(p.segments[0].uri, 'https://cdn.example.com/video/seg1.ts');
  // 前两个分片未加密
  assert.equal(p.segments[0].key, null);
  assert.equal(p.segments[1].key, null);
  // 第三个分片 AES 加密，无显式 IV → 由序号 9 推导
  assert.equal(p.segments[2].key.uri, 'https://cdn.example.com/crypto/key.bin');
  const expect = new Uint8Array(16);
  expect[8] = 0;
  expect[9] = 0;
  expect[15] = 9;
  assert.deepEqual([...p.segments[2].key.iv], [...expect]);
});

test('显式 IV + EXT-X-BYTERANGE', () => {
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0102030405060708090a0b0c0d0e0f10
#EXTINF:5.0,
#EXT-X-BYTERANGE:1000@42
seg.mp4
#EXT-X-ENDLIST`;
  const p = parsePlaylist(text, 'https://cdn.example.com/video/index.m3u8');
  assert.deepEqual(
    [...p.segments[0].key.iv],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
  );
  assert.deepEqual(p.segments[0].byteRange, { length: 1000, offset: 42 });
});

test('hexToBytes 与 deriveIv 边界', () => {
  assert.deepEqual([...hexToBytes('0x0001')], [0, 1]);
  assert.deepEqual([...deriveIv(0)], new Array(16).fill(0));
  const b = deriveIv(1);
  assert.equal(b[15], 1);
  const c = deriveIv(0x1234567890);
  const expected = new Array(16).fill(0);
  expected[11] = 0x12;
  expected[12] = 0x34;
  expected[13] = 0x56;
  expected[14] = 0x78;
  expected[15] = 0x90;
  assert.deepEqual([...c], expected);
});

test('pickBestVariant 选择最高带宽', () => {
  const variants = [
    { name: 'a', bandwidth: 1000, resolution: '640x360' },
    { name: 'b', bandwidth: 4000, resolution: '1280x720' },
    { name: 'c', bandwidth: 2000, resolution: '960x540' },
  ];
  assert.equal(pickBestVariant(variants).name, 'b');
  assert.equal(pickBestVariant([]), null);
});

test('parseByteRange 综合', () => {
  assert.deepEqual(parseByteRange('1000@42'), { length: 1000, offset: 42 });
  assert.deepEqual(parseByteRange('500'), { length: 500, offset: undefined });
  assert.equal(parseByteRange(''), null);
  assert.equal(parseByteRange(undefined), null);
});

test('裸 URI 分片（无 EXTINF）', () => {
  const text = `#EXTM3U
seg_a.ts
seg_b.ts
#EXT-X-ENDLIST`;
  const p = parsePlaylist(text, 'https://cdn.example.com/video/index.m3u8');
  assert.equal(p.segments.length, 2);
});
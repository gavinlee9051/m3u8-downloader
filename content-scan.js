// 隔离世界内容脚本：处理页面的资源扫描请求（Performance API 与 DOM）
// 可靠的消息通道，不受 MAIN 世界注入时序影响。
(() => {
  'use strict';
  const RE = /\.(m3u8?|mpd|ts|m4s|mpegurl)(?:$|[?#])/i;
  const KEYRE = /(m3u8|mpd|mpegurl|hls|mushroom|playlist|manifest|videourl|\.ts\b)/i;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'scan-resources') return;

    let entries = [];
    try {
      entries = performance.getEntriesByType('resource');
    } catch (e) {
      /* ignore */
    }

    const media = [];
    const raw = [];
    for (const e of entries) {
      const u = String(e.name || '');
      if (!/^https?:/i.test(u)) continue;
      if (RE.test(u)) {
        media.push(u);
      } else if (KEYRE.test(u) && raw.length < 150) {
        raw.push(u);
      }
    }

    let videoSrc = [];
    try {
      document.querySelectorAll('video, audio, source').forEach((el) => {
        const s = (el.currentSrc || el.src || '').toString();
        if (s && /^https?:/i.test(s)) videoSrc.push(s);
      });
    } catch (e) {
      /* ignore */
    }

    sendResponse({
      urls: media,
      raw,
      videoSrc,
      pageUrl: location.href,
      title: document.title,
      totalEntries: entries.length,
    });
  });
})();
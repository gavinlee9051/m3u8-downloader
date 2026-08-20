// 主世界内容脚本：直接挂钩页面自身的 fetch / XMLHttpRequest，
// 将播放列表 / 分片请求上报给后台（附带精确 tabId 与响应 Content-Type）。
// 冗余备份 —— 即使 webRequest 因 worker 上下文漏看，这里也能补上。
(() => {
  'use strict';
  if (window.__m3u8SnifferInstalled) return;
  window.__m3u8SnifferInstalled = true;

  const PLAYLIST_RE = /\.(m3u8?|mpegurl|mpd)(?:$|[?#])/i;
  const SEGMENT_RE = /\.(ts|m4s)(?:$|[?#])/i;
  const CT_RE = /(mpegurl|x-mpegurl|m3u8|dash\+xml)/i;

  let sentUrls = new Set();
  let dirsSeen = new Set();

  function isPlaylistByCT(ct) {
    return !!ct && CT_RE.test(ct);
  }

  function send(url, ct, kind) {
    try {
      if (!url || !/^https?:/i.test(String(url))) return;
      const u = String(url);
      const isPl = PLAYLIST_RE.test(u) || isPlaylistByCT(ct);
      const isSeg = !isPl && SEGMENT_RE.test(u);
      if (!isPl && !isSeg) return;

      if (isSeg) {
        // 分片数量巨大，每个目录只上报一次，交给后台反推播放列表
        let dir = '';
        try {
          dir = new URL(u).pathname.replace(/\/(?:[^/]+)$/, '');
        } catch {
          /* ignore */
        }
        if (!dir || dirsSeen.has(dir)) return;
        dirsSeen.add(dir);
      } else if (sentUrls.has(u)) {
        return;
      }
      sentUrls.add(u);
      chrome.runtime.sendMessage({
        type: 'page-stream',
        url: u,
        pageUrl: location.href,
        contentType: ct || '',
        kind,
      }).catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  // fetch
  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function (input, init) {
        let url = null;
        if (typeof input === 'string') url = input;
        else if (input && input.url) url = input.url;
        if (url) send(String(url), '', 'fetch-start');
        const p = nativeFetch.apply(this, arguments);
        if (url) {
          p.then((r) => {
            try {
              const ct = (r.headers && r.headers.get('content-type')) || '';
              if (isPlaylistByCT(ct)) send(r.url || String(url), ct, 'fetch-done');
            } catch (e) {
              /* ignore */
            }
          }).catch(() => {});
        }
        return p;
      };
    }
  } catch (e) {
    /* ignore */
  }

  // XMLHttpRequest
  try {
    const nativeOpen = XMLHttpRequest.prototype.open;
    if (!XMLHttpRequest.prototype.__m3u8Patched) {
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          if (url) {
            send(String(url), '', 'xhr-start');
            const xhr = this;
            const origOnLoadEnd = xhr.onloadend;
            xhr.addEventListener('loadend', function onLoadEnd() {
              xhr.removeEventListener('loadend', onLoadEnd);
              try {
                const ct = (xhr.getResponseHeader && xhr.getResponseHeader('Content-Type')) || '';
                if (isPlaylistByCT(ct)) send(xhr.responseURL || String(url), ct, 'xhr-done');
              } catch (e) {
                /* ignore */
              }
              if (typeof origOnLoadEnd === 'function') origOnLoadEnd.apply(xhr, arguments);
            });
          }
        } catch (e) {
          /* ignore */
        }
        return nativeOpen.apply(this, arguments);
      };
      Object.defineProperty(XMLHttpRequest.prototype, '__m3u8Patched', {
        value: true,
        configurable: false,
        writable: false,
      });
    }
  } catch (e) {
    /* ignore */
  }
})();
# M3u8 Sniffer & Downloader

> Chrome / Edge / 各类 Chromium 内核浏览器扩展:嗅探网页正在播放的 HLS(`.m3u8`)与 DASH(`.mpd`) 流媒体,一键下载、浏览器内合并全部分片,支持 AES-128 解密,自动保存为带正确文件名的本地视频。

- ✅ **Manifest V3**,零构建工具、零依赖,纯 JavaScript ES Modules
- ✅ 嗅探页面播放器发起的播放列表请求(URL 扩展名 + 响应头双重识别,可识别 token 化 / 无扩展名接口)
- ✅ `master` 多清晰度自动选择最高画质
- ✅ 并行拉取分片(默认 16,可在弹窗调 4/8/16/32)→ 顺序拼接 → 导出 `.ts` / `.mp4`
- ✅ AES-128-CBC 解密(WebCrypto,IV 来自 `#EXT-X-KEY` 或媒体序号推导)
- ✅ 跨域拉取:依赖 `host_permissions: <all_urls>` 绕过 CORS,无需任何站点配置
- ✅ 兼容无 `chrome.offscreen` API 的 Chromium 内核(通过扩展窗口 + IndexedDB 完成合并写盘)
- ✅ 文件名为"页面片名 + 正确后缀";对忽略 `downloads.download` 文件名参数的浏览器,自动降级为点击保存(`<a download>` 属性,绝大多数内核强制生效)

## 安装

1. 打开 `chrome://extensions`(Edge 为 `edge://extensions`,其他内核浏览器同理)
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**,选择本项目 `m3u8-downloader` 目录
4. 把插件图标固定到工具栏,打开播放 HLS 视频的页面即可

## 使用

1. 页面播放视频时,工具栏图标显示检测到流数量的角标
2. 点击图标打开弹窗:列表显示检测到的流(**可读名称 + URL + [下载] [复制]**)
3. 点 **下载**:后台解析(master 自动选最高画质)→ 并发拉取全部分片 → 合并 → 保存
   - AES-128 加密流自动解密;进度实时显示在弹窗内
   - 弹窗关闭也不影响:下载状态持久化,重开弹窗自动恢复
4. 页脚选项:勾选 **询问保存位置**、设置 **并行分片** 数量
5. 扫描不到时,可点弹窗内 **扫描页面媒体资源** 从页面 JS 资源中找回播放列表

## 工作原理

- **嗅探**:Service Worker 用 `chrome.webRequest.onBeforeRequest` 监听含播放列表特征(`.m3u8` / `.m3u` / `.mpd`)的请求,再用 `onCompleted`(带 `responseHeaders`)兜底识别无扩展名但响应为 `application/vnd.apple.mpegurl` 的接口;结果按"标签页 + URL"去重,并更新角标。
- **Worker 请求关联**:Service Worker / Worker 发出的请求 `tabId` 为 -1,后台按 `initiator` 主机名自动关联到真实标签页,不漏检。
- **分片反推播放列表**:观察到 `.ts` / `.m4s` 分片请求时,自动尝试 `index.m3u8` 等常见列表名并校验(`#EXTM3U` 开头才入列),即使直接抓不到 m3u8 请求也能找到列表。
- **页面扫描**:`chrome.scripting.executeScript({ allFrames: true })` 现场注入扫描器,收集页面上下文中出现过的媒体资源地址,与嗅探结果互补。
- **解析**:`lib/m3u8-parser.js` 手写轻量 HLS 解析器(无依赖),支持 master/media、`EXT-X-KEY`(AES-128)、`EXT-X-BYTERANGE`、`EXT-X-MAP`(fMP4)、`ENDLIST`、相对路径解析。
- **下载合并**:`lib/segment-fetcher.js` 以可配置并发(默认 16,指数退避重试)拉取分片,遇 AES-128 用 WebCrypto 解密(PKCS7);完成后拼接为单个 `Blob`。
- **写盘**:部分 Chromium 内核不提供 `chrome.offscreen` 与可靠的 Blob 消息序列化,故二进制经共享 **IndexedDB** 交给隐藏写盘窗口拼装;若浏览器忽略 `downloads.download` 的 `filename` 参数,写盘器检测到名称被改写后自动取消,弹出窗口用 `<a download>` 点击保存(名称可编辑),同时保留自动完成的正常通道。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `webRequest` + `host_permissions: <all_urls>` | 嗅探播放列表请求、后台跨域拉取分片 |
| `storage` | 检测结果(session)与下载历史 / 设置持久化 |
| `downloads` | 触发浏览器保存、打开下载项 |
| `tabs` / `scripting` | 按标签页管理流、注入页面扫描器 |
| `windows` | 创建隐藏写盘窗口完成合并写盘 |
| `unlimitedStorage` | 大视频合并在 IndexedDB 中不受配额限制 |

## 目录结构

```
manifest.json             # MV3 配置与权限
background.js             # 嗅探 + 下载编排 + 进度广播 + 生命周期
writer.html / writer.js   # 隐藏写盘窗口(经 IndexedDB 拼装 Blob 并保存)
content.js                # 页面脚本(MAIN 世界)挂钩 fetch/XHR,供页面扫描回溯
content-scan.js           # 页面扫描应答器(ISOLATED 世界)
lib/m3u8-parser.js        # HLS 播放列表解析
lib/segment-fetcher.js    # 分片拉取 / AES 解密 / 合并
lib/store.js              # 检测结果存储与去重
popup/                    # 弹窗 UI
tests/                    # node 单元测试(含端到端本地流服务器)
scripts/                  # 图标生成脚本
```

## 测试

依赖 Node.js 18+(内置 test runner、fetch、WebCrypto):

```bash
npm test        # 13 项:解析器 / AES 解密 / 端到端合并(本地 http 模拟 HLS 站点)
npm run icons   # 重新生成图标
```

## 已知限制

| 场景 | 行为 |
| --- | --- |
| 直播流(无 `#EXT-X-ENDLIST`) | 只下载当前播放窗口内可见的分片 |
| fMP4 分片(CMAF) | 拼接为 `.mp4` 保存,多数播放器可播;非严格 remux |
| 超大视频(数 GB) | 全部分片暂存内存 + IndexedDB,超出机器预算时建议改用 ffmpeg |
| DRM(Widevine / FairPlay 等) | 仅支持无 DRM 的 AES-128,DRM 流无法下载 |
| `EXT-X-BYTERANGE` | 支持连续区间;极端跨区间场景可能不完整 |
| `#EXT-X-MEDIA` 独立音轨/字幕 | 忽略,仅下载视频主体 |
| Token 极短的分片地址 | 自动重试 3 次,仍失败则终止并提示 |

> 请仅下载你有权访问的内容,遵守目标站点的服务条款与当地法律。本项目仅供学习与个人归档用途。

## 开发

- 修改后重新加载:扩展管理页 → 点插件的「刷新」
- Service Worker 用 `console.log` 调试;扩展页里点 **Service Worker** 链接打开 DevTools
- 嗅探规则、并发上限、重试次数集中在 `background.js` 与 `lib/segment-fetcher.js` 顶部常量
- `writer.js` 与后台的通信是带版本号(`v:3`)的探活协议,改动协议时同步更新 `background.js` 中的 `writerAlive()` 校验
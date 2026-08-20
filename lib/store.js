// 检测流存储：按 tab 维度去重，使用 chrome.storage.local（可靠、跨后台存活）。
// 优先 session.local 会话隔离；若环境不支持再回退 local。这里直接使用 local。
// 注意：chrome.storage 方法必须以 StorageArea 作为 this 调用，严禁解构/传裸引用，
// 否则会抛 "Illegal invocation: Function must be called on an object of type StorageArea"。
const KEY = 'streams_v1';
const MAX_PER_TAB = 200;

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (data) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(data);
    });
  });
}

function storageSet(obj) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(obj, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

async function read() {
  const data = await storageGet(KEY);
  return Array.isArray(data[KEY]) ? data[KEY] : [];
}

async function write(streams) {
  await storageSet({ [KEY]: streams });
}

export async function getAll() {
  return read();
}

export async function getTab(tabId) {
  const all = await read();
  return all.filter((s) => s.tabId === tabId);
}

export async function addStream(entry) {
  const all = await read();
  const idx = all.findIndex((s) => s.tabId === entry.tabId && s.url === entry.url);
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...entry, ts: Date.now() };
  } else {
    entry.ts = Date.now();
    all.unshift(entry);
  }
  const perTab = all.filter((s) => s.tabId === entry.tabId);
  if (perTab.length > MAX_PER_TAB) {
    const overflow = new Set(perTab.slice(MAX_PER_TAB).map((s) => s.tabId + '|' + s.ts));
    const trimmed = [];
    for (const s of all) {
      if (!overflow.has(s.tabId + '|' + s.ts)) trimmed.push(s);
    }
    await write(trimmed);
  } else {
    await write(all);
  }
}

export async function removeEntry(tabId, id) {
  const all = await read();
  await write(all.filter((s) => !(s.tabId === tabId && s.id === id)));
}

export async function clearTab(tabId) {
  const all = await read();
  await write(all.filter((s) => s.tabId !== tabId));
}

export async function clearAll() {
  await write([]);
}

export async function idFor(streams) {
  // 为存储中的每条记录补充稳定 id（如缺失）
  let changed = false;
  for (const s of streams) {
    if (!s.id) {
      s.id = `${s.tabId}_${crypto.randomUUID()}`;
      changed = true;
    }
  }
  if (changed) await write(streams);
  return streams;
}

export async function getById(tabId, id) {
  const all = await read();
  return all.find((s) => s.tabId === tabId && s.id === id) || null;
}
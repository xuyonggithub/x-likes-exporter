/**
 * X(Twitter) 点赞 -> 本地 Markdown
 *
 * 运行在页面主世界（MAIN world），因此：
 * - 可以直接 patch window.fetch / XMLHttpRequest，捕获 X 网页端自己拉的 GraphQL 响应（无需自己拼接口、无需 token）
 * - 可以直接用 File System Access API 写用户选中的本地文件
 *
 * 依赖页面自身的登录态，不做任何越权请求。
 */
(() => {
  'use strict';

  if (window.__xLikesExporterInstalled) return;
  window.__xLikesExporterInstalled = true;

  const DB_NAME = 'x-likes-exporter';
  const DB_VERSION = 1;
  const STORE_SEEN = 'seen';   // 已写入文件的推文 id
  const STORE_META = 'meta';   // 文件句柄等
  const API_RE = /\/i\/api\/(graphql|1\.1|2)\//;
  const HEADER = '# X 点赞存档\n\n';

  const state = {
    running: false,
    stopRequested: false,
    collected: [],
    sessionIds: new Set(),
    seen: new Set(),
    maxTweets: 0,
    intervalMs: 1200,
    maxIdleRounds: 12,
    fileHandle: null,
    fileName: '',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');

  function fmtDate(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const HTML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
  const unescapeHtml = (s) => String(s || '').replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (m) => HTML_ENTITIES[m]);

  /* ---------------------------------------------------------------- IndexedDB */

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_SEEN)) db.createObjectStore(STORE_SEEN, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  /**
   * @param {(store: IDBObjectStore) => IDBRequest | void} fn 返回的 request 的结果会作为 Promise 结果
   */
  function idbRun(store, mode, fn) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(store, mode);
          const req = fn(tx.objectStore(store));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        })
    );
  }

  const metaGet = (k) => idbRun(STORE_META, 'readonly', (s) => s.get(k)).then((v) => (v ? v.v : undefined));
  const metaSet = (k, v) => idbRun(STORE_META, 'readwrite', (s) => s.put({ k, v }));
  const seenKeys = () => idbRun(STORE_SEEN, 'readonly', (s) => s.getAllKeys()).then((ks) => ks || []);
  const seenPut = (ids) =>
    idbRun(STORE_SEEN, 'readwrite', (s) => {
      ids.forEach((id) => s.put({ id, at: Date.now() }));
    });

  /* ---------------------------------------------------------------- 解析 */

  /** 去掉 TweetWithVisibilityResults / tweet_results 之类的包装 */
  function unwrapTweet(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 4) return null;
    if (node.tweet) return unwrapTweet(node.tweet, depth + 1);
    if (node.tweet_results) return unwrapTweet(node.tweet_results.result, depth + 1);
    return node;
  }

  function pickUser(tweet) {
    const u = tweet?.core?.user_results?.result || tweet?.core?.user?.result;
    const legacy = u?.legacy || u?.core?.legacy;
    return {
      name: legacy?.name || u?.core?.name || '',
      handle: legacy?.screen_name || u?.core?.screen_name || '',
    };
  }

  function pickMedia(legacy) {
    const list = legacy?.extended_entities?.media || legacy?.entities?.media || [];
    const out = [];
    for (const m of list) {
      if (!m) continue;
      if (m.type === 'photo') {
        out.push({ type: 'photo', url: m.media_url_https, shortUrl: m.url });
      } else if (m.type === 'video' || m.type === 'animated_gif') {
        const variants = (m.video_info && m.video_info.variants) || [];
        const mp4 = variants
          .filter((v) => v && v.content_type === 'video/mp4' && v.url)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        out.push({
          type: m.type === 'animated_gif' ? 'gif' : 'video',
          url: (mp4 && mp4.url) || m.media_url_https || (m.expanded_url || ''),
          shortUrl: m.url,
        });
      }
    }
    return out.filter((m) => !!m.url);
  }

  function stripShortUrls(text, media) {
    let out = String(text || '');
    for (const m of media) {
      if (m.shortUrl && /^https?:\/\/t\.co\//.test(m.shortUrl)) {
        out = out.split(m.shortUrl).join('');
      }
    }
    return out.replace(/[ \t]+$/gm, '').trim();
  }

  function normalizeTweet(node) {
    const t = unwrapTweet(node);
    if (!t) return null;
    const legacy = t.legacy;
    if (!legacy || typeof legacy.full_text !== 'string') return null;

    const id = String(t.rest_id || legacy.id_str || legacy.conversation_id_str || '');
    if (!id) return null;

    const user = pickUser(t);
    // 长推文（note tweet）正文比 full_text 更完整
    const noteText = t.note_tweet?.note_tweet_results?.result?.text;
    let text = noteText && noteText.length > legacy.full_text.length ? noteText : legacy.full_text;
    const media = pickMedia(legacy);
    text = unescapeHtml(stripShortUrls(text, media));

    const created = legacy.created_at ? new Date(legacy.created_at) : null;

    let quoted = null;
    const qr = unwrapTweet(t.quoted_status_result?.result);
    if (qr && qr.legacy) {
      const qUser = pickUser(qr);
      const qNote = qr.note_tweet?.note_tweet_results?.result?.text;
      const qMedia = pickMedia(qr.legacy);
      let qText = qNote && qNote.length > (qr.legacy.full_text || '').length ? qNote : qr.legacy.full_text;
      qText = unescapeHtml(stripShortUrls(qText, qMedia));
      const qId = String(qr.rest_id || qr.legacy.id_str || '');
      quoted = {
        authorName: qUser.name,
        authorHandle: qUser.handle,
        text: qText || '（内容不可用）',
        url: qId && qUser.handle ? `https://x.com/${qUser.handle}/status/${qId}` : '',
        media: qMedia,
      };
    }

    return {
      id,
      text,
      authorName: user.name,
      authorHandle: user.handle,
      date: fmtDate(created),
      createdAt: created ? created.getTime() : 0,
      url: `https://x.com/${user.handle || 'i'}/status/${id}`,
      media,
      quoted,
    };
  }

  /** 在任意 JSON 里递归找出所有像推文的对象（结构变了也不容易全挂） */
  function extractTweets(node, out, depth = 0, budget = { n: 40000 }) {
    if (!node || typeof node !== 'object' || depth > 14 || budget.n <= 0) return out;
    budget.n--;
    if (Array.isArray(node)) {
      for (const item of node) extractTweets(item, out, depth + 1, budget);
      return out;
    }
    const t = normalizeTweet(node);
    if (t) {
      out.push(t);
      return out; // 命中就不再往里钻
    }
    for (const key of Object.keys(node)) extractTweets(node[key], out, depth + 1, budget);
    return out;
  }

  /* ---------------------------------------------------------------- 捕获网络响应 */

  function onApiJson(json) {
    if (!json || typeof json !== 'object') return;
    const found = extractTweets(json, []);
    for (const t of found) {
      if (state.sessionIds.has(t.id)) continue;
      state.sessionIds.add(t.id);
      state.collected.push(t);
    }
    if (found.length) renderCount();
  }

  function installHooks() {
    // fetch
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (...args) {
        return origFetch.apply(this, args).then((res) => {
          try {
            const input = args[0];
            const url = typeof input === 'string' ? input : input && input.url ? String(input.url) : '';
            if (url && API_RE.test(url) && res && res.ok !== false) {
              const clone = res.clone();
              clone.json().then(onApiJson).catch(() => {});
            }
          } catch (e) {
            /* 忽略：抓不到就当没这条 */
          }
          return res;
        });
      };
    }

    // XHR
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url, ...rest) {
        try {
          this.__xLikesUrl = String(url || '');
        } catch (e) {
          this.__xLikesUrl = '';
        }
        return origOpen.call(this, method, url, ...rest);
      };
      XHR.prototype.send = function (...args) {
        try {
          if (this.__xLikesUrl && API_RE.test(this.__xLikesUrl)) {
            this.addEventListener('load', () => {
              try {
                onApiJson(JSON.parse(this.responseText));
              } catch (e) {
                /* 非 JSON，忽略 */
              }
            });
          }
        } catch (e) {
          /* ignore */
        }
        return origSend.apply(this, args);
      };
    }
  }

  /* ---------------------------------------------------------------- Markdown */

  function mediaLines(media, indent = '') {
    const lines = [];
    let photoIdx = 0;
    for (const m of media) {
      if (m.type === 'photo') {
        photoIdx++;
        lines.push(`${indent}- 图片 ${photoIdx}: ![](${m.url})`);
      } else if (m.type === 'gif') {
        lines.push(`${indent}- 动图: [动图](${m.url})`);
      } else {
        lines.push(`${indent}- 视频: [视频](${m.url})`);
      }
    }
    return lines;
  }

  function tweetToMarkdown(t) {
    const lines = [];
    lines.push(`### ${t.date} · ${t.authorName} (@${t.authorHandle})`);
    lines.push('');
    lines.push(t.text || '');

    if (t.quoted) {
      lines.push('');
      lines.push(`> 引用 ${t.quoted.authorName} (@${t.quoted.authorHandle})：`);
      lines.push(...String(t.quoted.text).split('\n').map((l) => `> ${l}`));
      const qm = mediaLines(t.quoted.media || [], '> ');
      if (qm.length) {
        lines.push('>');
        lines.push(...qm);
      }
    }

    const ml = mediaLines(t.media || []);
    if (ml.length) {
      lines.push('');
      lines.push(...ml);
    }

    lines.push('');
    lines.push(`链接: ${t.url}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('');
    return lines.join('\n');
  }

  function batchToMarkdown(tweets) {
    const head = `## 导出批次 ${fmtDate(new Date())} · 新增 ${tweets.length} 条\n\n`;
    return head + tweets.map(tweetToMarkdown).join('');
  }

  /* ---------------------------------------------------------------- 写文件 */

  async function pickFile() {
    if (typeof window.showSaveFilePicker !== 'function') {
      throw new Error('当前浏览器不支持 File System Access API');
    }
    const handle = await window.showSaveFilePicker({
      suggestedName: 'x-likes.md',
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }],
    });
    await metaSet('fileHandle', handle);
    await metaSet('fileName', handle.name);
    state.fileHandle = handle;
    state.fileName = handle.name;
    renderFile();
    return handle;
  }

  async function ensureWritePermission(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  async function appendToFile(text) {
    const handle = state.fileHandle || (await metaGet('fileHandle'));
    if (!handle) throw new Error('还没有选择文件');
    state.fileHandle = handle;
    if (!(await ensureWritePermission(handle))) throw new Error('文件写入授权被拒绝');

    const file = await handle.getFile();
    const writable = await handle.createWritable({ keepExistingData: true });
    try {
      if (file.size === 0) {
        await writable.write(HEADER);
      } else {
        await writable.seek(file.size);
        // 上一次写入若未以换行结尾，补一个
        const tail = await file.slice(Math.max(0, file.size - 2)).text();
        if (tail && !/\n\s*$/.test(tail)) await writable.write('\n');
      }
      await writable.write(text);
    } finally {
      await writable.close();
    }
  }

  function downloadFallback(text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `x-likes-${fmtDate(new Date()).replace(/[: ]/g, '-')}.md`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  /** 过滤掉已写过的，剩下按时间倒序 */
  function pendingTweets() {
    const map = new Map();
    for (const t of state.collected) {
      if (state.seen.has(t.id)) continue;
      if (!map.has(t.id)) map.set(t.id, t);
    }
    return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async function flush({ auto = false } = {}) {
    const pending = pendingTweets();
    if (!pending.length) {
      setStatus(auto ? '导出结束，没有新增内容（都已写入过）' : '没有新增内容可写入');
      return 0;
    }
    const md = batchToMarkdown(pending);
    try {
      await appendToFile(md);
    } catch (e) {
      if (typeof window.showSaveFilePicker !== 'function') {
        downloadFallback(HEADER + md);
        setStatus('已改用下载方式保存（浏览器不支持直接写入本地文件）');
      } else {
        throw e;
      }
    }
    await seenPut(pending.map((t) => t.id));
    pending.forEach((t) => state.seen.add(t.id));
    setStatus(`已写入 ${pending.length} 条到 ${state.fileName || '本地文件'}`);
    renderCount();
    return pending.length;
  }

  /* ---------------------------------------------------------------- 导出流程 */

  async function waitWhileHidden() {
    while (document.hidden && state.running) {
      setStatus('已暂停：标签页不可见，切回本标签页会自动继续');
      await sleep(1000);
    }
  }

  async function runExport() {
    if (state.running) return;
    state.running = true;
    state.stopRequested = false;
    toggleButtons(true);
    setStatus('开始滚动加载点赞列表…');

    let idle = 0;
    let rounds = 0;
    try {
      while (state.running) {
        await waitWhileHidden();
        if (!state.running) break;

        const before = state.collected.length;
        window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);
        await sleep(state.intervalMs + Math.random() * 400);
        rounds++;

        const gained = state.collected.length - before;
        if (gained > 0) {
          idle = 0;
          setStatus(`加载中：已收集 ${state.collected.length} 条（第 ${rounds} 轮，新增 ${gained}）`);
        } else {
          idle++;
          setStatus(`加载中：已收集 ${state.collected.length} 条（连续 ${idle} 轮无新增）`);
        }

        if (idle >= state.maxIdleRounds) {
          setStatus(`连续 ${idle} 轮没有新内容，判断已到列表末尾`);
          break;
        }
        if (state.maxTweets > 0 && state.collected.length >= state.maxTweets) {
          setStatus(`已达到设定上限 ${state.maxTweets} 条`);
          break;
        }
        if (state.stopRequested) {
          setStatus('已手动停止');
          break;
        }
      }
    } finally {
      state.running = false;
      toggleButtons(false);
      renderCount();
      try {
        if (state.fileHandle || (await metaGet('fileHandle'))) {
          await flush({ auto: true });
        } else {
          setStatus(`收集完成，共 ${state.collected.length} 条。请选择文件后点「写入文件」`);
        }
      } catch (e) {
        setStatus(`写入失败：${e && e.message ? e.message : e}（可点「写入文件」重试）`);
      }
    }
  }

  /* ---------------------------------------------------------------- 面板 UI */

  let els = {};

  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'x-likes-exporter-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;font-family:system-ui,sans-serif;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
<style>
  .panel{width:320px;background:#0f1419;color:#e7e9ea;border:1px solid #2f3336;border-radius:12px;
         box-shadow:0 8px 28px rgba(0,0,0,.45);font-size:13px;overflow:hidden}
  .hd{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#16202a;font-weight:600}
  .hd button{background:none;border:none;color:#8899a6;cursor:pointer;font-size:16px;line-height:1}
  .bd{padding:10px 12px 12px}
  .row{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
  button.act{background:#1d9bf0;color:#fff;border:none;border-radius:999px;padding:6px 12px;cursor:pointer;font-size:12px}
  button.act:disabled{background:#3a4149;color:#8b98a5;cursor:default}
  button.ghost{background:#22282e;color:#e7e9ea;border:1px solid #38444d;border-radius:999px;padding:6px 12px;cursor:pointer;font-size:12px}
  input[type=number]{width:70px;background:#22282e;color:#e7e9ea;border:1px solid #38444d;border-radius:6px;padding:4px 6px}
  .file{color:#8899a6;font-size:12px;word-break:break-all}
  .status{margin-top:6px;color:#e7e9ea;font-size:12px;line-height:1.5;min-height:18px}
  .count{margin-top:4px;color:#8899a6;font-size:12px}
  .hint{color:#6b7782;font-size:11px}
  .collapse .bd{display:none}
</style>
<div class="panel">
  <div class="hd"><span>点赞导出 Markdown</span><button id="toggle" title="折叠/展开">–</button></div>
  <div class="bd">
    <div class="row">
      <button class="act" id="pick">选择文件</button>
      <span class="file" id="file">未选择</span>
    </div>
    <div class="row">
      <label>最多条数 <input id="max" type="number" min="0" value="0"></label>
      <span class="hint">0 = 不限</span>
    </div>
    <div class="row">
      <button class="act" id="start">开始导出</button>
      <button class="ghost" id="stop" disabled>停止</button>
      <button class="ghost" id="write">写入文件</button>
    </div>
    <div class="status" id="status">就绪</div>
    <div class="count" id="count">已收集 0 条</div>
  </div>
</div>`;
    document.body.appendChild(host);

    const q = (id) => root.getElementById(id);
    els = {
      root,
      panel: root.querySelector('.panel'),
      pick: q('pick'),
      file: q('file'),
      max: q('max'),
      start: q('start'),
      stop: q('stop'),
      write: q('write'),
      status: q('status'),
      count: q('count'),
    };

    q('toggle').addEventListener('click', () => {
      els.panel.classList.toggle('collapse');
      q('toggle').textContent = els.panel.classList.contains('collapse') ? '+' : '–';
    });
    els.pick.addEventListener('click', async () => {
      try {
        await pickFile();
        setStatus(`已选择 ${state.fileName}，之后每次追加写入该文件`);
      } catch (e) {
        setStatus(`选择文件失败：${e && e.message ? e.message : e}`);
      }
    });
    els.start.addEventListener('click', () => {
      const v = parseInt(els.max.value, 10);
      state.maxTweets = Number.isFinite(v) && v > 0 ? v : 0;
      runExport();
    });
    els.stop.addEventListener('click', () => {
      state.stopRequested = true;
      state.running = false;
      setStatus('正在停止…');
    });
    els.write.addEventListener('click', async () => {
      setStatus('写入中…');
      try {
        const n = await flush();
        if (n) setStatus(`已写入 ${n} 条到 ${state.fileName || '本地文件'}`);
      } catch (e) {
        setStatus(`写入失败：${e && e.message ? e.message : e}`);
      }
    });
  }

  function setStatus(text) {
    if (els.status) els.status.textContent = text;
    console.log('[x-likes]', text);
  }

  function renderCount() {
    if (!els.count) return;
    const pending = pendingTweets().length;
    els.count.textContent = `已收集 ${state.collected.length} 条，其中待写入 ${pending} 条`;
  }

  function renderFile() {
    if (els.file && state.fileName) els.file.textContent = state.fileName;
  }

  function toggleButtons(running) {
    if (!els.start) return;
    els.start.disabled = running;
    els.stop.disabled = !running;
    els.write.disabled = running;
    els.pick.disabled = running;
  }

  /* ---------------------------------------------------------------- 启动 */

  async function init() {
    installHooks();
    buildPanel();

    if (typeof window.showSaveFilePicker !== 'function') {
      setStatus('提示：当前环境不支持直接写本地文件，将改用下载方式保存');
    }

    try {
      const keys = await seenKeys();
      keys.forEach((k) => state.seen.add(String(k)));
      const handle = await metaGet('fileHandle');
      if (handle) {
        state.fileHandle = handle;
        state.fileName = (await metaGet('fileName')) || handle.name || '';
        renderFile();
        setStatus(`已记住上次的文件 ${state.fileName}，可直接开始导出`);
      }
      renderCount();
    } catch (e) {
      setStatus(`初始化本地存储失败：${e && e.message ? e.message : e}`);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

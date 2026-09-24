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

  const i18n = window.XLikesI18n || { t: (k) => k, setLocale: () => {}, getLocale: () => 'en', LANGS: ['en'], NATIVE: {} };
  const tr = i18n.t;

  const DB_NAME = 'x-likes-exporter';
  const DB_VERSION = 1;
  const STORE_SEEN = 'seen';   // 已写入文件的推文 id
  const STORE_META = 'meta';   // 文件句柄等
  const API_RE = /\/i\/api\/(graphql|1\.1|2)\//;

  const state = {
    running: false,
    stopRequested: false,
    mode: 'all', // all | count | range
    collected: [],
    sessionIds: new Set(),
    seen: new Set(),
    maxTweets: 0,
    startDate: null, // ms，仅 range 模式
    endDate: null, // ms，仅 range 模式
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

  function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
        text: qText || tr('mdUnavailable'),
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
        lines.push(indent + tr('mdPhoto', { i: photoIdx, u: m.url }));
      } else if (m.type === 'gif') {
        lines.push(indent + tr('mdGif', { u: m.url }));
      } else {
        lines.push(indent + tr('mdVideo', { u: m.url }));
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
      lines.push(tr('mdQuote', { name: t.quoted.authorName, handle: t.quoted.authorHandle }));
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
    lines.push(tr('mdLink', { u: t.url }));
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('');
    return lines.join('\n');
  }

  function batchToMarkdown(tweets) {
    return tr('mdBatch', { d: fmtDate(new Date()), n: tweets.length }) + tweets.map(tweetToMarkdown).join('');
  }

  /* ---------------------------------------------------------------- 写文件 */

  async function pickFile() {
    if (typeof window.showSaveFilePicker !== 'function') {
      throw new Error(tr('errNoFsa'));
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
    if (!handle) throw new Error(tr('errNoFile'));
    state.fileHandle = handle;
    if (!(await ensureWritePermission(handle))) throw new Error(tr('errNoPermission'));

    const file = await handle.getFile();
    const writable = await handle.createWritable({ keepExistingData: true });
    try {
      if (file.size === 0) {
        await writable.write(tr('mdTitle'));
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

  /** 待写入列表：去重 + 按模式过滤，按时间倒序 */
  function pendingTweets() {
    const map = new Map();
    for (const t of state.collected) {
      if (state.seen.has(t.id)) continue;
      if (state.mode === 'range') {
        // 按推文发布时间过滤（点赞列表本身没有点赞时间）
        if (state.startDate != null && (t.createdAt <= 0 || t.createdAt < state.startDate)) continue;
        if (state.endDate != null && t.createdAt > state.endDate) continue;
      }
      if (!map.has(t.id)) map.set(t.id, t);
    }
    return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async function flush({ auto = false } = {}) {
    const pending = pendingTweets();
    if (!pending.length) {
      setStatus(auto ? 'statusNoNew' : 'statusNoNewManual');
      return 0;
    }
    const md = batchToMarkdown(pending);
    try {
      await appendToFile(md);
    } catch (e) {
      if (typeof window.showSaveFilePicker !== 'function') {
        downloadFallback(tr('mdTitle') + md);
        setStatus('statusDownloaded');
      } else {
        throw e;
      }
    }
    await seenPut(pending.map((t) => t.id));
    pending.forEach((t) => state.seen.add(t.id));
    setStatus('statusWrote', { n: pending.length, f: state.fileName || '' });
    renderCount();
    return pending.length;
  }

  /* ---------------------------------------------------------------- 导出流程 */

  async function waitWhileHidden() {
    while (document.hidden && state.running) {
      setStatus('statusPaused');
      await sleep(1000);
    }
  }

  async function runExport() {
    if (state.running) return;
    state.running = true;
    state.stopRequested = false;
    toggleButtons(true);
    setStatus('statusStart');

    let idle = 0;
    let oldRounds = 0;
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
          setStatus('statusLoading', { n: state.collected.length, r: rounds, g: gained });
        } else {
          idle++;
          setStatus('statusIdle', { n: state.collected.length, i: idle });
        }

        // 日期范围模式：连续多轮新增的都是早于开始日期的推文，说明已经滚出范围
        if (state.mode === 'range' && state.startDate != null && gained > 0) {
          const newOnes = state.collected.slice(before);
          const allOld = newOnes.every((t) => t.createdAt > 0 && t.createdAt < state.startDate);
          oldRounds = allOld ? oldRounds + 1 : 0;
          if (oldRounds >= 5) {
            setStatus('statusOldest', { n: state.collected.length });
            break;
          }
        }

        if (idle >= state.maxIdleRounds) {
          setStatus('statusEnd', { i: idle });
          break;
        }
        if (state.mode === 'count' && state.maxTweets > 0 && state.collected.length >= state.maxTweets) {
          setStatus('statusMax', { n: state.maxTweets });
          break;
        }
        if (state.stopRequested) {
          setStatus('statusStopped');
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
          setStatus('statusNeedFile', { n: state.collected.length });
        }
      } catch (e) {
        setStatus('statusWriteFail', { e: errMsg(e) });
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
  .hidden{display:none}
  .radio{display:inline-flex;align-items:center;gap:4px;cursor:pointer;color:#e7e9ea}
  .radio input{accent-color:#1d9bf0;margin:0}
  input[type=date]{background:#22282e;color:#e7e9ea;border:1px solid #38444d;border-radius:6px;padding:4px 6px;color-scheme:dark}
  select{background:#16202a;color:#e7e9ea;border:1px solid #38444d;border-radius:6px;padding:3px 4px;font-size:11px;max-width:96px}
</style>
<div class="panel">
  <div class="hd">
    <span data-i18n="panelTitle"></span>
    <select id="lang" data-i18n-title="lang"></select>
    <button id="toggle" title="–">–</button>
  </div>
  <div class="bd">
    <div class="row">
      <button class="act" id="pick" data-i18n="pick"></button>
      <span class="file" id="file" data-i18n="notSelected"></span>
    </div>
    <div class="row">
      <label class="radio"><input type="radio" name="mode" value="all" checked><span data-i18n="modeAll"></span></label>
      <label class="radio"><input type="radio" name="mode" value="count"><span data-i18n="modeCount"></span></label>
      <label class="radio"><input type="radio" name="mode" value="range"><span data-i18n="modeRange"></span></label>
    </div>
    <div class="row hidden" id="row-count">
      <span data-i18n="maxCount"></span> <input id="max" type="number" min="1" value="1000">
    </div>
    <div class="row hidden" id="row-range">
      <span data-i18n="dateStart"></span> <input id="date-start" type="date">
      <span data-i18n="dateEnd"></span> <input id="date-end" type="date">
      <span class="hint" data-i18n="dateEndHint"></span>
    </div>
    <div class="row">
      <button class="act" id="start" data-i18n="btnStart"></button>
      <button class="ghost" id="stop" disabled data-i18n="btnStop"></button>
      <button class="ghost" id="write" data-i18n="btnWrite"></button>
    </div>
    <div class="status" id="status" data-i18n="statusReady"></div>
    <div class="count" id="count"></div>
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
      rowCount: q('row-count'),
      rowRange: q('row-range'),
      dateStart: q('date-start'),
      dateEnd: q('date-end'),
      lang: q('lang'),
      startBtn: q('start'),
      stop: q('stop'),
      write: q('write'),
      status: q('status'),
      count: q('count'),
    };

    // 语言下拉
    i18n.LANGS.forEach((code) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = i18n.NATIVE[code] || code;
      els.lang.appendChild(opt);
    });
    els.lang.value = i18n.getLocale();
    els.lang.addEventListener('change', () => {
      setLocale(els.lang.value);
    });

    // 结束日期默认今天
    els.dateEnd.value = localToday();
    applyI18n();

    root.querySelectorAll('input[name=mode]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const mode = root.querySelector('input[name=mode]:checked').value;
        els.rowCount.classList.toggle('hidden', mode !== 'count');
        els.rowRange.classList.toggle('hidden', mode !== 'range');
      });
    });

    q('toggle').addEventListener('click', () => {
      els.panel.classList.toggle('collapse');
      q('toggle').textContent = els.panel.classList.contains('collapse') ? '+' : '–';
    });
    els.pick.addEventListener('click', async () => {
      try {
        await pickFile();
        setStatus('statusPickOk', { f: state.fileName });
      } catch (e) {
        setStatus('statusPickFail', { e: errMsg(e) });
      }
    });
    els.startBtn.addEventListener('click', () => {
      const mode = root.querySelector('input[name=mode]:checked').value;
      state.mode = mode;
      state.startDate = null;
      state.endDate = null;
      state.maxTweets = 0;

      if (mode === 'count') {
        const v = parseInt(els.max.value, 10);
        if (!Number.isFinite(v) || v <= 0) {
          setStatus('errInvalidCount');
          return;
        }
        state.maxTweets = v;
      } else if (mode === 'range') {
        if (!els.dateStart.value) {
          setStatus('errNeedStart');
          return;
        }
        state.startDate = new Date(`${els.dateStart.value}T00:00:00`).getTime();
        state.endDate = els.dateEnd.value
          ? new Date(`${els.dateEnd.value}T23:59:59.999`).getTime()
          : Date.now();
        if (state.startDate > state.endDate) {
          setStatus('errStartAfterEnd');
          return;
        }
      }
      runExport();
    });
    els.stop.addEventListener('click', () => {
      state.stopRequested = true;
      state.running = false;
      setStatus('statusStopping');
    });
    els.write.addEventListener('click', async () => {
      setStatus('statusWriting');
      try {
        const n = await flush();
        if (n) setStatus('statusWrote', { n, f: state.fileName || '' });
      } catch (e) {
        setStatus('statusWriteFailShort', { e: errMsg(e) });
      }
    });
  }

  const errMsg = (e) => (e && e.message ? e.message : String(e));

  /** 切换语言：写入 IndexedDB，并同步给 popup（经 bridge 存 chrome.storage.local） */
  async function setLocale(code) {
    i18n.setLocale(code);
    applyI18n();
    try {
      await metaSet('locale', i18n.getLocale());
    } catch (e) {
      /* ignore */
    }
    window.postMessage({ tag: '__xLikes', type: 'setLocale', value: i18n.getLocale() }, '*');
  }

  /** 把词条写进面板 DOM */
  function applyI18n() {
    if (!els.root) return;
    els.root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = tr(el.getAttribute('data-i18n'));
    });
    els.root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = tr(el.getAttribute('data-i18n-title'));
    });
    if (!state.fileName) els.file.textContent = tr('notSelected');
    renderCount();
    renderStatus();
  }

  /** 状态按 key + 参数存，切语言时可重渲染 */
  let lastStatus = { key: 'statusReady', params: null };

  function setStatus(key, params) {
    lastStatus = { key, params: params || null };
    renderStatus();
  }

  function renderStatus() {
    const text = tr(lastStatus.key, lastStatus.params);
    if (els.status) els.status.textContent = text;
    console.log('[x-likes]', text);
  }

  function renderCount() {
    if (!els.count) return;
    const pending = pendingTweets().length;
    els.count.textContent = tr('collecting', { n: state.collected.length, m: pending });
  }

  function renderFile() {
    if (els.file) els.file.textContent = state.fileName || tr('notSelected');
  }

  function toggleButtons(running) {
    if (!els.startBtn) return;
    els.startBtn.disabled = running;
    els.stop.disabled = !running;
    els.write.disabled = running;
    els.pick.disabled = running;
    els.max.disabled = running;
    els.dateStart.disabled = running;
    els.dateEnd.disabled = running;
    els.root.querySelectorAll('input[name=mode]').forEach((r) => (r.disabled = running));
  }

  /* ---------------------------------------------------------------- 启动 */

  /** 语言来源优先级：popup 共享值（bridge）> 本站点存过的 > 浏览器语言 */
  function initLocale() {
    i18n.setLocale(i18n.detect());
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.tag !== '__xLikes' || d.type !== 'locale' || !d.value) return;
      if (i18n.normalize(d.value) && d.value !== i18n.getLocale()) {
        i18n.setLocale(d.value);
        if (els.lang) els.lang.value = i18n.getLocale();
        applyI18n();
      }
    });
    metaGet('locale')
      .then((saved) => {
        if (saved && i18n.normalize(saved)) {
          i18n.setLocale(saved);
          if (els.lang) els.lang.value = i18n.getLocale();
          applyI18n();
        }
      })
      .catch(() => {});
  }

  async function init() {
    installHooks();
    buildPanel();
    initLocale();

    if (typeof window.showSaveFilePicker !== 'function') {
      setStatus('statusNoFsa');
    }

    try {
      const keys = await seenKeys();
      keys.forEach((k) => state.seen.add(String(k)));
      const handle = await metaGet('fileHandle');
      if (handle) {
        state.fileHandle = handle;
        state.fileName = (await metaGet('fileName')) || handle.name || '';
        renderFile();
        setStatus('statusRememberFile', { f: state.fileName });
      }
      renderCount();
    } catch (e) {
      setStatus('statusInitFail', { e: errMsg(e) });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

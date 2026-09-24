const $ = (id) => document.getElementById(id);
const i18n = window.XLikesI18n;
const t = (key, params) => i18n.t(key, params);

const RESERVED = new Set([
  'i', 'home', 'explore', 'notifications', 'messages', 'settings', 'search',
  'compose', 'bookmarks', 'faq', 'privacy', 'tos', 'logout', 'signup', 'login',
]);

/** 兼容三种输入：纯用户名、@name、个人页完整 URL（可带 /likes 与查询参数） */
function parseHandle(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const urlMatch = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
  if (urlMatch) {
    const seg = urlMatch[1];
    return RESERVED.has(seg.toLowerCase()) ? '' : seg;
  }
  const name = s.replace(/^@+/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(name) && !RESERVED.has(name.toLowerCase()) ? name : '';
}

function showTip(key) {
  const el = $('tip');
  el.textContent = t(key);
  el.style.display = 'block';
}

/** 从一个已打开的 x.com 标签页里读当前登录用户名 */
async function detectHandle() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    if (!tabs.length) return '';
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        const a = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
        const href = a && a.getAttribute('href');
        if (href && /^\/[A-Za-z0-9_]{1,15}$/.test(href)) return href.slice(1);
        return '';
      },
    });
    return (results && results[0] && results[0].result) || '';
  } catch (e) {
    return '';
  }
}

/** 找已经打开了导出面板的点赞页标签页 */
async function findOpenPanelTab() {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://x.com/*/likes*', 'https://twitter.com/*/likes*'],
    });
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => !!document.getElementById('x-likes-exporter-host'),
        });
        if (results && results[0] && results[0].result) return tab;
      } catch (e) {
        /* 该标签页可能无法注入，跳过 */
      }
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-ph'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
}

function setupLangSelect() {
  const selects = [$('lang'), $('lang2')].filter(Boolean);
  selects.forEach((sel) => {
    i18n.LANGS.forEach((code) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = i18n.NATIVE[code] || code;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      i18n.setLocale(sel.value);
      chrome.storage.local.set({ locale: i18n.getLocale() });
      selects.forEach((s) => (s.value = i18n.getLocale()));
      applyI18n();
    });
  });
  return selects;
}

$('open').addEventListener('click', async () => {
  let handle = parseHandle($('handle').value);
  if (!handle && !$('handle').value.trim()) {
    handle = await detectHandle();
  }
  if (!handle) {
    showTip($('handle').value.trim() ? 'popupTipBad' : 'popupTipEmpty');
    return;
  }
  await chrome.tabs.create({ url: `https://x.com/${handle}/likes`, active: true });
  window.close();
});

$('switch').addEventListener('click', async () => {
  const tab = await findOpenPanelTab();
  if (tab) {
    await focusTab(tab);
    window.close();
  }
});

(async () => {
  // 语言：优先用存的，其次浏览器语言
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get('locale', (d) => resolve(d && d.locale));
  });
  i18n.setLocale(stored || i18n.detect());
  const selects = setupLangSelect();
  selects.forEach((s) => (s.value = i18n.getLocale()));
  applyI18n();

  // 已有导出面板在打开时，不再显示输入窗口，只提示并允许切换过去
  const openTab = await findOpenPanelTab();
  if (openTab) {
    $('main').style.display = 'none';
    $('already').style.display = 'block';
  }
})();

const $ = (id) => document.getElementById(id);

function showTip(text) {
  let el = $('tip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tip';
    el.style.cssText = 'margin-top:10px;color:#f4212e;font-size:12px;line-height:1.5';
    document.body.appendChild(el);
  }
  el.textContent = text;
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

$('open').addEventListener('click', async () => {
  let handle = $('handle').value.trim().replace(/^@/, '');
  if (!handle) {
    handle = await detectHandle();
    if (!handle) {
      showTip('没能自动识别到你的用户名，请在上方手动输入（不需要 @）。');
      return;
    }
  }
  await chrome.tabs.create({ url: `https://x.com/${handle}/likes`, active: true });
  window.close();
});

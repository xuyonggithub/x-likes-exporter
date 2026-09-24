/**
 * 隔离世界的桥：让页面里的导出面板（MAIN world，没有扩展 API）
 * 和 popup 共用 chrome.storage.local 里的语言设置。
 */
(() => {
  'use strict';
  const KEY = 'locale';
  const TAG = '__xLikes';

  const push = () => {
    chrome.storage.local.get(KEY, (data) => {
      if (data && data[KEY]) {
        window.postMessage({ tag: TAG, type: 'locale', value: data[KEY] }, '*');
      }
    });
  };

  push();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) {
      window.postMessage({ tag: TAG, type: 'locale', value: changes[KEY].newValue }, '*');
    }
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.tag !== TAG || d.type !== 'setLocale' || !d.value) return;
    chrome.storage.local.set({ [KEY]: d.value });
  });
})();

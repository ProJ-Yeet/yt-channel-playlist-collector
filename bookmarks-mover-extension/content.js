// Bridges window.postMessage (page world, where the YCFP userscript runs)
// to chrome.runtime messaging (extension world, where background.js has
// chrome.bookmarks access). Content scripts can't touch chrome.bookmarks
// directly, hence this relay — same split as the Tampermonkey bridge script
// uses for GM_xmlhttpRequest.

(function () {
  'use strict';

  function onMessage(ev) {
    if (ev.source !== window) return;
    if (ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || !d.ycfpBmx || d.ycfpBmx === 'result' || !d.reqId) return;

    chrome.runtime.sendMessage(d, (res) => {
      const payload = res || {
        ok: false,
        error: chrome.runtime.lastError
          ? chrome.runtime.lastError.message
          : 'No response from the YCFP Bookmarks Mover background script.',
      };
      window.postMessage(Object.assign({ ycfpBmx: 'result', reqId: d.reqId }, payload), location.origin);
    });
  }

  window.addEventListener('message', onMessage);
  console.info('[YCFP mover] content bridge active — waiting for requests.');
})();

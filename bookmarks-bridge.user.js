// ==UserScript==
// @name         YCFP Bookmarks Bridge
// @namespace    ycfp
// @version      1.1.1
// @description  Companion for the YouTube Channel Playlist Collector: reads the browser's local Bookmarks file (file:// access) so the main script can watch a bookmarks folder of channels. Requires "Allow access to file URLs" to be enabled for Tampermonkey.
// @match        https://www.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @noframes
// @run-at       document-start
// ==/UserScript==

/*
 * Why a second script: the main collector runs with "@grant none" (page
 * context — it needs the page's ytcfg and must stay out of the sandbox),
 * but reading a local file needs GM_xmlhttpRequest, which only exists in
 * sandboxed scripts. So this tiny sandboxed script answers read requests
 * from the main script over window.postMessage.
 *
 * Safety: only files literally named "Bookmarks" (Chromium's bookmarks
 * store) are readable, and only folder names + YouTube links are returned —
 * never the raw file, so other bookmarks never leave this script.
 *
 * v1.1.0: in Tampermonkey's sandbox `window` is a wrapper object, so the
 * old `ev.source !== window` guard silently dropped every message (the
 * source is the REAL page window). Messages are now accepted from the page
 * window (unsafeWindow) too, the listener is attached to both windows
 * (whichever fires first wins, deduped by request id), and the bridge
 * announces itself in the console for easy debugging.
 */

(function () {
  'use strict';

  const VERSION = '1.1.0';
  // The real page window when sandboxed, this world's window otherwise.
  const pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  // Chromium bookmark node → { name, folders: [...], links: [{name, url}] },
  // keeping only YouTube links.
  function simplify(node) {
    const out = { name: node.name || '', folders: [], links: [] };
    for (const c of node.children || []) {
      if (c.type === 'folder') out.folders.push(simplify(c));
      else if (c.type === 'url' && /https?:\/\/([^/]*\.)?(youtube\.com|youtu\.be)\//i.test(c.url || '')) {
        out.links.push({ name: c.name || '', url: c.url });
      }
    }
    return out;
  }

  const reply = (reqId, payload) =>
    pageWin.postMessage(Object.assign({ ycfpBm: 'result', reqId }, payload), location.origin);

  const handled = new Set(); // reqIds already answered (listener sits on 2 windows)

  function onMessage(ev) {
    // Accept only same-window, same-origin messages. ev.source may be the
    // real page window while our `window` is the sandbox wrapper — compare
    // against both.
    if (ev.source !== window && ev.source !== pageWin) return;
    if (ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || !d.reqId || handled.has(d.reqId)) return;

    if (d.ycfpBm === 'ping') {
      handled.add(d.reqId);
      reply(d.reqId, { ok: true, pong: true, version: VERSION });
      return;
    }
    if (d.ycfpBm !== 'read') return;
    handled.add(d.reqId);

    const file = String(d.file || '').trim();
    if (!/(^|[\\/])Bookmarks$/.test(file)) {
      reply(d.reqId, { ok: false, error: 'The bridge only reads files named "Bookmarks" (a Chromium bookmarks store).' });
      return;
    }
    const url = 'file:///' + file.replace(/\\/g, '/').replace(/^\/+/, '');

    try {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload(r) {
          try {
            if (!r.responseText) throw new Error('empty response — check the file path');
            const json = JSON.parse(r.responseText);
            const roots = [];
            for (const k of ['bookmark_bar', 'other', 'synced']) {
              if (json.roots && json.roots[k]) roots.push(simplify(json.roots[k]));
            }
            reply(d.reqId, { ok: true, roots });
          } catch (e) {
            reply(d.reqId, { ok: false, error: `Could not parse the bookmarks file: ${e.message || e}` });
          }
        },
        onerror(r) {
          const details = (r && (r.error || r.statusText)) || 'unknown';
          reply(d.reqId, {
            ok: false,
            error: /forbidden/i.test(details)
              // Tampermonkey's OWN local-file gate (separate from the browser
              // extension toggle): Dashboard → Settings → Config mode:
              // Advanced → Security → "Allow scripts to access local files".
              ? 'Tampermonkey itself is blocking local file access. Open the Tampermonkey '
                + 'Dashboard → Settings tab → set "Config mode" (top) to Advanced → Security '
                + 'section → set "Allow scripts to access local files" to "All local files", '
                + 'save, then reload this tab. (This is separate from the browser\'s '
                + '"Allow access to file URLs" toggle.)'
              : 'Could not read the file. Check "Allow access to file URLs" for Tampermonkey '
                + '(brave://extensions → Tampermonkey → Details) and the file path, then reload '
                + `this tab. Details: ${details}`,
          });
        },
      });
    } catch (e) {
      reply(d.reqId, { ok: false, error: `GM_xmlhttpRequest failed: ${e.message || e}` });
    }
  }

  window.addEventListener('message', onMessage);
  if (pageWin !== window) {
    try { pageWin.addEventListener('message', onMessage); } catch (e) { /* wrapper handles it */ }
  }
  console.info(`[YCFP bridge] v${VERSION} active — waiting for bookmark read requests.`);
})();

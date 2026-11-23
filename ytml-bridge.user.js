// ==UserScript==
// @name         YCFP Library Bridge
// @namespace    ycfp
// @version      1.0.0
// @description  Companion for the YouTube Channel Playlist Collector: reads and writes the Music Library database (Firestore) for it. Picks up your sign-in from the Music Library website, so ratings you set on YouTube show up there in real time.
// @match        https://www.youtube.com/*
// @match        https://proj-yeet.github.io/yt-music-library/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      firestore.googleapis.com
// @connect      securetoken.googleapis.com
// @noframes
// @run-at       document-idle
// ==/UserScript==

/*
 * Why a separate script: the collector runs with "@grant none" in the page
 * (it needs YouTube's own ytcfg), so it cannot keep a login that works on
 * another site or make cross-site requests. This sandboxed script can:
 *
 *  - On the Music Library website it copies the Firebase session (stored
 *    in localStorage by the site) into Tampermonkey storage.
 *  - On youtube.com it answers the collector's requests over
 *    window.postMessage (protocol tag "ytmlBridge") using the Firestore
 *    REST API, refreshing the sign-in token as needed.
 *
 * Only the library documents (library/meta and library/c00..c31) can be
 * touched; the security rules on the database decide who may write.
 */

(function () {
  'use strict';

  const VERSION = '1.0.0';
  const API_KEY = 'AIzaSyABlyOUW567MA3tGLzuHnQFYvDRXBUkVn0';
  const PROJECT = 'yt-music-library-794e4';
  const DOCS = `projects/${PROJECT}/databases/(default)/documents`;
  const BASE = `https://firestore.googleapis.com/v1/${DOCS}`;
  const CHUNKS = 32;
  const AUTH_KEY = 'ytml-auth-v1';
  const pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  // ---------------------------------------------------------------------
  // On the website: remember the signed-in session
  // ---------------------------------------------------------------------
  if (location.hostname.endsWith('github.io')) {
    const key = `firebase:authUser:${API_KEY}:[DEFAULT]`;
    const grab = () => {
      try {
        const raw = pageWin.localStorage.getItem(key);
        if (!raw) return;
        const u = JSON.parse(raw);
        const refreshToken = u && u.stsTokenManager && u.stsTokenManager.refreshToken;
        if (!refreshToken) return;
        const prev = GM_getValue(AUTH_KEY, null);
        if (prev && prev.refreshToken === refreshToken) return;
        GM_setValue(AUTH_KEY, { uid: u.uid, refreshToken, savedAt: Date.now() });
        console.info('[YCFP library bridge] sign-in saved for YouTube.');
      } catch (e) { /* not signed in yet */ }
    };
    grab();
    setInterval(grab, 5000);
    return;
  }

  // ---------------------------------------------------------------------
  // Firestore REST helpers
  // ---------------------------------------------------------------------
  function http(method, url, body, token) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      GM_xmlhttpRequest({
        method, url, headers,
        data: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        timeout: 120000,
        onload(r) {
          let json = null;
          try { json = r.responseText ? JSON.parse(r.responseText) : null; } catch (e) { /* not json */ }
          if (r.status >= 200 && r.status < 300) resolve(json);
          else {
            const msg = (json && json.error && (json.error.message || json.error.status)) || r.statusText || `HTTP ${r.status}`;
            reject(new Error(`${msg} (HTTP ${r.status})`));
          }
        },
        onerror(r) { reject(new Error((r && (r.error || r.statusText)) || 'network error')); },
        ontimeout() { reject(new Error('request timed out')); },
      });
    });
  }

  let idToken = null;
  let idTokenExp = 0;
  async function token() {
    const auth = GM_getValue(AUTH_KEY, null);
    if (!auth || !auth.refreshToken) {
      throw new Error('Not signed in: open the Music Library website in this browser and sign in once, then reload YouTube.');
    }
    if (idToken && Date.now() < idTokenExp - 60000) return idToken;
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.refreshToken)}`;
    const r = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: body,
        onload(res) {
          try {
            const j = JSON.parse(res.responseText);
            if (res.status === 200) resolve(j);
            else reject(new Error((j.error && j.error.message) || `HTTP ${res.status}`));
          } catch (e) { reject(e); }
        },
        onerror() { reject(new Error('token refresh failed (network)')); },
      });
    });
    idToken = r.id_token;
    idTokenExp = Date.now() + Number(r.expires_in || 3600) * 1000;
    if (r.refresh_token && r.refresh_token !== auth.refreshToken) {
      GM_setValue(AUTH_KEY, { ...auth, refreshToken: r.refresh_token, savedAt: Date.now() });
    }
    return idToken;
  }

  function toValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
    const fields = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) fields[k] = toValue(x);
    return { mapValue: { fields } };
  }
  function fromValue(v) {
    if (!v) return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('nullValue' in v) return null;
    if ('timestampValue' in v) return v.timestampValue;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
    if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
    return null;
  }
  function fromFields(f) {
    const o = {};
    for (const [k, v] of Object.entries(f || {})) o[k] = fromValue(v);
    return o;
  }
  const seg = (s) => (/^[A-Za-z_][A-Za-z_0-9]*$/.test(s) ? s : '`' + s.replace(/[\\`]/g, (c) => '\\' + c) + '`');
  const docName = (id) => `${DOCS}/library/${id}`;
  const chunkId = (i) => 'c' + String(i).padStart(2, '0');
  const VALID_DOC = /^(meta|c(0\d|1\d|2\d|3[01]))$/;

  async function commit(writes) {
    const t = await token();
    for (let i = 0; i < writes.length; i += 400) {
      await http('POST', `${BASE}:commit`, { writes: writes.slice(i, i + 400) }, t);
    }
  }

  // ---------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------
  const ops = {
    async ping() {
      const auth = GM_getValue(AUTH_KEY, null);
      return { version: VERSION, signedIn: !!(auth && auth.refreshToken), uid: auth ? auth.uid : null };
    },

    // Whole library: { meta, chunks: [map, …] } — public read, no sign-in.
    async getAll() {
      const names = ['meta', ...Array.from({ length: CHUNKS }, (_, i) => chunkId(i))].map(docName);
      const res = await http('POST', `${BASE}:batchGet?key=${API_KEY}`, { documents: names });
      const out = { meta: {}, chunks: Array(CHUNKS).fill(null).map(() => ({})) };
      for (const r of res || []) {
        if (!r.found) continue;
        const id = r.found.name.split('/').pop();
        const data = fromFields(r.found.fields);
        if (id === 'meta') out.meta = data;
        else out.chunks[Number(id.slice(1))] = data.v || {};
      }
      return out;
    },

    // items: [{ chunk: 'c07', id, rec }] — replaces just those videos' records.
    async putVideos({ items }) {
      const byChunk = new Map();
      for (const it of items || []) {
        if (!VALID_DOC.test(it.chunk) || it.chunk === 'meta' || !/^[\w-]{11}$/.test(it.id)) {
          throw new Error(`bad item ${it.chunk}/${it.id}`);
        }
        if (!byChunk.has(it.chunk)) byChunk.set(it.chunk, []);
        byChunk.get(it.chunk).push(it);
      }
      const writes = [];
      for (const [chunk, list] of byChunk) {
        for (let i = 0; i < list.length; i += 2000) {
          const part = list.slice(i, i + 2000);
          const v = {};
          for (const it of part) v[it.id] = it.rec;
          writes.push({
            update: { name: docName(chunk), fields: { v: toValue(v) } },
            updateMask: { fieldPaths: part.map((it) => `v.${seg(it.id)}`) },
          });
        }
      }
      await commit(writes);
      return { written: (items || []).length };
    },

    // Top-level meta fields only (ownerUid is never touched from here).
    async setMeta({ fields }) {
      const keys = Object.keys(fields || {}).filter((k) => k !== 'ownerUid');
      if (!keys.length) return { written: 0 };
      const f = {};
      for (const k of keys) f[k] = toValue(fields[k]);
      await commit([{ update: { name: docName('meta'), fields: f }, updateMask: { fieldPaths: keys.map(seg) } }]);
      return { written: keys.length };
    },

    // Import: replace every chunk document.
    async setChunks({ chunks }) {
      const writes = [];
      for (const [id, map] of Object.entries(chunks || {})) {
        if (!VALID_DOC.test(id) || id === 'meta') throw new Error(`bad chunk ${id}`);
        writes.push({ update: { name: docName(id), fields: { v: toValue(map || {}) } } });
      }
      await commit(writes);
      return { written: writes.length };
    },
  };

  // ---------------------------------------------------------------------
  // Message plumbing (same pattern as the bookmarks bridge)
  // ---------------------------------------------------------------------
  const handled = new Set();
  const reply = (reqId, payload) =>
    pageWin.postMessage(Object.assign({ ytmlBridge: 'result', reqId }, payload), location.origin);

  function onMessage(ev) {
    if (ev.source !== window && ev.source !== pageWin) return;
    if (ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || !d.reqId || !d.ytmlBridge || d.ytmlBridge === 'result' || handled.has(d.reqId)) return;
    handled.add(d.reqId);
    const op = ops[d.ytmlBridge];
    if (!op) { reply(d.reqId, { ok: false, error: `unknown op ${d.ytmlBridge}` }); return; }
    op(d.args || {}).then(
      (result) => reply(d.reqId, { ok: true, result }),
      (e) => reply(d.reqId, { ok: false, error: (e && e.message) || String(e) }),
    );
  }
  window.addEventListener('message', onMessage);
  if (pageWin !== window) {
    try { pageWin.addEventListener('message', onMessage); } catch (e) { /* wrapper handles it */ }
  }
  console.info(`[YCFP library bridge] v${VERSION} active.`);
})();

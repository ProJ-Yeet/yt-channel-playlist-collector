// ==UserScript==
// @name         YouTube Channel Playlist Collector
// @namespace    ycfp
// @version      3.59.0
// @description  Adds a "Collect All" button on YouTube channels: gathers every upload + the "- Topic" channel's releases, skips videos already in your configured playlists, dedupes by title+duration, and adds the rest into an EXISTING playlist of your choice (or a new one). Also lets you copy any playlist into another.
// @match        https://www.youtube.com/*
// @match        https://*.youtube.com/*
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

/*
 * Built in the style of "YouTube Play All" (button injected into the
 * Latest/Popular/Oldest chip bar, interval-based re-adding because YouTube
 * keeps erasing DOM mutations), but instead of just linking to the UU
 * playlist it collects videos via YouTube's own internal API and adds them
 * to a playlist in your account.
 *
 * No innerHTML is used anywhere — YouTube enforces Trusted Types CSP which
 * silently kills scripts that assign innerHTML.
 */

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Config (defaults — edit via the ⚙ settings dialog, stored in localStorage)
  // ------------------------------------------------------------------
  const DEFAULTS = {
    // Playlist IDs or URLs whose videos are SKIPPED when collecting. They
    // double as your "default" playlists: when any are set, dead videos are
    // only tracked in these, and the playlist pickers' "Select default"
    // button ticks exactly these.
    excludePlaylists: [],
    // Also collect the auto-generated "<Channel> - Topic" channel's uploads.
    includeTopicChannel: true,
    // Skip duplicates whose normalized title AND duration match exactly.
    dedupeByTitleDuration: true,
    // Playlist ID always used as the target. Empty = ask every time.
    defaultTargetPlaylist: '',
    // Quick-action buttons shown next to the playing video when watching a
    // playlist you can edit. Each: {label: 'S', target: 'PL…', name: 'Secondary'}.
    // "Move" = add to target playlist, then remove from the current one.
    // (The red ✕ remove button is always there and not configurable.)
    quickActions: [],
    // Music library: show the rating strip (category letters + stars) on
    // videos, file rated songs into their rating's playlist, and keep the
    // website in sync. The old letter buttons above are hidden while it is
    // on unless libraryOldButtons is true.
    libraryStrip: true,
    libraryOldButtons: false,
    libraryAutoSync: true,
    // Show the quick-action buttons on every row of the watch-page playlist
    // panel (toggled with the ▤ button on the strip).
    qaAllRows: false,
    // Skip Shorts when collecting channels / copying playlists.
    excludeShorts: false,
    // Skip live streams (the channel's UULV… streams playlist) when collecting.
    excludeLive: false,
    // Skip scheduled streams / premieres and anything with no playable
    // duration. On by default: an unreleased placeholder is never something
    // you want sitting in a playlist, and it is invisible to excludeLive.
    excludeUpcoming: true,
    // Skip videos you have removed from a playlist before (the deleted-video
    // ledger). Reviewable and undoable from ⚙ settings.
    skipDeleted: true,
    // Collapse the floating button stack to a single ☰ button.
    floatCollapsed: false,
    // Playlists ticked in the last dedupe scan (restored next time).
    dedupeSelection: [],
    // Use the deduper's fuzzy matching (cleaned titles, ±fuzzyDurationTolerance)
    // when collecting:
    // applies to exclusion playlists, main↔Topic dedupe, and target skipping.
    // Off by default — plain title+duration dedupe is the standard behaviour;
    // fuzzy is opt-in per run (collect options) or persistently (⚙ settings).
    fuzzyCollect: false,
    // Extra words stripped from titles before fuzzy comparison, on top of the
    // built-in decorations. Free text: separated by spaces and/or newlines.
    fuzzyDropWords: '',
    // How far two durations may differ (seconds) and still fuzzy-match.
    fuzzyDurationTolerance: 15,
    // Auto-select the "New to you" chip when the home feed opens.
    homeNewToYou: true,
    // Put a ✓ on feed/search/watch thumbnails of videos you already have.
    feedMarks: true,
    // Also mark videos whose song you have under a different upload (the
    // main↔Topic pair a collect would skip as a duplicate) — amber ✓.
    feedMarkVariants: true,
    batchSize: 50,
    batchDelayMs: 500,
  };
  const CFG_KEY = 'ycfp-config-v2';
  // Fuzzy collecting used to default to ON, so existing installs carry
  // fuzzyCollect:true in localStorage. Flip it off once on first load after
  // this change; it stays freely editable in ⚙ settings afterwards.
  const FUZZY_OFF_KEY = 'ycfp-fuzzy-default-off-v1';
  const ORIGIN = 'https://www.youtube.com';
  const PLAYLIST_CAP = 5000;

  // ------------------------------------------------------------------
  // Writes that survive a full localStorage
  //
  // Everything the script remembers shares one ~5 MB origin quota with
  // YouTube's own storage, and the caches that make it fast — a saved dedupe
  // scan, the playlist snapshots — run to megabytes
  // between them. Once the store is full, setItem throws in whichever caller
  // happens to be unlucky: merely remembering which playlists were ticked
  // used to abort a whole dedupe run before the scan had started.
  //
  // Every write goes through lsSet instead. On a failure it drops the most
  // expendable cache and retries, until the write fits or there is nothing
  // left to drop — and it never throws, so a full store costs at most the
  // one thing that write was trying to remember.
  // ------------------------------------------------------------------

  // The open dialog's log(), so an eviction is reported where you are
  // looking rather than only in the console.
  let activeLog = null;
  const lsNote = (msg) => {
    console.warn('[YCFP]', msg);
    try { if (activeLog) activeLog(`⚠ ${msg}`); } catch (e) { /* dialog is gone */ }
  };

  // Droppable caches, least valuable first. Each one is rebuilt from YouTube
  // the next time it is needed, so losing one costs a re-read, never a
  // decision you made. Deliberately absent: the config, the deleted-video
  // ledger, the unlinked pairs and the new-songs / batch-pull / bookmark
  // state — nothing on YouTube can reconstruct those.
  // Order: the saved dedupe scan goes first — it is by far the biggest single
  // thing here and re-running a scan is one button — and the two histories go
  // last, because they are the only entries that record something that
  // already happened rather than something re-readable from YouTube.
  const LS_CACHES = [
    ['ycfp-dedupe-session-v1', 'saved dedupe scan'],
    ['ycfp-playlist-snapshots-v1', 'playlist snapshots'],
    ['ycfp-moved-v1', 'moved-video notes'],
    ['ycfp-removal-log-v1', 'removal history'],
  ];

  // A cache that also keeps a parsed copy in memory registers a reset here:
  // dropping the stored copy has to drop the mirror too, or the next write
  // puts the whole thing straight back and the eviction bought nothing.
  const LS_EVICT_HOOKS = new Map();

  // UTF-16 code units, which is what the quota is actually counted in.
  const lsBytes = (key) => (localStorage.getItem(key) || '').length * 2;
  const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  // Everything this script is holding, keys included.
  const lsUsage = () => {
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ycfp-')) total += lsBytes(k) + k.length * 2;
    }
    return total;
  };

  // Remove one cache and tell its in-memory mirror, if it has one.
  function lsDropCache(key) {
    if (KV_KEYS.has(key) && kvDb) {
      const v = kvGet(key);
      kvRemove(key);
      return v ? v.length * 2 : 0;
    }
    const n = lsBytes(key);
    localStorage.removeItem(key);
    const hook = LS_EVICT_HOOKS.get(key);
    if (hook) { try { hook(); } catch (e) { /* mirror already gone */ } }
    return n;
  }

  // Drop caches one at a time until `write` succeeds. `keep` is never
  // dropped — it is the key being written. Returns the bytes freed, or -1 if
  // the write still does not fit with every cache gone.
  function lsMakeRoom(write, keep) {
    let freed = 0;
    const dropped = [];
    for (const [key, label] of LS_CACHES) {
      if (key === keep || !localStorage.getItem(key)) continue;
      dropped.push(label);
      freed += lsDropCache(key);
      if (write()) {
        lsNote(`Storage was full — dropped the ${dropped.join(' and the ')} to make room `
          + `(${fmtBytes(freed)} freed). That rebuilds itself as you use the script.`);
        return freed;
      }
    }
    return -1;
  }

  // localStorage's whole per-site quota, in characters (10 MB of UTF-16).
  const LS_MAX_CHARS = 5 * 1024 * 1024;
  const lsTooBigNoted = new Set();

  function lsSet(key, value) {
    const write = () => {
      try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
    };
    // Bigger than the entire quota: emptying every cache cannot make it fit,
    // so drop nothing, and say so once rather than on every save.
    if (value.length > LS_MAX_CHARS) {
      if (!lsTooBigNoted.has(key)) {
        lsTooBigNoted.add(key);
        lsNote(`${fmtBytes(value.length * 2)} is too big for the browser's 10 MB store and is not being saved`
          + `${kvFailReason ? ` — the disk store did not open in this tab: ${kvFailReason}` : ''}. Reload the tab to fix it.`);
      }
      return false;
    }
    if (write()) return true;
    // A failure that is not the quota (storage switched off for the site,
    // say) makes removeItem throw too — nothing to do but report it.
    try {
      if (lsMakeRoom(write, key) >= 0) return true;
    } catch (e) { /* storage is unusable, not merely full */ }
    if (!lsTooBigNoted.has(key)) {
      lsTooBigNoted.add(key);
      lsNote(`Storage is full and there is nothing left to drop — ${fmtBytes(value.length * 2)} could not be saved.`);
    }
    return false;
  }


  // ------------------------------------------------------------------
  // Big state lives in IndexedDB, not localStorage
  //
  // localStorage is capped at ~10 MB per site (5 M UTF-16 characters) and
  // YouTube uses the same bucket, so the ledger, the unlinks and a saved
  // 15,000-entry dedupe scan together ran it out. No browser setting raises
  // that cap. IndexedDB is disk-backed and gets a share of free disk space
  // (gigabytes), so everything but the tiny config lives there now.
  //
  // Callers still read synchronously: every key is loaded into memory once
  // at start-up (the script's buttons, timers and listeners only start after
  // that — see kvInit at the bottom), writes update memory at once and are
  // flushed to disk a moment later, and other open YouTube tabs are told
  // about each write so a stale tab can never write old data back.
  // ------------------------------------------------------------------
  const KV_KEYS = new Set([
    'ycfp-deleted-ledger-v1',      // videos you removed (collects skip them)
    'ycfp-dedupe-unlinked-v1',     // 🧹 "not duplicates" pairs
    'ycfp-dedupe-session-v1',      // saved 🧹 scan (by far the biggest)
    'ycfp-playlist-snapshots-v1',  // fallback snapshots (IndexedDB-less)
    'ycfp-moved-v1',               // moved-video notes
    'ycfp-newsongs-v1',            // 🆕 new songs state
    'ycfp-batchpull-v1',           // 📥 batch pull state
    'ycfp-bmdupe-v1',              // 🔖 bookmark dupes state
  ]);
  const KV_DB = 'ycfp-kv';
  const KV_STORE = 'kv';
  const kvMem = new Map();   // key → string (null = deleted)
  const kvPending = new Map();
  let kvFlushTimer = 0;
  let kvDb = null;           // null until opened; false = IndexedDB unusable
  let kvChan = null;
  try { kvChan = new BroadcastChannel('ycfp-kv'); } catch (e) { /* old browser: single-tab only */ }
  // Why the disk store is not in use in this tab, for the warning.
  let kvFailReason = '';
  // Values this big are not posted to the other tabs (cloning 11 MB into
  // every open YouTube tab on each save was most of a save's cost); they
  // get a notice instead and read the new value from the disk store.
  const KV_POST_MAX = 256 * 1024;
  if (kvChan) {
    kvChan.onmessage = (ev) => {
      const d = ev.data || {};
      if (!KV_KEYS.has(d.key)) return;
      if (!d.reread) { kvMem.set(d.key, d.value === undefined ? null : d.value); return; }
      if (!kvDb) return;
      try {
        const req = kvDb.transaction(KV_STORE, 'readonly').objectStore(KV_STORE).get(d.key);
        req.onsuccess = () => { if (!kvPending.has(d.key)) kvMem.set(d.key, req.result === undefined ? null : req.result); };
      } catch (e) { /* store closing: the next load reads it */ }
    };
  }

  function kvOpen() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (db) => { if (settled) { if (db) db.close(); return; } settled = true; resolve(db); };
      let req;
      const fail = (why) => { if (!settled) kvFailReason = why; done(false); };
      try { req = indexedDB.open(KV_DB, 1); } catch (e) { fail(`IndexedDB is switched off: ${e.name || e}`); return; }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(KV_STORE)) req.result.createObjectStore(KV_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Closed under us (site data cleared, a disk error): memory still
        // holds every key, so reopen and write it all back. Falling back to
        // localStorage instead is what produced "Storage is full" — the
        // saved scan alone is bigger than its whole quota.
        db.onversionchange = () => { db.close(); if (kvDb === db) kvReopen(); };
        db.onclose = () => { if (kvDb === db) kvReopen(); };
        done(db);
      };
      req.onerror = () => fail(`it would not open (${req.error && req.error.name})`);
      req.onblocked = () => setTimeout(() => fail('another tab kept it blocked'), 5000);
      // A cold start with many tabs restoring can take a while; nothing of
      // the script starts until this settles, so wait rather than give up.
      setTimeout(() => fail('it took over 60 s to open'), 60000);
    });
  }

  function kvReopen() {
    kvDb = null; // writes keep collecting in memory meanwhile
    kvOpen().then((db) => {
      if (!db) { kvDb = false; return; }
      kvDb = db;
      for (const [k, v] of kvMem) kvPending.set(k, v);
      kvSchedule(true);
      console.info('[YCFP] Disk store was closed by the browser — reopened and rewritten.');
    });
  }

  // Read a big key. Before kvInit has run (never, for anything the script
  // starts itself) or with IndexedDB unusable, localStorage still answers.
  function kvGet(key) {
    if (kvDb !== false && kvMem.has(key)) return kvMem.get(key);
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function kvFlush() {
    kvFlushTimer = 0;
    if (!kvPending.size || !kvDb) return;
    const batch = [...kvPending];
    kvPending.clear();
    try {
      const tx = kvDb.transaction(KV_STORE, 'readwrite');
      const st = tx.objectStore(KV_STORE);
      for (const [k, v] of batch) { if (v === null) st.delete(k); else st.put(v, k); }
      tx.onerror = () => {
        console.warn('[YCFP] Could not save to IndexedDB:', tx.error);
        lsNote(`Could not save ${batch.length} item(s) to the disk store (${tx.error && tx.error.name}). `
          + 'Is the disk full?');
      };
    } catch (e) {
      console.warn('[YCFP] IndexedDB write failed:', e);
    }
  }
  const kvSchedule = (now) => {
    if (now) { clearTimeout(kvFlushTimer); kvFlush(); return; }
    if (!kvFlushTimer) kvFlushTimer = setTimeout(kvFlush, 250);
  };
  // Leaving or hiding the page flushes at once, so nothing waits on a timer.
  window.addEventListener('pagehide', () => kvSchedule(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) kvSchedule(true); });

  function kvSet(key, value) {
    // null = not open yet (never, for anything the script starts) or being
    // reopened: memory is the truth meanwhile and the flush waits for it.
    if (kvDb === false) return value === null ? (localStorage.removeItem(key), true) : lsSet(key, value);
    kvMem.set(key, value);
    kvPending.set(key, value);
    kvSchedule(false);
    if (kvChan) {
      try {
        if (value && value.length > KV_POST_MAX) {
          // The other tabs read it once it is on disk.
          kvSchedule(true);
          kvChan.postMessage({ key, reread: true });
        } else kvChan.postMessage({ key, value });
      } catch (e) { /* too big to clone: other tabs re-read on reload */ }
    }
    return true;
  }
  const kvRemove = (key) => kvSet(key, null);

  // Characters held in the disk store (×2 = bytes, as for localStorage).
  const kvUsage = () => {
    let n = 0;
    for (const v of kvMem.values()) if (v) n += v.length * 2;
    return n;
  };

  // Open the store, load every key into memory, and move anything still in
  // localStorage across (then delete it there — that is the space freed).
  let kvInitPromise = null;
  function kvInit() {
    if (kvInitPromise) return kvInitPromise;
    kvInitPromise = (async () => {
      const db = await kvOpen();
      if (!db) { kvDb = false; console.warn(`[YCFP] Disk store unusable — ${kvFailReason}. Big state stays in localStorage.`); return; }
      const stored = await new Promise((res) => {
        const out = new Map();
        // A read that never finishes must not keep the script from starting.
        setTimeout(() => { kvFailReason = 'reading it took over 60 s'; res(null); }, 60000);
        try {
          const tx = db.transaction(KV_STORE, 'readonly');
          const cur = tx.objectStore(KV_STORE).openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (c) { out.set(c.key, c.value); c.continue(); } else res(out);
          };
          cur.onerror = () => { kvFailReason = `reading it failed (${cur.error && cur.error.name})`; res(null); };
        } catch (e) { kvFailReason = `reading it failed (${e.name || e})`; res(null); }
      });
      if (!stored) {
        db.close();
        kvDb = false;
        console.warn(`[YCFP] Disk store unusable — ${kvFailReason}. Big state stays in localStorage.`);
        return;
      }
      const moved = [];
      for (const key of KV_KEYS) {
        let ls = null;
        try { ls = localStorage.getItem(key); } catch (e) { /* ignore */ }
        if (stored.has(key)) {
          kvMem.set(key, stored.get(key));
          // A leftover copy (another tab still on an older version wrote it
          // after the move) — the disk store is the newer truth.
          if (ls !== null) moved.push(key);
        } else if (ls !== null) {
          kvMem.set(key, ls);
          kvPending.set(key, ls);
          moved.push(key);
        }
      }
      kvDb = db;
      if (kvPending.size) {
        // Delete the localStorage copies only once the disk write committed.
        await new Promise((res) => {
          try {
            const tx = db.transaction(KV_STORE, 'readwrite');
            const st = tx.objectStore(KV_STORE);
            for (const [k, v] of kvPending) st.put(v, k);
            kvPending.clear();
            tx.oncomplete = () => res(true);
            tx.onerror = () => { moved.length = 0; res(false); };
          } catch (e) { moved.length = 0; res(false); }
        });
      }
      let freed = 0;
      for (const key of moved) {
        try { freed += lsBytes(key); localStorage.removeItem(key); } catch (e) { /* ignore */ }
      }
      if (freed) console.info(`[YCFP] Moved ${moved.length} item(s) to IndexedDB — ${fmtBytes(freed)} of localStorage freed.`);
      // Ask not to be evicted when the disk runs low (granted or not, silently).
      try {
        if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
          await navigator.storage.persist();
        }
      } catch (e) { /* not supported */ }
    })();
    return kvInitPromise;
  }

  const loadCfg = () => {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (raw) {
        const cfg = Object.assign({}, DEFAULTS, JSON.parse(raw));
        if (!localStorage.getItem(FUZZY_OFF_KEY)) {
          lsSet(FUZZY_OFF_KEY, '1');
          if (cfg.fuzzyCollect) {
            cfg.fuzzyCollect = false;
            lsSet(CFG_KEY, JSON.stringify(cfg));
          }
        }
        return cfg;
      }
    } catch (e) { /* use defaults */ }
    return Object.assign({}, DEFAULTS);
  };
  const saveCfg = (cfg) => {
    lsSet(CFG_KEY, JSON.stringify(cfg));
    dropWordsCache = null; // re-parse the custom fuzzy stopwords on next use
    durTolCache = null;    // and the duration tolerance
  };

  const parsePlaylistId = (s) => {
    s = (s || '').trim();
    if (!s) return null;
    const m = s.match(/[?&]list=([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    if (s === 'WL' || s === 'LL') return s; // Watch Later / Liked
    // 13+ chars so a bare 11-char *video* id can't pass as a playlist id
    if (/^[A-Za-z0-9_-]{13,}$/.test(s)) return s;
    return null;
  };

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  // sleep(0) only lets the page breathe inside a long loop. Done with a
  // timer, a tab in the background gets one wake-up per second, and after
  // 5 minutes hidden a chain of them one per MINUTE — a fuzzy match yields
  // ~100 times, so it crawled unless its tab was in front. A MessageChannel
  // message is not throttled; real pauses (request pacing) still use timers.
  const sleep = (ms) => new Promise((r) => {
    if (ms > 0) { setTimeout(r, ms); return; }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); r(); };
    ch.port2.postMessage(0);
  });

  const getCookie = (name) => {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };

  function deepFind(obj, key) {
    if (!obj || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const k of Object.keys(obj)) {
      const found = deepFind(obj[k], key);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  function deepCollect(obj, key, out = []) {
    if (!obj || typeof obj !== 'object') return out;
    if (Object.prototype.hasOwnProperty.call(obj, key)) out.push(obj[key]);
    for (const k of Object.keys(obj)) deepCollect(obj[k], key, out);
    return out;
  }

  // ------------------------------------------------------------------
  // Item-section scoping
  //
  // A browse response carries much more than the list you asked for: header
  // sample thumbnails, "similar playlists" shelves, engagement panels — each
  // with their own items AND their own continuation tokens. Reading items
  // with a whole-response deepCollect therefore attributed foreign videos to
  // the playlist being read, and following the first unused token found
  // anywhere in the response kept the fetch loop running through those other
  // sections long after the real list had ended. That is where the
  // deduplicator's "songs from playlists that don't exist" came from.
  //
  // findItemSection locates the ONE array holding the response's own items
  // (…VideoListRenderer.contents, gridRenderer.items, or a continuation's
  // continuationItems) plus the continuation token living in that same
  // array. Everything else in the response is ignored.
  //   classify(element) → 2 = definitely an item of this kind of list
  //                       1 = plausibly one (newer lockup UI)
  //                       0 = not an item
  // An array scores tier + 4 when it hangs off a container that really holds
  // a list's items, and a score under 2 is not accepted at all — so a shelf
  // full of lockups is never mistaken for the list itself. If YouTube moves
  // the items into a container not named here the scan reports 0 videos and
  // dumps the response to the console, which is a loud failure rather than a
  // silent wrong answer.
  // ------------------------------------------------------------------
  const ITEM_CONTAINER_KEYS = new Set([
    'playlistVideoListRenderer', 'playlistVideoListViewModel',
    'gridRenderer', 'richGridRenderer', 'itemSectionRenderer',
  ]);
  const sectionMemo = new WeakMap();

  function findItemSection(data, classify, kind) {
    if (!data || typeof data !== 'object') return null;
    let memo = sectionMemo.get(data);
    if (memo && kind in memo) return memo[kind];
    let best = null;
    const walk = (node, key, parentKey) => {
      if (Array.isArray(node)) {
        let tier = 0, count = 0, token = null;
        for (const elem of node) {
          if (!elem || typeof elem !== 'object') continue;
          const t = classify(elem);
          if (t) {
            count++;
            if (t > tier) tier = t;
          } else if (elem.continuationItemRenderer || elem.continuationItemViewModel) {
            // Nov 2026: playlists switched to continuationItemViewModel —
            // only knowing the old renderer capped every read at 100 items.
            // Its outer `continuationCommand` wraps an innertubeCommand whose
            // own continuationCommand holds the token — take the one with one.
            const c = deepCollect(elem.continuationItemRenderer || elem.continuationItemViewModel,
              'continuationCommand').find((x) => x && x.token);
            if (c && c.token) token = c.token;
          }
        }
        const owned = key === 'continuationItems' || ITEM_CONTAINER_KEYS.has(parentKey);
        const score = (owned ? 4 : 0) + tier;
        if (count && score >= 2
          && (!best || score > best.score || (score === best.score && count > best.count))) {
          best = { items: node, score, count, token };
        }
      }
      for (const k of Object.keys(node)) {
        const child = node[k];
        if (child && typeof child === 'object') walk(child, k, key);
      }
    };
    walk(data, '', '');
    if (!memo) { memo = {}; sectionMemo.set(data, memo); }
    memo[kind] = best;
    return best;
  }

  const VIDEO_ITEM = (elem) => {
    if (elem.playlistVideoRenderer) return 2;
    const lv = elem.lockupViewModel;
    if (lv && lv.contentId && (!lv.contentType
      || lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO'
      || lv.contentType === 'LOCKUP_CONTENT_TYPE_SHORT')) return 1;
    const rich = elem.richItemRenderer && elem.richItemRenderer.content;
    if (rich && (rich.playlistVideoRenderer || rich.lockupViewModel || rich.shortsLockupViewModel)) return 1;
    if (elem.shortsLockupViewModel) return 1;
    return 0;
  };

  const PLAYLIST_ITEM = (elem) => {
    if (elem.gridPlaylistRenderer || elem.playlistRenderer) return 2;
    const lv = elem.lockupViewModel;
    if (lv && lv.contentId && lv.contentType
      && /PLAYLIST|ALBUM|PODCAST/.test(lv.contentType)) return 1;
    return 0;
  };

  const videoSection = (data) => findItemSection(data, VIDEO_ITEM, 'video');
  const playlistSection = (data) => findItemSection(data, PLAYLIST_ITEM, 'playlist');

  // Continuation token of the list itself — never one belonging to some other
  // section of the same response.
  function nextSectionToken(section, usedTokens) {
    const t = section && section.token;
    if (!t || usedTokens.has(t)) return null;
    usedTokens.add(t);
    return t;
  }

  const textOf = (t) => {
    if (!t) return '';
    if (t.simpleText) return t.simpleText;
    if (t.runs) return t.runs.map((r) => r.text).join('');
    return '';
  };

  const normTitle = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const dupeKey = (v) => normTitle(v.title) + '|' + v.seconds;

  // The two YouTube data models report durations slightly differently for
  // the same video (exact lengthSeconds vs the rounded "3:45" badge text),
  // so "same title + duration" tolerates ±2s.
  const EXACT_SECONDS_TOLERANCE = 2;
  function titleDurationHit(keySet, title, seconds) {
    if (!(seconds > 0) || !keySet.size) return false;
    const t = normTitle(title);
    for (let s = seconds - EXACT_SECONDS_TOLERANCE; s <= seconds + EXACT_SECONDS_TOLERANCE; s++) {
      if (keySet.has(t + '|' + s)) return true;
    }
    return false;
  }

  // "1:02:03" → 3723 seconds; anything non-duration-shaped → 0
  const parseDurationText = (t) => {
    t = (t || '').trim();
    if (!/^\d+(:\d{1,2})+$/.test(t)) return 0;
    return t.split(':').reduce((a, x) => a * 60 + parseInt(x, 10), 0);
  };

  // ------------------------------------------------------------------
  // Live / scheduled status of one item
  //
  // The old check read a single overlay style plus the literal badge texts
  // "LIVE"/"UPCOMING". That misses most SCHEDULED items: a premiere or a
  // planned stream carries no duration and labels itself "Premieres Aug 30",
  // "Scheduled for 8:00 PM" or "Waiting for …" — none of which is the word
  // UPCOMING — and it is not in the channel's UULV… streams playlist either
  // (that one only lists streams that have actually happened), so nothing
  // caught it and the placeholder landed in the playlist.
  //
  // Signals, most trustworthy first:
  //   1. structural  — upcomingEventData / isLiveNow / isLive, which YouTube
  //                    sets regardless of the UI language;
  //   2. badge style — …LIVE…/…UPCOMING…/…PREMIERE… enum values (also
  //                    language-neutral);
  //   3. badge text  — read ONLY inside status badges/overlays, never the
  //                    title, so a video *called* "Live at Wembley" is safe.
  // ------------------------------------------------------------------
  const LIVE_STATUS_KEYS = [
    'thumbnailOverlayTimeStatusRenderer', 'metadataBadgeRenderer',
    'thumbnailBadgeViewModel', 'thumbnailOverlayBadgeViewModel',
    'badgeViewModel', 'liveBadgeViewModel',
  ];
  const LIVE_TEXT_RE = /\b(live|upcoming|premier(?:e|es|ing|ed)?|scheduled|waiting|starts?\s+(?:in|at|on))\b/i;
  const UPCOMING_TEXT_RE = /\b(upcoming|premier(?:e|es|ing)?|scheduled|waiting|starts?\s+(?:in|at|on))\b/i;
  const LIVE_STYLE_RE = /LIVE|UPCOMING|PREMIERE/;

  function liveStatus(node) {
    const out = { live: false, upcoming: false };
    if (!node || typeof node !== 'object') return out;
    // 1. structural flags
    if (deepFind(node, 'upcomingEventData') !== undefined) out.upcoming = true;
    if (deepFind(node, 'isLiveNow') === true || deepFind(node, 'isLive') === true) out.live = true;
    // 2/3. status badges and overlays
    for (const key of LIVE_STATUS_KEYS) {
      for (const b of deepCollect(node, key)) {
        if (!b || typeof b !== 'object') continue;
        const style = String(b.style || b.badgeStyle || '');
        if (LIVE_STYLE_RE.test(style)) {
          if (/UPCOMING|PREMIERE/.test(style)) out.upcoming = true; else out.live = true;
        }
        const texts = [
          typeof b.text === 'string' ? b.text : textOf(b.text),
          typeof b.label === 'string' ? b.label : '',
          typeof b.accessibilityText === 'string' ? b.accessibilityText : '',
        ];
        for (const t of texts) {
          if (!t || parseDurationText(t) > 0) continue; // "3:45" is a duration
          if (!LIVE_TEXT_RE.test(t)) continue;
          if (UPCOMING_TEXT_RE.test(t)) out.upcoming = true; else out.live = true;
        }
      }
    }
    return out;
  }

  // Trusted-Types-safe element builder. Properties that must be set as JS
  // properties (value, checked, …) are handled; everything else becomes an
  // attribute. Children are appended (strings become text nodes).
  function el(tag, props, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k === 'value') e.value = v;
      else if (k === 'checked') e.checked = !!v;
      else if (k === 'selected') e.selected = !!v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c !== null && c !== undefined) e.append(c);
    return e;
  }

  // ------------------------------------------------------------------
  // InnerTube API (YouTube's own internal API, same calls the site makes)
  // ------------------------------------------------------------------
  const ytcfgGet = (k) => {
    const y = window.ytcfg;
    if (!y) return undefined;
    if (typeof y.get === 'function') return y.get(k);
    return y.data_ ? y.data_[k] : undefined;
  };

  async function sapisidHash() {
    const sapisid = getCookie('SAPISID') || getCookie('__Secure-3PAPISID');
    if (!sapisid) throw new Error('Not logged in — log in to YouTube first.');
    const ts = Math.floor(Date.now() / 1000);
    const digest = await crypto.subtle.digest(
      'SHA-1', new TextEncoder().encode(`${ts} ${sapisid} ${ORIGIN}`));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${ts}_${hex}`;
  }

  const API_TIMEOUT_MS = 45000;
  async function api(path, body, attempt = 0) {
    const key = ytcfgGet('INNERTUBE_API_KEY');
    const context = ytcfgGet('INNERTUBE_CONTEXT');
    if (!key || !context) throw new Error('ytcfg not ready — wait for the page to finish loading and retry.');
    // A request YouTube never answers used to hang the whole run forever
    // (the log just stopped). Abort it after a while and retry instead.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
    let res, json;
    try {
      res = await fetch(`${ORIGIN}/youtubei/v1/${path}?key=${key}&prettyPrint=false`, {
        method: 'POST',
        credentials: 'include',
        signal: ctl.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': await sapisidHash(),
          'X-Origin': ORIGIN,
          'X-Goog-AuthUser': String(ytcfgGet('SESSION_INDEX') || '0'),
        },
        body: JSON.stringify(Object.assign({ context }, body)),
      });
      if (res.ok) json = await res.json();
    } catch (e) {
      if (e && e.name === 'AbortError') {
        if (attempt < 3) {
          console.warn(`[YCFP] ${path} → no answer in ${API_TIMEOUT_MS / 1000}s; retrying (${attempt + 1}/3)…`);
          await sleep(2000);
          return api(path, body, attempt + 1);
        }
        throw new Error(`${path} → YouTube did not answer (timed out ${attempt + 1}×) — check your connection and re-run.`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // Rate limit / transient error: back off and retry instead of aborting.
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        const wait = 15000 * (attempt + 1);
        console.warn(`[YCFP] ${path} → HTTP ${res.status}; backing off ${wait / 1000}s (retry ${attempt + 1}/3)…`);
        await sleep(wait);
        return api(path, body, attempt + 1);
      }
      // Dump YouTube's error body for diagnosis (e.g. which action a 400 hated).
      const errBody = await res.text().catch(() => '');
      console.warn(`[YCFP] ${path} → HTTP ${res.status}`, errBody.slice(0, 800), body);
      let reason = '';
      try { reason = JSON.parse(errBody).error?.message || ''; } catch (e) { /* not a JSON error */ }
      throw new Error(`${path} → HTTP ${res.status}${reason ? `: ${String(reason).slice(0, 500)}` : ''}${res.status === 429 ? ' (rate limited — wait a while and re-run)' : ''}`);
    }
    if (json.error) throw new Error(`${path} → ${json.error.message || json.error.status}`);
    return json;
  }

  // Resolve current channel page to its UC… id. Primary: InnerTube resolver.
  // Fallback: the canonical-link trick from YTPA.
  async function resolveChannelId() {
    try {
      const data = await api('navigation/resolve_url', { url: location.href });
      const ep = deepFind(data, 'browseEndpoint');
      if (ep && ep.browseId && ep.browseId.startsWith('UC')) return ep.browseId;
    } catch (e) { /* fall through */ }
    const html = await (await fetch(location.href, { credentials: 'include' })).text();
    const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/);
    if (m) return m[1];
    throw new Error('Could not determine the channel ID for this page.');
  }

  async function getChannelTitle(browseId) {
    const data = await api('browse', { browseId });
    const meta = deepFind(data, 'channelMetadataRenderer');
    return (meta && meta.title) || browseId;
  }

  // Pull videos out of a browse response. Handles both the classic data
  // model (playlistVideoRenderer) and the new lockup view model UI that
  // YouTube has been rolling out, where items look like:
  //   lockupViewModel { contentId, contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
  //     metadata.lockupMetadataViewModel.title.content,
  //     ...thumbnailBadgeViewModel { text: "3:45" } }
  // `keepDupes`: keep multiple entries of the same video (needed by the
  // deduplicator) — uniqueness is keyed on setVideoId (the per-entry
  // playlist handle) when the data provides one.
  //
  // When it doesn't, the copies are genuinely indistinguishable and the same
  // physical entry can still reach us twice (both data models describing one
  // item, or a page delivered again). Keying each occurrence uniquely
  // (v3.21.1) turned that into a fake duplicate PAIR: ticking one of the two
  // removed the only real entry, which read as "it deleted the original".
  // Keying on the bare video id — the pre-v3.21 behaviour — instead hid real
  // same-playlist copies from the deduplicator entirely. So: collapse per
  // video id AND carry a `copies` count, which removal uses to put the right
  // number back (see executeRemovals).
  function extractVideos(data, seen, videos, keepDupes = false) {
    const section = videoSection(data);
    // No item list in this response — do NOT fall back to scraping the whole
    // thing, or shelves and header samples become "entries" of this playlist.
    if (!section) return;
    const root = section.items;
    const noHandle = new Map(); // video id → the collapsed handle-less entry
    const handled = new Set();  // video ids already recorded with a real handle
    if (keepDupes) {
      for (const v of videos) {
        if (v.setVideoId) handled.add(v.id);
        else if (!noHandle.has(v.id)) noHandle.set(v.id, v);
      }
    }
    // `chEp`: the byline's browseEndpoint, when there is one — the owning
    // channel's UC… id and its URL path ("/@handle" or "/channel/UC…").
    const push = (id, title, seconds, setVideoId, isShort, channel, isLive, isUpcoming, chEp) => {
      if (!id) return;
      let key;
      if (!keepDupes) {
        key = id;
      } else if (setVideoId) {
        key = 'S' + setVideoId;
      } else {
        const prev = noHandle.get(id);
        if (prev) { prev.copies++; return; }
        if (handled.has(id)) return; // same item, already recorded with a handle
        key = 'V' + id;
      }
      if (seen.has(key)) return;
      seen.add(key);
      const entry = {
        id, title, seconds,
        setVideoId: setVideoId || null,
        copies: 1,
        isShort: !!isShort,
        isLive: !!isLive,
        isUpcoming: !!isUpcoming,
        channel: channel || '',
      };
      if (chEp && /^UC[\w-]{22}$/.test(chEp.browseId || '')) {
        entry.channelId = chEp.browseId;
        if (typeof chEp.canonicalBaseUrl === 'string') entry.channelPath = chEp.canonicalBaseUrl;
      }
      videos.push(entry);
      if (keepDupes) {
        if (setVideoId) handled.add(id); else noHandle.set(id, entry);
      }
      return entry;
    };
    for (const v of deepCollect(root, 'playlistVideoRenderer')) {
      if (!v) continue;
      const st = liveStatus(v);
      const ent = push(v.videoId, textOf(v.title),
        parseInt(v.lengthSeconds || '0', 10) || 0, v.setVideoId, false,
        textOf(v.shortBylineText), st.live, st.upcoming, deepFind(v.shortBylineText, 'browseEndpoint'));
      // A playlist keeps a tombstone row for a video YouTube has taken down,
      // or whose owner made it private: the title becomes "[Deleted video]",
      // the duration and channel disappear, and isPlayable goes false. The
      // flag is what the archive uses to notice the death (see deadKind).
      if (ent && v.isPlayable === false) ent.dead = true;
    }
    for (const lv of deepCollect(root, 'lockupViewModel')) {
      if (!lv || !lv.contentId) continue;
      if (lv.contentType && lv.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO'
        && lv.contentType !== 'LOCKUP_CONTENT_TYPE_SHORT') continue;
      const meta = deepFind(lv, 'lockupMetadataViewModel');
      const title = meta && meta.title
        ? (typeof meta.title.content === 'string' ? meta.title.content : textOf(meta.title))
        : '';
      let seconds = 0;
      const st = liveStatus(lv);
      for (const badge of deepCollect(lv, 'thumbnailBadgeViewModel')) {
        const t = badge && (typeof badge.text === 'string' ? badge.text : textOf(badge.text));
        const s = parseDurationText(t);
        if (s > 0) { seconds = s; break; }
      }
      // Channel name: first part of the lockup's first metadata row.
      let channel = '';
      let chEp;
      const partRows = deepCollect(lv, 'metadataParts');
      if (partRows.length && Array.isArray(partRows[0]) && partRows[0][0]) {
        const t = partRows[0][0].text;
        channel = (t && (typeof t.content === 'string' ? t.content : textOf(t))) || '';
        chEp = deepFind(partRows[0][0], 'browseEndpoint');
      }
      push(lv.contentId, title, seconds, deepFind(lv, 'setVideoId'),
        lv.contentType === 'LOCKUP_CONTENT_TYPE_SHORT', channel, st.live, st.upcoming, chEp);
    }
    // Newer Shorts-grid UI (channels whose uploads playlist renders as a
    // grid of Shorts instead of the classic row list — seen on channels
    // that upload only, or almost only, Shorts). No duration badge is
    // exposed here, so these are always seconds:0 (exact-ID matched only,
    // never title+duration deduped — same as live/upcoming entries).
    for (const sv of deepCollect(root, 'shortsLockupViewModel')) {
      if (!sv) continue;
      const videoId = deepFind(sv, 'videoId');
      if (!videoId) continue;
      const meta = sv.overlayMetadata;
      const title = meta && meta.primaryText
        ? (typeof meta.primaryText.content === 'string' ? meta.primaryText.content : textOf(meta.primaryText))
        : '';
      push(videoId, title, 0, null, true, '', false, false);
    }
  }

  // A playlist page hides unavailable videos ("N unavailable videos are
  // hidden") behind a "Show unavailable videos" menu item, which is just the
  // same browse with extra params. The label is localized, so any menu item
  // that re-browses this very playlist with params is taken as that switch.
  function unavailableParams(resp, playlistId) {
    let fallback = null;
    for (const it of deepCollect(resp, 'menuNavigationItemRenderer')) {
      const be = it && it.navigationEndpoint && it.navigationEndpoint.browseEndpoint;
      if (!be || !be.params || be.browseId !== 'VL' + playlistId) continue;
      if (/unavailable/i.test(textOf(it.text))) return be.params;
      fallback = fallback || be.params;
    }
    return fallback;
  }

  // All videos of a playlist: [{id, title, seconds, setVideoId}].
  // The returned array carries an `editable` property (true/false/undefined).
  async function fetchPlaylistVideos(playlistId, label, log, guard, opts = {}) {
    const videos = [];
    const seen = new Set();
    const usedTokens = new Set();
    const req = { browseId: 'VL' + playlistId };
    if (opts.params) req.params = opts.params;
    let data = await api('browse', req);
    let firstResponse = data;
    const e = deepFind(firstResponse, 'isEditable');
    videos.editable = typeof e === 'boolean' ? e : undefined;
    videos.unavailParams = unavailableParams(firstResponse, playlistId);
    videos.hiddenCount = hiddenUnavailableCount(firstResponse);
    // The playlist's own name, when the response carries one — so a
    // ledger/snapshot row can say "Songs" rather than "PL9k…".
    const hdr = deepFind(firstResponse, 'playlistHeaderRenderer');
    const ph = deepFind(firstResponse, 'pageHeaderRenderer');
    videos.title = (hdr && textOf(hdr.title))
      || (ph && typeof ph.pageTitle === 'string' ? ph.pageTitle : '') || '';
    let barren = 0; // consecutive continuation pages that added nothing
    const tally = () => videos.reduce((n, v) => n + (v.copies || 1), 0);
    for (;;) {
      if (guard) guard();
      const before = tally();
      extractVideos(data, seen, videos, opts.keepDupes);
      log(`${label}: ${videos.length} videos…`, true);
      if (opts.noContinue) break; // caller only wants a cheap first-page probe
      if (opts.ownOnly && videos.editable === false) return videos; // saved, not yours
      // YouTube can keep handing out fresh continuation tokens for pages
      // that only repeat what was already read — every token is new, so the
      // used-token check never trips and the count just sits there forever.
      barren = tally() === before && data !== firstResponse ? barren + 1 : 0;
      if (barren >= 3) {
        // Not provably complete, so it must not feed the deletion diff below
        // (anything unread would be booked as "removed").
        videos.partial = true;
        console.warn(`[YCFP] ${label} (${playlistId}): ${barren} continuation pages in a row added nothing — stopping here.`);
        log(`${label}: ⚠ YouTube kept repeating pages after ${videos.length} videos — stopped reading there.`);
        break;
      }
      const next = nextSectionToken(videoSection(data), usedTokens);
      if (!next) break;
      data = await api('browse', { continuation: next });
      await sleep(150);
    }
    // Every complete read of a playlist YOU can edit feeds the deleted-video
    // ledger: whatever was here last time and isn't now, you removed.
    // Auto-generated lists (UU…/UUSH…/UULV…) and playlists you only read are
    // not yours to have deleted from, so they're left alone.
    if (!opts.quiet && !opts.noContinue && !videos.partial && videos.editable !== false
      && /^(PL|LL|WL|FL)/.test(playlistId)) {
      const plTitle = videos.title || label;
      log(`${label}: ${videos.length} videos — updating the playlist archive…`, true);
      // The IndexedDB archive does the diff and also names anything YouTube
      // has killed since the last read; the localStorage snapshot is the
      // fallback for when IndexedDB is unavailable.
      // The archive is also the index behind the ✓ marks and the "was it
      // moved or deleted?" check, so this one read feeds all three.
      if (!(await archiveTrack(playlistId, plTitle, videos, log))) {
        await trackPlaylistSnapshot(playlistId, plTitle, videos, log);
      }
      await forgetKeptInPlaylist(playlistId, plTitle, videos, log);
    }
    if (videos.length === 0 && !opts.quiet) {
      const alert = deepFind(firstResponse, 'alertRenderer') || deepFind(firstResponse, 'alertWithButtonRenderer');
      if (alert) log(`${label}: ⚠ ${textOf(alert.text)}`);
      // Leave evidence for debugging unknown data models.
      console.warn(`[YCFP] ${label} (${playlistId}) parsed 0 videos — item section:`,
        videoSection(firstResponse), 'raw response:', firstResponse);
      log(`${label}: ⚠ 0 videos parsed — raw API response dumped to the browser console (F12).`);
    }
    return videos;
  }

  const TOPIC_SUFFIX = /\s*-\s*Topic$/i;

  // Auto-generated "- Topic" channels can never set a vanity handle, so their
  // search-result URL is always "/channel/UC…"; real artist/main channels
  // almost always have a "/@handle" URL. Cheap signal, already present in the
  // search response — no extra API calls.
  function candidateHasHandle(c) {
    const ep = deepFind(c, 'browseEndpoint');
    const url = (ep && ep.canonicalBaseUrl) || '';
    return url.startsWith('/@');
  }

  // Every channel whose title matches `name` exactly (normalized). There can
  // be more than one — different, unrelated channels (including several
  // distinct "<Name> - Topic" auto-channels for different artists sharing a
  // name) commonly collide on display name.
  async function searchChannelsByExactName(name, excludeId) {
    const data = await api('search', {
      query: name,
      params: 'EgIQAg==', // channels-only filter
    });
    const want = normTitle(name);
    const out = [];
    const seen = new Set();
    for (const c of deepCollect(data, 'channelRenderer')) {
      if (!c.channelId || c.channelId === excludeId || seen.has(c.channelId)) continue;
      if (normTitle(textOf(c.title)) !== want) continue;
      seen.add(c.channelId);
      const ep = deepFind(c, 'browseEndpoint');
      out.push({
        channelId: c.channelId,
        hasHandle: candidateHasHandle(c),
        // Shown in the review list so same-named channels can be told apart
        // at a glance without opening each one.
        title: textOf(c.title) || name,
        handle: (ep && ep.canonicalBaseUrl && ep.canonicalBaseUrl.startsWith('/@'))
          ? ep.canonicalBaseUrl.slice(1) : '',
        subs: textOf(c.subscriberCountText),
        videoCount: textOf(c.videoCountText),
      });
    }
    // Nov 2026: channel results became lockupViewModel (contentType
    // LOCKUP_CONTENT_TYPE_CHANNEL) — with only channelRenderer read, every
    // main↔Topic counterpart search came back empty.
    for (const lv of deepCollect(data, 'lockupViewModel')) {
      if (!lv || lv.contentType !== 'LOCKUP_CONTENT_TYPE_CHANNEL') continue;
      const id = lv.contentId;
      if (!/^UC[\w-]{22}$/.test(id || '') || id === excludeId || seen.has(id)) continue;
      const meta = deepFind(lv, 'lockupMetadataViewModel');
      const title = meta && meta.title
        ? (typeof meta.title.content === 'string' ? meta.title.content : textOf(meta.title)) : '';
      if (normTitle(title) !== want) continue;
      seen.add(id);
      const ep = deepFind(lv, 'browseEndpoint');
      const parts = deepCollect(lv, 'metadataParts').flat()
        .map((p) => p && p.text && (typeof p.text.content === 'string' ? p.text.content : '')).filter(Boolean);
      out.push({
        channelId: id,
        hasHandle: candidateHasHandle(lv),
        title: title || name,
        handle: (ep && ep.canonicalBaseUrl && ep.canonicalBaseUrl.startsWith('/@')) ? ep.canonicalBaseUrl.slice(1) : '',
        subs: parts.find((t) => /subscriber/i.test(t)) || '',
        videoCount: parts.find((t) => /\bvideos?\b/i.test(t)) || '',
      });
    }
    return out;
  }

  // Search for a channel whose title matches `name` exactly (normalized).
  async function findChannelByExactName(name, excludeId) {
    const candidates = await searchChannelsByExactName(name, excludeId);
    return candidates.length ? candidates[0].channelId : null;
  }

  // How much of a candidate companion channel's uploads (cheap first-page
  // probe, no continuation) fuzzy-match videos already known to belong to the
  // channel being collected. Used only to break ties between several
  // same-named candidates — real companions share most of their catalog,
  // unrelated channels that merely share a display name share none of it.
  async function scoreCandidateOverlap(candidateId, ownVideos, guard) {
    if (!ownVideos.length) return 0;
    let sample;
    try {
      sample = await fetchUploadsOrReleases(
        candidateId, 'probe', () => {}, guard, { quiet: true, noContinue: true });
    } catch (e) {
      return -1; // unreachable / no uploads playlist at all — disqualify
    }
    if (!sample.length) return 0;
    const ownFuzz = new Map();
    for (const v of ownVideos) {
      if (v.seconds > 0) fuzzBucketAdd(ownFuzz, v.seconds, titleVariants(v.title, v.channel));
    }
    let hits = 0;
    for (const v of sample) {
      if (v.seconds > 0 && fuzzBucketHit(ownFuzz, titleVariants(v.title, v.channel), v.seconds)) hits++;
    }
    return hits / sample.length;
  }

  // Find the "- Topic" (or main) companion channel for `name`, disambiguating
  // between same-named channels rather than blindly taking the first search
  // hit (that was pulling in unrelated channels sharing a display name —
  // confirmed in the wild: e.g. multiple distinct "Metallica - Topic" and
  // "Drake - Topic" channels exist for different, unrelated uploaders).
  // `wantHandle`: true when the companion we're looking for should be a real
  // channel (has a vanity handle) — i.e. we started on a "- Topic" channel
  // and are looking for its main channel. False when looking for the "-
  // Topic" companion itself, which never has a handle.
  //
  // Returns EVERY same-named candidate, scored and sorted best-first, rather
  // than silently picking one: when several exist the review step lists them
  // all so you can choose (and tick more than one, for artists who really do
  // have two channels). candidates[0] stays the script's own best guess.
  async function findCompanionCandidates(name, excludeId, wantHandle, ownVideos, log, guard) {
    const candidates = await searchChannelsByExactName(name, excludeId);
    if (!candidates.length) return [];
    const out = candidates.map((c) => Object.assign({ id: c.channelId, score: null }, c));
    if (out.length === 1) return out;

    log(`⚠ ${out.length} channels are named "${name}" — scoring them by upload overlap…`);
    for (const c of out) c.score = await scoreCandidateOverlap(c.id, ownVideos, guard);
    // Right kind of channel first (Topic channels never have a handle),
    // then by how much of their catalog matches the channel being collected.
    // Fan reupload channels often score 100% (they copy the newest songs)
    // while the official one scores 20–60% — so among the ones that clearly
    // share songs (≥15%) the biggest audience wins, not the top score.
    const subsNum = (t) => {
      const m = String(t || '').match(/([\d.]+)\s*([KMB]?)/i);
      return m ? parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] || 1) : 0;
    };
    const strong = (c) => (c.score || 0) >= 0.15;
    out.sort((a, b) => (Number(b.hasHandle === wantHandle) - Number(a.hasHandle === wantHandle))
      || (Number(strong(b)) - Number(strong(a)))
      || (strong(a) && strong(b) ? subsNum(b.subs) - subsNum(a.subs) : 0)
      || ((b.score || 0) - (a.score || 0)));
    if (!out.some((c) => (c.score || 0) > 0)) {
      log(`⚠ None of the ${out.length} candidates could be confirmed to share uploads with this channel — `
        + 'pick the right one in the review step below (or untick them all).');
    }
    return out;
  }

  // Your own playlists, via the same endpoint the native "Save" dialog uses.
  async function getUserPlaylists(sampleVideoId) {
    try {
      const data = await api('playlist/get_add_to_playlist', { videoIds: [sampleVideoId] });
      const out = [];
      const seen = new Set();
      for (const p of deepCollect(data, 'playlistAddToOptionRenderer')) {
        if (!p.playlistId || seen.has(p.playlistId)) continue;
        seen.add(p.playlistId);
        out.push({ id: p.playlistId, title: textOf(p.title) || p.playlistId });
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  async function addToPlaylist(playlistId, videoIds, cfg, log, guard) {
    for (let i = 0; i < videoIds.length; i += cfg.batchSize) {
      if (guard) guard();
      const chunk = videoIds.slice(i, i + cfg.batchSize);
      const res = await api('browse/edit_playlist', {
        playlistId,
        actions: chunk.map((id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id })),
      });
      if (res.status && res.status !== 'STATUS_SUCCEEDED') {
        throw new Error(`add batch returned ${res.status} — ${i} of ${videoIds.length} videos were added before the failure; re-running skips those.`);
      }
      archivePatch(playlistId, '', chunk, []);
      log(`Added ${Math.min(i + chunk.length, videoIds.length)}/${videoIds.length}…`, true);
      await sleep(cfg.batchDelayMs);
    }
    invalidateExclCache();
  }

  async function createPlaylist(title, videoIds, cfg, log, guard) {
    const first = videoIds.slice(0, cfg.batchSize);
    const data = await api('playlist/create', { title, videoIds: first });
    const playlistId = data.playlistId || deepFind(data, 'playlistId');
    if (!playlistId) throw new Error('playlist/create returned no playlistId.');
    log(`Created playlist ${playlistId} (${first.length} videos).`);
    archivePatch(playlistId, title, first, []);
    await addToPlaylist(playlistId, videoIds.slice(cfg.batchSize), cfg, log, guard);
    return playlistId;
  }

  // ------------------------------------------------------------------
  // Music library (shared with the Music Library website)
  //
  // Every song has ONE category, 1–5 stars and optional flairs (Long,
  // Secondary). That combination decides which YouTube playlist it lives
  // in: "4★ Song", "3★ Relax · Long", … (the old playlists keep their names
  // and serve as those combinations' playlists). A combination's playlist
  // is created only when its first song arrives, and when it reaches
  // YouTube's 5000 cap the next one ("… 2") is made automatically.
  //
  // The library itself is a Firestore database shown on the website. This
  // page-context script cannot sign in there, so the sandboxed companion
  // "YCFP Library Bridge" does the database reads/writes over postMessage
  // (protocol tag ytmlBridge). Mirrors yt-music-library/js/model.js.
  // ------------------------------------------------------------------
  const LIB_SITE = 'https://proj-yeet.github.io/yt-music-library/';
  const LIB_BRIDGE_URL = 'https://github.com/ProJ-Yeet/yt-channel-playlist-collector#music-library';
  const LIB_CHUNKS = 32;
  const LIB_LONG_SEC = 15 * 60;
  const LIB_CATS = [
    ['song', 'Song', 'S'], ['music', 'Music', 'M'], ['relax', 'Relax', 'R'], ['slow', 'Slow', 'Sl'],
    ['electric', 'Electric', 'E'], ['classical', 'Classical', 'C'], ['pop', 'Pop', 'P'], ['rock', 'Rock', 'Ro'],
    ['epic', 'Epic', 'Ep'], ['minecraft', 'Minecraft', 'Mc'], ['hololive', 'Hololive', 'H'],
  ];
  const LIB_CAT_NAME = Object.fromEntries(LIB_CATS.map(([id, name]) => [id, name]));
  const LIB_FLAIRS = [['L', 'Long'], ['S', 'Secondary']];

  // Your existing playlists → rating (title, stars, category, flairs).
  const LIB_IMPORT_MAP = [
    ['Best Songs', 5, 'song', ''],
    ['Songs', 4, 'song', ''], ['Songs 2', 4, 'song', ''], ['Songs 3', 4, 'song', ''],
    ['Pop Songs', 4, 'pop', ''], ['Classical', 4, 'classical', ''], ['Good Minecraft Songs', 4, 'minecraft', ''],
    ['Relaxing Music', 3, 'relax', ''], ['Slow', 3, 'slow', ''], ['Epic', 3, 'epic', ''],
    ['Secondary', 3, 'song', 'S'], ['Songs Long', 3, 'song', 'L'], ['Relaxing Long', 3, 'relax', 'L'],
    ['Soft songs', 2, 'song', ''], ['Electric', 2, 'electric', ''],
  ];
  // Read only to recognise Hololive songs (not imported themselves).
  const LIB_HOLO_LISTS = ['Hololive Songs 2025 10 11', 'ホロライブ歌ってみた / Hololive Songs&Covers', 'Hololive', 'HoroRaibu'];
  const LIB_HOLO_RE = /hololive|ホロライブ|holoX|ホロックス|ReGLOSS|FLOW GLOW|holostars/i;

  function libChunkOf(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
    return h % LIB_CHUNKS;
  }
  const libChunkId = (i) => 'c' + String(i).padStart(2, '0');
  const libNormFlairs = (f) => [...new Set(String(f || '').split(''))]
    .filter((x) => LIB_FLAIRS.some(([id]) => id === x)).sort().join('');
  const libAutoFlairs = (f, d) => libNormFlairs((f || '') + (d > LIB_LONG_SEC ? 'L' : ''));
  const libBucketKey = (v) => { const f = libNormFlairs(v.f); return `${v.s}-${v.c}${f ? '-' + f : ''}`; };
  function libBucketName(key) {
    const [s, c, f = ''] = String(key).split('-');
    const fl = LIB_FLAIRS.filter(([id]) => f.includes(id)).map(([, n]) => ` · ${n}`).join('');
    return `${s}★ ${LIB_CAT_NAME[c] || c}${fl}`;
  }

  // --- bridge ---------------------------------------------------------
  let libSeq = 0;
  function libBridge(op, args = {}, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const reqId = `ytml${Date.now().toString(36)}${++libSeq}`;
      const onMsg = (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.ytmlBridge !== 'result' || d.reqId !== reqId) return;
        done();
        if (d.ok) resolve(d.result); else reject(new Error(d.error || 'bridge error'));
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error('The "YCFP Library Bridge" userscript did not answer. Is it installed and enabled?'));
      }, timeoutMs);
      function done() { clearTimeout(timer); window.removeEventListener('message', onMsg); }
      window.addEventListener('message', onMsg);
      window.postMessage({ ytmlBridge: op, reqId, args }, location.origin);
    });
  }

  // --- cached copy of the library ---------------------------------------
  const lib = { meta: null, videos: null, loadedAt: 0, loading: null };
  function libLoad(force = false) {
    if (!force && lib.videos && Date.now() - lib.loadedAt < 5 * 60 * 1000) return Promise.resolve(lib);
    if (lib.loading) return lib.loading;
    lib.loading = libBridge('getAll', {}, 60000).then((r) => {
      lib.meta = r.meta || {};
      lib.meta.buckets = lib.meta.buckets || {};
      lib.videos = new Map();
      for (const m of r.chunks || []) for (const [id, v] of Object.entries(m || {})) lib.videos.set(id, v);
      lib.loadedAt = Date.now();
      return lib;
    }).finally(() => { lib.loading = null; });
    return lib.loading;
  }
  function libPlToBucket() {
    const m = new Map();
    for (const [key, chain] of Object.entries((lib.meta && lib.meta.buckets) || {})) {
      for (const pl of chain || []) m.set(pl.id, key);
    }
    return m;
  }
  function libPlaylistName(pid) {
    for (const chain of Object.values((lib.meta && lib.meta.buckets) || {})) {
      for (const pl of chain || []) if (pl.id === pid) return pl.name;
    }
    return playlistTitleOf(pid);
  }
  function libBumpCount(pid, delta) {
    for (const chain of Object.values((lib.meta && lib.meta.buckets) || {})) {
      for (const pl of chain || []) if (pl.id === pid) pl.n = Math.max(0, (pl.n || 0) + delta);
    }
  }
  const libSaveMeta = () => libBridge('setMeta', { fields: { buckets: lib.meta.buckets } });
  const libPutVideos = (ids) => libBridge('putVideos', {
    items: ids.map((id) => ({ id, chunk: libChunkId(libChunkOf(id)), rec: lib.videos.get(id) })),
  });

  // Name for a combination's next playlist: continues the last one's
  // numbering ("Songs 3" → "Songs 4", "Epic" → "Epic 2"), or the
  // combination's own name ("4★ Pop · Long") when it has none yet.
  function libNextName(key, chain) {
    const last = chain[chain.length - 1];
    if (!last) return libBucketName(key);
    const m = /^(.*?) (\d+)$/.exec(last.name || '');
    return m ? `${m[1]} ${Number(m[2]) + 1}` : `${last.name || libBucketName(key)} 2`;
  }

  // Add videos to a combination's newest playlist, making the next one when
  // it is full (or when there is none yet). Returns videoId → playlistId.
  async function libAddToBucket(key, ids, log = () => {}, guard = null) {
    const cfg = loadCfg();
    const chain = lib.meta.buckets[key] || (lib.meta.buckets[key] = []);
    const placed = new Map();
    const remaining = ids.slice();
    while (remaining.length) {
      if (guard) guard();
      let pl = chain[chain.length - 1];
      if (!pl || (pl.n || 0) >= PLAYLIST_CAP) {
        const name = libNextName(key, chain);
        const take = remaining.splice(0, PLAYLIST_CAP);
        const id = await createPlaylist(name, take, cfg, log, guard);
        chain.push({ id, name, n: take.length });
        for (const v of take) placed.set(v, id);
        await libSaveMeta(); // the new playlist must be on record even if a later step fails
        log(`Library: created playlist "${name}".`);
        continue;
      }
      const take = remaining.splice(0, PLAYLIST_CAP - (pl.n || 0));
      try {
        await addToPlaylist(pl.id, take, cfg, log, guard);
      } catch (e) {
        // Out-of-date count and the playlist is really full: roll over.
        if ((pl.n || 0) >= PLAYLIST_CAP - 100) { pl.n = PLAYLIST_CAP; remaining.unshift(...take); continue; }
        throw e;
      }
      pl.n = (pl.n || 0) + take.length;
      for (const v of take) placed.set(v, pl.id);
    }
    return placed;
  }

  async function libRemoveMany(pid, ids, to = null) {
    const cfg = loadCfg();
    for (let i = 0; i < ids.length; i += cfg.batchSize) {
      const part = ids.slice(i, i + cfg.batchSize);
      const res = await api('browse/edit_playlist', {
        playlistId: pid,
        actions: part.map((id) => ({ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: id })),
      });
      if (res.status && res.status !== 'STATUS_SUCCEEDED') throw new Error(res.status);
      archivePatch(pid, '', [], part);
      libBumpCount(pid, -part.length);
      journalRemovals(part.map((id) => ({
        id, title: (lib.videos.get(id) || {}).t || '', playlistId: pid, playlistTitle: libPlaylistName(pid),
      })), 'move', to);
      await sleep(cfg.batchDelayMs);
    }
    invalidateExclCache();
  }

  async function libVideoDetails(videoId) {
    const d = await api('player', { videoId });
    const vd = (d && d.videoDetails) || {};
    return {
      t: vd.title || '',
      a: String(vd.author || '').replace(TOPIC_SUFFIX, ''),
      d: parseInt(vd.lengthSeconds || '0', 10) || 0,
    };
  }

  // Rate one video (from the strip): save the rating and move the video
  // into its combination's playlist. ctx = { listId, setVideoId, canEdit }:
  // like the old move buttons, it also leaves the playlist you are in
  // (only when you can edit it; never Liked videos).
  async function libFile(videoId, patch, ctx = {}) {
    await libLoad();
    let rec = lib.videos.get(videoId);
    if (!rec) rec = { ...(await libVideoDetails(videoId)), c: 'song', s: 3, f: '', x: Date.now() };
    const next = { ...rec, ...patch };
    next.f = libAutoFlairs(next.f, next.d);
    const key = libBucketKey(next);
    const plMap = libPlToBucket();
    let home = rec.p && plMap.get(rec.p) === key ? rec.p : null;
    if (!home && ctx.listId && plMap.get(ctx.listId) === key) home = ctx.listId;
    if (!home) home = (await libAddToBucket(key, [videoId])).get(videoId);
    const toInfo = { id: home, title: libPlaylistName(home) };
    let leftCurrent = false;
    if (rec.p && rec.p !== home && rec.p !== ctx.listId) {
      try { await libRemoveMany(rec.p, [videoId], toInfo); } catch (e) {
        console.warn('[YCFP] library: could not remove from old playlist', rec.p, e);
      }
    }
    if (ctx.canEdit && ctx.listId && ctx.listId !== home && ctx.listId !== 'LL') {
      await removeFromPlaylist(ctx.listId, videoId, ctx.setVideoId || null);
      libBumpCount(ctx.listId, -1);
      journalRemovals([{ id: videoId, title: next.t, playlistId: ctx.listId, playlistTitle: libPlaylistName(ctx.listId) }], 'move', toInfo);
      leftCurrent = true;
    }
    next.p = home;
    next.u = Date.now();
    lib.videos.set(videoId, next);
    await libPutVideos([videoId]);
    await libSaveMeta();
    return { key, home, leftCurrent };
  }

  // Ratings changed on the website: move those songs into their new
  // combination's playlist (and out of the old one).
  async function libSyncPending(log = () => {}, guard = null, max = Infinity) {
    await libLoad(true);
    const plMap = libPlToBucket();
    const groups = new Map();
    for (const [id, v] of lib.videos) {
      const key = libBucketKey(v);
      if (v.p && plMap.get(v.p) === key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    }
    let done = 0;
    for (const [key, all] of groups) {
      const ids = all.slice(0, Math.max(0, max - done));
      if (!ids.length) break;
      log(`Library: moving ${ids.length} into "${libBucketName(key)}"…`);
      const placed = await libAddToBucket(key, ids, log, guard);
      const byOld = new Map();
      for (const id of ids) {
        const old = lib.videos.get(id).p;
        const to = placed.get(id);
        if (!old || old === to) continue;
        const k = `${old}>${to}`;
        if (!byOld.has(k)) byOld.set(k, { old, to, ids: [] });
        byOld.get(k).ids.push(id);
      }
      for (const { old, to, ids: rm } of byOld.values()) {
        if (guard) guard();
        try { await libRemoveMany(old, rm, { id: to, title: libPlaylistName(to) }); } catch (e) {
          log(`⚠ Could not remove ${rm.length} from ${libPlaylistName(old)} (${e.message || e}); they stay there too.`);
        }
      }
      for (const id of ids) {
        const v = lib.videos.get(id);
        v.p = placed.get(id);
        v.u = Date.now();
      }
      await libPutVideos(ids);
      await libSaveMeta();
      done += ids.length;
    }
    return done;
  }

  function libToast(msg) {
    let n = document.getElementById('ycfp-lib-toast');
    if (!n) {
      n = el('div', { id: 'ycfp-lib-toast', style: 'position:fixed;bottom:24px;left:24px;z-index:2147483647;max-width:min(460px,85vw);padding:10px 14px;background:#1d2b3a;color:#fff;border:1px solid #4a7aa8;border-radius:8px;font:13px/1.5 sans-serif;box-shadow:0 4px 20px #0008' });
      document.body.append(n);
    }
    n.textContent = msg;
    clearTimeout(n._t);
    n._t = setTimeout(() => n.remove(), 8000);
  }

  // Background sync, at most every 9 minutes across all tabs.
  async function libAutoSync() {
    try {
      if (document.hidden || loadCfg().libraryAutoSync === false) return;
      const last = Number(localStorage.getItem('ycfp-lib-sync') || 0);
      if (Date.now() - last < 9 * 60 * 1000) return;
      localStorage.setItem('ycfp-lib-sync', String(Date.now()));
      const ping = await libBridge('ping', {}, 4000);
      if (!ping.signedIn) return;
      const n = await libSyncPending(() => {}, null, 300);
      if (n) libToast(`🗂 Music library: moved ${n} song${n === 1 ? '' : 's'} into their rating's playlist.`);
    } catch (e) {
      console.warn('[YCFP] library auto-sync:', e.message || e);
    }
  }

  // Rating strip: category letters on top, stars + flairs below.
  function buildRatingStrip(videoId, ctx, mini = false) {
    const wrap = el('div', { class: 'ycfp-rate' + (mini ? ' ycfp-rate-mini' : '') });
    const top = el('div', { class: 'ycfp-rate-row' });
    const bottom = el('div', { class: 'ycfp-rate-row' });
    wrap.append(top, bottom);
    let pendingCat = null;
    const shield = (b) => {
      for (const n of ['mousedown', 'pointerdown', 'touchstart']) b.addEventListener(n, (ev) => ev.stopPropagation());
      return b;
    };
    const run = (fn) => async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (wrap.classList.contains('ycfp-busy')) return;
      wrap.classList.add('ycfp-busy');
      try {
        const r = await fn();
        if (r && r.leftCurrent) markRowDone(videoId);
      } catch (e) {
        console.warn('[YCFP] library rating failed:', e);
        showQuickActionError(`Music library: ${e.message || e}`);
      }
      wrap.classList.remove('ycfp-busy');
      paint();
    };
    const recOf = () => lib.videos && lib.videos.get(videoId);
    const cats = LIB_CATS.map(([id, name, short]) => {
      const b = shield(el('button', { class: 'ycfp-rate-cat', 'data-c': id, title: name }, short));
      b.addEventListener('click', run(async () => {
        await libLoad();
        if (!recOf()) { pendingCat = id; return null; } // pick stars next
        return libFile(videoId, { c: id }, ctx);
      }));
      top.append(b);
      return [id, b];
    });
    const stars = [1, 2, 3, 4, 5].map((n) => {
      const b = shield(el('button', { class: 'ycfp-rate-star', title: `${n} star${n > 1 ? 's' : ''}` }, '★'));
      b.addEventListener('click', run(async () => {
        await libLoad();
        return libFile(videoId, recOf() ? { s: n } : { c: pendingCat || 'song', s: n }, ctx);
      }));
      bottom.append(b);
      return [n, b];
    });
    const flairs = LIB_FLAIRS.map(([id, name]) => {
      const b = shield(el('button', { class: 'ycfp-rate-fl', title: name }, id === 'L' ? 'L' : '2nd'));
      b.addEventListener('click', run(async () => {
        await libLoad();
        const rec = recOf();
        const f = rec ? rec.f || '' : '';
        if (id === 'L' && rec && rec.d > LIB_LONG_SEC) return null; // always Long
        const nf = f.includes(id) ? f.replace(id, '') : f + id;
        return libFile(videoId, rec ? { f: nf } : { c: pendingCat || 'song', s: 3, f: nf }, ctx);
      }));
      bottom.append(b);
      return [id, b];
    });
    function paint() {
      const rec = recOf();
      for (const [id, b] of cats) {
        b.classList.toggle('ycfp-on', rec ? rec.c === id : pendingCat === id);
        b.classList.toggle('ycfp-pending', !rec && pendingCat === id);
      }
      for (const [n, b] of stars) b.classList.toggle('ycfp-on', !!rec && n <= rec.s);
      for (const [id, b] of flairs) b.classList.toggle('ycfp-on', !!rec && (rec.f || '').includes(id));
      wrap.title = rec
        ? `Music library: ${libBucketName(libBucketKey(rec))}`
        : (lib.videos ? 'Not in the music library yet: pick a category, then stars' : 'Music library');
    }
    libLoad().then(() => { wrap.classList.remove('ycfp-rate-off'); paint(); }).catch(() => {
      wrap.classList.add('ycfp-rate-off');
      wrap.title = 'Music library unavailable: the "YCFP Library Bridge" userscript is not answering.';
    });
    paint();
    return wrap;
  }

  // --- 🗂 dialog: status, sync, settings, import --------------------------
  async function openLibraryDialog() {
    const ui = openDialog('🗂 Music library', true);
    const status = el('div', {}, 'Checking the library bridge…');
    ui.body.append(status);
    let ping;
    try {
      ping = await libBridge('ping', {}, 4000);
    } catch (e) {
      status.replaceChildren(`⚠ ${e.message} `, el('a', { href: LIB_BRIDGE_URL, target: '_blank' }, 'How to install it'));
      return;
    }
    try { await libLoad(true); } catch (e) { status.textContent = `⚠ Could not read the library: ${e.message || e}`; return; }
    const plMap = libPlToBucket();
    let pending = 0;
    for (const v of lib.videos.values()) if (!v.p || plMap.get(v.p) !== libBucketKey(v)) pending++;
    status.replaceChildren(
      el('div', {}, `${lib.videos.size.toLocaleString()} songs in the library · ${pending.toLocaleString()} waiting to move to their rating's playlist.`),
      el('div', {}, ping.signedIn
        ? 'Signed in: ratings you set here are saved to the website.'
        : '⚠ Not signed in yet: open the website below, sign in with Google once, then reload this page.'),
    );
    const cfg = loadCfg();
    const autoBox = el('input', { type: 'checkbox', checked: cfg.libraryAutoSync !== false });
    autoBox.addEventListener('change', () => { const c = loadCfg(); c.libraryAutoSync = autoBox.checked; saveCfg(c); });
    const oldBox = el('input', { type: 'checkbox', checked: !!cfg.libraryOldButtons });
    oldBox.addEventListener('change', () => { const c = loadCfg(); c.libraryOldButtons = oldBox.checked; saveCfg(c); });
    const syncBtn = el('button', { class: 'ycfp-btn' }, `⟳ Move the ${pending.toLocaleString()} waiting now`);
    syncBtn.disabled = !pending || !ping.signedIn;
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      try { const n = await libSyncPending(ui.log, ui.guard); ui.log(`✓ Moved ${n} songs.`); } catch (e) { ui.log(`⚠ ${e.message || e}`); }
    });
    const importBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, '⇩ Import my playlists…');
    importBtn.disabled = !ping.signedIn;
    importBtn.addEventListener('click', () => { importBtn.disabled = true; libImport(ui).catch((e) => ui.log(`⚠ ${e.message || e}`)); });
    ui.body.append(
      el('div', { class: 'ycfp-row' }, el('a', { href: LIB_SITE, target: '_blank' }, 'Open the Music Library website ↗')),
      el('label', { class: 'ycfp-check' }, autoBox, ' Move songs rated on the website automatically while YouTube is open'),
      el('label', { class: 'ycfp-check' }, oldBox, ' Also show the old quick-move buttons next to the rating strip'),
      el('div', { class: 'ycfp-row' }, syncBtn, importBtn),
    );
  }

  async function libImport(ui) {
    const log = ui.log;
    log('Finding your playlists…');
    const own = await getOwnPlaylists(log);
    const byTitle = new Map();
    for (const p of own) {
      const k = p.title.trim().toLowerCase();
      if (!byTitle.has(k)) byTitle.set(k, []);
      byTitle.get(k).push(p);
    }
    const found = [];
    for (const [title, s, c, f] of LIB_IMPORT_MAP) {
      const hits = byTitle.get(title.toLowerCase()) || [];
      if (!hits.length) { log(`· "${title}" not found, skipped.`); continue; }
      if (hits.length > 1) log(`· ${hits.length} playlists are called "${title}"; using the first.`);
      found.push({ title, id: hits[0].id, s, c, f, key: libBucketKey({ s, c, f }) });
    }
    const occ = new Map(); // videoId → [{entry, idx, v}]
    const importStart = Date.now();
    for (const e of found) {
      ui.guard();
      const vids = await fetchPlaylistVideos(e.id, e.title, log, ui.guard);
      e.count = vids.reduce((n, v) => n + (v.copies || 1), 0);
      vids.forEach((v, idx) => {
        if (v.dead || !v.id) return;
        if (!occ.has(v.id)) occ.set(v.id, []);
        occ.get(v.id).push({ entry: e, idx, len: vids.length, v });
      });
      log(`${e.title}: ${vids.length} videos → ${libBucketName(e.key)}`);
    }
    // Hololive: songs in your Hololive playlists, plus channels that appear
    // there at least twice, plus Hololive names in the channel or title.
    const holoIds = new Set();
    const holoChCount = new Map();
    for (const t of LIB_HOLO_LISTS) {
      for (const p of byTitle.get(t.toLowerCase()) || []) {
        ui.guard();
        const vids = await fetchPlaylistVideos(p.id, t, log, ui.guard, { quiet: true });
        for (const v of vids) {
          holoIds.add(v.id);
          const ch = v.channelId || v.channel;
          if (ch) holoChCount.set(ch, (holoChCount.get(ch) || 0) + 1);
        }
      }
    }
    const holoCh = new Set([...holoChCount].filter(([, n]) => n >= 2).map(([ch]) => ch));

    await libLoad(true);
    const recs = new Map();
    const holoByChannel = new Map(); // channel label → [videoId]
    const prefer = (a, b) => b.entry.s - a.entry.s
      || (a.entry.c === 'song') - (b.entry.c === 'song')
      || a.entry.f.length - b.entry.f.length;
    for (const [id, list] of occ) {
      list.sort(prefer);
      const win = list[0];
      const v = win.v;
      const old = lib.videos.get(id);
      const rec = old ? { ...old } : {
        t: v.title || '', a: String(v.channel || '').replace(TOPIC_SUFFIX, ''), d: v.seconds || 0,
        c: win.entry.c, s: win.entry.s, f: win.entry.f,
        x: importStart - (win.len - win.idx) * 1000,
      };
      rec.f = libAutoFlairs(rec.f, rec.d);
      if (!old) {
        const ch = v.channelId || v.channel;
        if (holoIds.has(id) || (ch && holoCh.has(ch)) || LIB_HOLO_RE.test(`${v.channel} ${v.title}`)) {
          const label = v.channel || '(unknown channel)';
          if (!holoByChannel.has(label)) holoByChannel.set(label, []);
          holoByChannel.get(label).push(id);
        }
      }
      // Home: where it already sits among playlists of its combination.
      rec.p = (list.find((o) => o.entry.key === libBucketKey(rec)) || win).entry.id;
      recs.set(id, rec);
    }
    const kept = [...lib.videos.keys()].filter((id) => !recs.has(id));
    for (const id of kept) recs.set(id, lib.videos.get(id)); // rated earlier, not in these playlists

    // Review
    const holoBoxes = [];
    const holoList = el('div', { style: 'max-height:220px;overflow:auto;border:1px solid #444;padding:6px;margin:6px 0' });
    for (const [label, ids] of [...holoByChannel].sort((a, b) => b[1].length - a[1].length)) {
      const box = el('input', { type: 'checkbox', checked: true });
      holoBoxes.push({ box, ids });
      holoList.append(el('label', { class: 'ycfp-check', style: 'display:block' }, box, ` ${label} (${ids.length})`));
    }
    const holoTotal = [...holoByChannel.values()].reduce((n, a) => n + a.length, 0);
    const dupes = [...occ.values()].filter((l) => l.length > 1).length;
    const saveBtn = el('button', { class: 'ycfp-btn' }, '💾 Save library to the website');
    ui.body.append(
      el('h3', {}, 'Import review'),
      el('div', {}, `${recs.size.toLocaleString()} songs (${occ.size.toLocaleString()} from these playlists${kept.length ? `, ${kept.length} already rated elsewhere` : ''}). ${dupes.toLocaleString()} are in more than one playlist: the highest rating wins.`),
      el('div', {}, `Hololive: ${holoTotal.toLocaleString()} songs from ${holoByChannel.size} channels get the Hololive category (keeping their stars). Untick a channel that is not Hololive:`),
      holoList,
      el('div', {}, 'Songs already in the library keep their current rating. Nothing on YouTube changes until the next step.'),
      el('div', { class: 'ycfp-row' }, saveBtn),
    );
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        for (const { box, ids } of holoBoxes) {
          if (!box.checked) continue;
          for (const id of ids) {
            const r = recs.get(id);
            r.c = 'hololive';
          }
        }
        // Re-pick homes after the Hololive change.
        for (const [id, r] of recs) {
          const list = occ.get(id);
          if (list) r.p = (list.find((o) => o.entry.key === libBucketKey(r)) || list[0]).entry.id;
        }
        const buckets = {};
        for (const e of found) {
          if (!buckets[e.key]) buckets[e.key] = [];
          if (!buckets[e.key].some((p) => p.id === e.id)) buckets[e.key].push({ id: e.id, name: e.title, n: e.count });
        }
        for (const [key, chain] of Object.entries(lib.meta.buckets || {})) {
          for (const pl of chain) {
            if (!buckets[key]) buckets[key] = [];
            if (!buckets[key].some((p) => p.id === pl.id)) buckets[key].push(pl);
          }
        }
        const chunks = {};
        for (let i = 0; i < LIB_CHUNKS; i++) chunks[libChunkId(i)] = {};
        for (const [id, r] of recs) chunks[libChunkId(libChunkOf(id))][id] = r;
        log('Saving the library…');
        await libBridge('setChunks', { chunks });
        await libBridge('setMeta', { fields: { buckets, importedAt: Date.now() } });
        lib.meta.buckets = buckets;
        lib.videos = new Map(recs);
        lib.loadedAt = Date.now();
        log(`✓ Saved ${recs.size.toLocaleString()} songs. They are on the website now.`);
        libOfferTidy(ui, found, occ);
      } catch (e) {
        log(`⚠ Save failed: ${e.message || e}`);
        saveBtn.disabled = false;
      }
    });
  }

  // After an import: remove duplicate copies, then move songs whose
  // combination differs from where they sit (Hololive, Long, …).
  function libOfferTidy(ui, found, occ) {
    const mapped = new Set(found.map((e) => e.id));
    const dupRemovals = new Map(); // playlistId → [videoId]
    for (const [id, list] of occ) {
      const home = (lib.videos.get(id) || {}).p;
      for (const o of list) {
        if (o.entry.id === home || !mapped.has(o.entry.id)) continue;
        if (!dupRemovals.has(o.entry.id)) dupRemovals.set(o.entry.id, new Set());
        dupRemovals.get(o.entry.id).add(id);
      }
    }
    const plMap = libPlToBucket();
    let moves = 0;
    for (const v of lib.videos.values()) if (!v.p || plMap.get(v.p) !== libBucketKey(v)) moves++;
    const dupCount = [...dupRemovals.values()].reduce((n, s) => n + s.size, 0);
    const btn = el('button', { class: 'ycfp-btn' }, `🧹 Tidy YouTube: remove ${dupCount.toLocaleString()} duplicate copies, move ${moves.toLocaleString()} songs`);
    ui.body.append(
      el('h3', {}, 'Tidy your playlists'),
      el('div', {}, 'Every removal is recorded in 📜 history (as a move), so it can be undone.'),
      el('div', { class: 'ycfp-row' }, btn),
    );
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        for (const [pid, set] of dupRemovals) {
          ui.guard();
          const ids = [...set];
          ui.log(`Removing ${ids.length} duplicates from ${libPlaylistName(pid)}…`);
          const homes = new Map();
          for (const id of ids) {
            const h = lib.videos.get(id).p;
            if (!homes.has(h)) homes.set(h, []);
            homes.get(h).push(id);
          }
          for (const [h, part] of homes) await libRemoveMany(pid, part, { id: h, title: libPlaylistName(h) });
        }
        await libSaveMeta();
        const n = await libSyncPending(ui.log, ui.guard);
        ui.log(`✓ Done: ${dupCount} duplicates removed, ${n} songs moved.`);
      } catch (e) {
        ui.log(`⚠ ${e.message || e} (run it again to continue)`);
        btn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------------
  // Quick actions on the watch-page playlist panel
  // ------------------------------------------------------------------
  const editableCache = new Map();

  // Can the logged-in user edit this playlist? Primary signal: isEditable in
  // the playlist's browse response. Fallback: the playlist shows up in the
  // native "Save to playlist" list (= it's one of the user's own).
  async function isPlaylistEditable(listId, sampleVideoId) {
    if (editableCache.has(listId)) return editableCache.get(listId);
    let editable = null;
    if (/^(RD|UL|PU|OLAK)/.test(listId)) editable = false; // mixes/albums: never editable
    if (editable === null) {
      try {
        const data = await api('browse', { browseId: 'VL' + listId });
        const e = deepFind(data, 'isEditable');
        if (typeof e === 'boolean') editable = e;
      } catch (e) { /* try fallback */ }
    }
    if (editable === null && sampleVideoId) {
      try {
        const data = await api('playlist/get_add_to_playlist', { videoIds: [sampleVideoId] });
        editable = deepCollect(data, 'playlistAddToOptionRenderer')
          .some((p) => p && p.playlistId === listId);
      } catch (e) { editable = false; }
    }
    editable = !!editable;
    editableCache.set(listId, editable);
    return editable;
  }

  // With a setVideoId (per-entry handle) only that entry is removed;
  // without one, remove-by-video-id takes out every copy in the playlist.
  async function removeFromPlaylist(listId, videoId, setVideoId = null) {
    const res = await api('browse/edit_playlist', {
      playlistId: listId,
      actions: [setVideoId
        ? { action: 'ACTION_REMOVE_VIDEO', setVideoId }
        : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }],
    });
    if (res.status && res.status !== 'STATUS_SUCCEEDED') throw new Error(res.status);
    invalidateExclCache();
    archivePatch(listId, '', [], [videoId]);
  }

  // Membership of a video in the user's playlists (same signal the native
  // "Save to playlist" dialog shows), cached per video for the session.
  const membershipCache = new Map(); // videoId -> Promise<Map<playlistId, bool>>
  const plTitleCache = new Map();    // playlistId -> title, as the Save dialog names it
  const playlistTitleOf = (pid) => plTitleCache.get(pid)
    || (archIdx && archIdx.titles.get(pid)) || pid;

  // One uncached lookup: every playlist of yours, and whether it holds the
  // video. `ok` is false when YouTube's answer couldn't be read — "not in
  // any playlist" and "don't know" must never be confused (that is what
  // turns a move into a false deletion).
  async function fetchMembership(videoId) {
    const map = new Map();
    try {
      const data = await api('playlist/get_add_to_playlist', { videoIds: [videoId] });
      for (const o of deepCollect(data, 'playlistAddToOptionRenderer')) {
        if (!o || !o.playlistId) continue;
        map.set(o.playlistId, o.containsSelectedVideos === 'ALL');
        const t = textOf(o.title);
        if (t) plTitleCache.set(o.playlistId, t);
      }
    } catch (e) { return { ok: false, map }; }
    return { ok: map.size > 0, map };
  }

  function getMembership(videoId) {
    let p = membershipCache.get(videoId);
    if (!p) {
      // Empty on failure — worst case the buttons stay enabled.
      p = fetchMembership(videoId).then((r) => r.map);
      membershipCache.set(videoId, p);
    }
    return p;
  }

  async function isVideoInPlaylist(videoId, playlistId) {
    return (await getMembership(videoId)).get(playlistId) === true;
  }

  async function setMembership(videoId, playlistId, val) {
    (await getMembership(videoId)).set(playlistId, val);
  }

  // Highlight move buttons whose target already contains the video. They
  // stay clickable: pressing a green button removes the song from that
  // playlist again (toggle).
  async function applyMembership(videoId, moveBtns) {
    if (!moveBtns.length) return;
    const map = await getMembership(videoId);
    for (const { btn, target, name, verb } of moveBtns) {
      const inTarget = map.get(target) === true;
      btn.classList.toggle('ycfp-qa-in', inTarget);
      btn.title = inTarget
        ? `Already in ${name} — press to remove it from there`
        : `${verb} ${name}`;
    }
  }

  // Per-entry playlist handle from the row's Polymer data, when exposed.
  const rowSetVideoId = (row) => {
    try { return (row && row.data && row.data.setVideoId) || null; } catch (e) { return null; }
  };

  async function addOneToPlaylist(listId, videoId) {
    const res = await api('browse/edit_playlist', {
      playlistId: listId,
      actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }],
    });
    if (res.status && res.status !== 'STATUS_SUCCEEDED') throw new Error(res.status);
    invalidateExclCache();
    archivePatch(listId, '', [videoId], []);
  }

  // Gray out the row of a removed/moved video. YouTube recycles the row
  // elements (the same DOM node later shows a different video), so the mark
  // records which video it belongs to and sweepRemovedMarks() clears it the
  // moment the row's content changes.
  function markRowDone(videoId) {
    const row = findRowForVideo(videoId)
      || document.querySelector('ytd-playlist-panel-video-renderer[selected]');
    if (row) {
      row.classList.add('ycfp-removed');
      row.dataset.ycfpRemovedId = videoId;
    }
  }

  function rowVideoId(row) {
    const a = row.querySelector('a[href*="v="]');
    if (!a) return null;
    try {
      return new URLSearchParams(new URL(a.href, location.origin).search).get('v');
    } catch (e) {
      return null;
    }
  }

  function sweepRemovedMarks() {
    for (const row of document.querySelectorAll('.ycfp-removed')) {
      if (rowVideoId(row) !== row.dataset.ycfpRemovedId) {
        row.classList.remove('ycfp-removed');
        delete row.dataset.ycfpRemovedId;
      }
    }
  }

  // canEdit=false (playlists you don't own): no ✕ button, and the letter
  // buttons only ADD to their target — nothing is removed from the playing
  // playlist.
  function showQuickActionError(message) {
    let notice = document.getElementById('ycfp-action-error');
    if (!notice) {
      notice = el('div', { id: 'ycfp-action-error', role: 'alert', style: 'position:fixed;bottom:24px;left:24px;z-index:2147483647;max-width:min(520px,85vw);padding:14px;background:#461c1c;color:#fff;border:1px solid #e88;border-radius:8px;font:14px/1.5 sans-serif;box-shadow:0 4px 20px #0008' });
      document.body.append(notice);
    }
    const close = el('button', { type: 'button', 'aria-label': 'Dismiss error', style: 'float:right;margin-left:12px;cursor:pointer', onclick: () => notice.remove() }, '×');
    notice.replaceChildren(close, el('span', {}, message));
  }

  function buildQuickStrip(listId, videoId, mini = false, setVideoId = null, canEdit = true) {
    const cfg = loadCfg();
    const strip = mini
      ? el('div', { class: 'ycfp-qa ycfp-qa-mini' })
      : el('div', { id: 'ycfp-qa', class: 'ycfp-qa' });

    const moveBtns = [];
    const applyNow = () => applyMembership(videoId, moveBtns);

    const mkBtn = (label, title, fn) => {
      const b = el('button', { class: 'ycfp-qa-btn', title }, label);
      // Rows in the playlist panel are one big link — keep clicks to ourselves.
      for (const evName of ['mousedown', 'pointerdown', 'touchstart']) {
        b.addEventListener(evName, (ev) => ev.stopPropagation());
      }
      b.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (b.disabled) return;
        b.disabled = true;
        const orig = b.textContent;
        b.textContent = '…';
        try {
          const changed = await fn();
          b.textContent = '✓';
          if (changed !== false) markRowDone(videoId);
          applyNow(); // refresh highlights (e.g. this target now has the song)
        } catch (e) {
          console.warn('[YCFP] quick action failed:', e);
          b.textContent = '✗';
          b.title = `${title} — failed: ${e.message || e}`;
          showQuickActionError(`${title}: ${e.message || e}`);
        }
        setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1500);
      });
      return b;
    };

    const rowTitle = () => {
      const row = listId ? findRowForVideo(videoId) : null;
      const t = (row && row.querySelector('#video-title') && row.querySelector('#video-title').textContent)
        || document.title.replace(/ - YouTube$/, '');
      return (t || '').trim();
    };
    const playingTitle = () => {
      const h = document.querySelector('ytd-playlist-panel-renderer h3 a, ytd-playlist-panel-renderer .title');
      return ((h && h.textContent) || listId || '').trim();
    };
    const journalQuick = (playlistId, playlistTitle, src = 'quick', to = null) =>
      journalRemovals([{ id: videoId, title: rowTitle(), playlistId, playlistTitle }], src, to);

    if (canEdit) {
      const x = mkBtn('✕', 'Remove from this playlist', async () => {
        await removeFromPlaylist(listId, videoId, setVideoId);
        journalQuick(listId, playingTitle());
      });
      x.classList.add('ycfp-qa-x');
      strip.append(x);
    }

    // With the music-library rating strip on, the old letter buttons are
    // hidden unless asked for (🗂 dialog).
    const oldButtons = cfg.libraryStrip === false || cfg.libraryOldButtons !== false;
    for (const a of oldButtons ? cfg.quickActions : []) {
      const target = parsePlaylistId(a.target);
      if (!target || !a.label) continue;
      const name = a.name || target;
      const verb = canEdit ? 'Move to' : 'Add to';
      const btn = mkBtn(
        String(a.label).slice(0, 2),
        `${verb} ${name}`,
        async () => {
          // Toggle: a green button (song already in target) removes it from
          // that playlist instead.
          if (await isVideoInPlaylist(videoId, target)) {
            await removeFromPlaylist(target, videoId, target === listId ? setVideoId : null);
            await setMembership(videoId, target, false);
            journalQuick(target, name);
            return target === listId; // gray the row only if that was the playing playlist
          }
          try { await addOneToPlaylist(target, videoId); }
          catch (e) { throw new Error(`Could not add to ${name}. The source was not removed. ${e.message || e}`); }
          await setMembership(videoId, target, true);
          // Copy-only on playlists we can't edit: never remove from current.
          if (!canEdit) return false;
          try { await removeFromPlaylist(listId, videoId, setVideoId); }
          catch (e) {
            throw new Error(`Added to ${name}, but could not remove from the source playlist. The video is in both playlists. ${e.message || e}`);
          }
          // 'move', not 'quick': the video was kept, just relocated.
          journalQuick(listId, playingTitle(), 'move', { id: target, title: name });
          return true;
        });
      moveBtns.push({ btn, target, name, verb });
      strip.append(btn);
    }

    if (cfg.libraryStrip !== false && typeof buildRatingStrip === 'function') {
      strip.append(buildRatingStrip(videoId, { listId, setVideoId, canEdit }, mini));
    }

    // Main panel strip only: ▤ toggles the buttons on every row of the panel.
    if (!mini && listId) {
      const toggle = el('button', {
        class: 'ycfp-qa-btn ycfp-qa-toggle' + (cfg.qaAllRows ? ' ycfp-on' : ''),
        title: 'Show these buttons on every video in the playlist panel',
      }, '▤');
      for (const evName of ['mousedown', 'pointerdown', 'touchstart']) {
        toggle.addEventListener(evName, (ev) => ev.stopPropagation());
      }
      toggle.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const stored = loadCfg();
        stored.qaAllRows = !stored.qaAllRows;
        saveCfg(stored);
        toggle.classList.toggle('ycfp-on', stored.qaAllRows);
        if (stored.qaAllRows) ensureAllRowStrips(listId, canEdit);
        else document.querySelectorAll('ytd-playlist-panel-renderer .ycfp-qa-mini').forEach((e) => e.remove());
      });
      strip.append(toggle);
    }

    // Membership highlighting: immediately for the main strip; lazily on
    // first hover for the (many) mini strips — one request per video, cached.
    if (!mini) applyNow();
    else strip.addEventListener('mouseenter', applyNow, { once: true });

    return strip;
  }

  const hasQuickActions = () => {
    const cfg = loadCfg();
    return cfg.libraryStrip !== false || cfg.quickActions.some((a) => a.label && parsePlaylistId(a.target));
  };

  // Mini strips on every row of the playlist panel (▤ mode). Recycled rows
  // are detected via the video id recorded on each strip.
  function ensureAllRowStrips(listId, canEdit) {
    if (!canEdit && !hasQuickActions()) return; // nothing useful to show
    const panel = document.querySelector('#secondary ytd-playlist-panel-renderer, ytd-playlist-panel-renderer');
    if (!panel) return;
    for (const row of panel.querySelectorAll('ytd-playlist-panel-video-renderer')) {
      const vid = rowVideoId(row);
      const existing = row.querySelector('.ycfp-qa-mini');
      if (!vid) { if (existing) existing.remove(); continue; }
      if (existing) {
        if (existing.dataset.vid === vid) continue;
        existing.remove();
      }
      if (row.querySelector('#ycfp-qa')) continue; // playing row has the main strip
      const strip = buildQuickStrip(listId, vid, true, rowSetVideoId(row), canEdit);
      strip.dataset.vid = vid;
      row.style.position = 'relative';
      row.append(strip);
    }
  }

  let qaBusy = false;

  // The playing row, located by the video ID in its link — the [selected]
  // attribute lags behind navigation, so it's only the fallback. Also finds
  // rows on the /playlist page view.
  function findRowForVideo(videoId) {
    if (/^[A-Za-z0-9_-]{6,}$/.test(videoId)) {
      for (const a of document.querySelectorAll(
        `ytd-playlist-panel-renderer a[href*="v=${videoId}"], `
        + `ytd-playlist-video-list-renderer a[href*="v=${videoId}"]`)) {
        const row = a.closest('ytd-playlist-panel-video-renderer, ytd-playlist-video-renderer');
        if (row) return row;
      }
    }
    return document.querySelector('ytd-playlist-panel-video-renderer[selected]');
  }

  // Quick-action strips on every row of the /playlist page view — same
  // buttons as the watch-page panel: ✕ removes from this playlist, letter
  // buttons move (or copy, on playlists you can't edit) to their targets.
  const plEditableReq = new Set(); // listIds with an editability check in flight

  function ensurePlaylistPageStrips() {
    const listId = location.pathname === '/playlist'
      ? new URLSearchParams(location.search).get('list') : null;
    if (!listId) {
      const stale = document.querySelectorAll('.ycfp-qa-pl');
      if (stale.length) stale.forEach((e) => e.remove());
      return;
    }
    if (!editableCache.has(listId)) {
      // Kick off the (cached) editability check; strips appear next tick.
      const sample = document.querySelector('ytd-playlist-video-renderer');
      const vid = sample && rowVideoId(sample);
      if (vid && !plEditableReq.has(listId)) {
        plEditableReq.add(listId);
        isPlaylistEditable(listId, vid).finally(() => plEditableReq.delete(listId));
      }
      return;
    }
    const canEdit = editableCache.get(listId) === true;
    if (!canEdit && !hasQuickActions()) return; // nothing useful to show
    for (const row of document.querySelectorAll('ytd-playlist-video-renderer')) {
      const vid = rowVideoId(row);
      const existing = row.querySelector('.ycfp-qa-pl');
      if (!vid) { if (existing) existing.remove(); continue; }
      if (existing) {
        if (existing.dataset.vid === vid) continue; // row unchanged
        existing.remove(); // recycled row: rebuild for the new video
      }
      const strip = buildQuickStrip(listId, vid, true, rowSetVideoId(row), canEdit);
      strip.classList.add('ycfp-qa-pl');
      strip.dataset.vid = vid;
      row.style.position = 'relative';
      row.append(strip);
    }
  }

  // YouTube re-centres the side playlist on the playing row every time the
  // video changes (the panel controller's scrollToCurrentVideo, which sets
  // #items.scrollTop). That method is swapped for a no-op — on the shared
  // controller prototype, so one patch covers every later panel — and the ◎
  // button in the panel's action bar scrolls on demand instead.
  const noAutoScroll = () => {};

  function blockPanelAutoScroll() {
    let patched = false;
    for (const panel of document.querySelectorAll('ytd-playlist-panel-renderer')) {
      for (let o = panel.polymerController || panel;
        o && o !== HTMLElement.prototype && o !== Object.prototype;
        o = Object.getPrototypeOf(o)) {
        if (!Object.prototype.hasOwnProperty.call(o, 'scrollToCurrentVideo')) continue;
        if (o.scrollToCurrentVideo !== noAutoScroll) {
          try { o.scrollToCurrentVideo = noAutoScroll; } catch (e) { continue; }
        }
        patched = true;
      }
    }
    return patched;
  }

  // Poll briefly after load / navigation so the patch lands before the new
  // panel's first auto-scroll, not 2s later on the ensure interval.
  let autoScrollPoll = null;
  function watchPanelAutoScroll() {
    if (autoScrollPoll) return;
    let n = 0;
    autoScrollPoll = setInterval(() => {
      if (blockPanelAutoScroll() || ++n > 100) {
        clearInterval(autoScrollPoll);
        autoScrollPoll = null;
      }
    }, 100);
  }

  function scrollPanelToPlaying(panel) {
    const items = panel.querySelector('#items');
    if (!items) return;
    const videoId = new URLSearchParams(location.search).get('v');
    let row = null;
    if (videoId && /^[A-Za-z0-9_-]{6,}$/.test(videoId)) {
      const a = items.querySelector(`a[href*="v=${videoId}"]`);
      row = a && a.closest('ytd-playlist-panel-video-renderer');
    }
    row = row || items.querySelector('ytd-playlist-panel-video-renderer[selected]');
    if (!row) return;
    const r = row.getBoundingClientRect();
    const box = items.getBoundingClientRect();
    const delta = (r.top - box.top) - (items.clientHeight - r.height) / 2;
    items.scrollTo({
      top: items.scrollTop + delta,
      // Smooth only for short hops — across a 200-song list it crawls.
      behavior: Math.abs(delta) < 1500 ? 'smooth' : 'auto',
    });
  }

  function ensurePanelJumpButton() {
    for (const panel of document.querySelectorAll('ytd-playlist-panel-renderer')) {
      const host = panel.querySelector('#playlist-actions #end-actions');
      if (!host || host.querySelector('.ycfp-jump')) continue;
      const b = el('button', {
        class: 'ycfp-qa-btn ycfp-jump',
        title: 'Scroll the playlist to the playing video',
      }, '◎');
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        scrollPanelToPlaying(panel);
      });
      host.prepend(b);
    }
    for (const panel of document.querySelectorAll('ytd-playlist-panel-renderer')) {
      const jump = panel.querySelector('#playlist-actions #end-actions .ycfp-jump:not(.ycfp-bulk-btn)');
      if (!jump || jump.parentNode.querySelector('.ycfp-bulk-btn')) continue;
      const b = el('button', {
        class: 'ycfp-qa-btn ycfp-jump ycfp-bulk-btn',
        title: 'Select several videos, then move or remove them together',
      }, '☑');
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (bulk && bulk.panel === panel) exitBulk();
        else enterBulk(panel, 'panel');
      });
      jump.before(b);
    }
  }

  // ------------------------------------------------------------------
  // Bulk select (☑ in the panel's action row): clicking rows ticks them
  // instead of playing them (shift-click ticks a range), and a bar above the
  // list moves / copies / removes the ticked videos in one go. Selection is
  // keyed by video id, because YouTube recycles the row elements.
  // ------------------------------------------------------------------
  // Two hosts: the watch page's side panel (kind 'panel') and the list on a
  // /playlist page (kind 'page', ☑ in the floating buttons).
  let bulk = null; // { panel, kind, rowSel, listId, canEdit, sel: Map(vid -> {setVideoId, title}), last, bar, ... }

  // /playlist rows come in two layouts: ytd-playlist-video-renderer and the
  // newer yt-lockup-view-model (both live under the page's #primary column).
  const BULK_ROW = {
    panel: 'ytd-playlist-panel-video-renderer',
    page: 'ytd-playlist-video-renderer, yt-lockup-view-model',
  };
  const panelRows = (panel, kind = 'panel') => [...panel.querySelectorAll(
    kind === 'page' ? BULK_ROW.page : '#items ' + BULK_ROW.panel)];
  const bulkRows = (state) => panelRows(state.panel, state.kind);
  const bulkPageList = () => document.querySelector('ytd-browse:not([hidden]) #primary');
  const bulkListId = (kind) => (location.pathname === (kind === 'page' ? '/playlist' : '/watch')
    ? new URLSearchParams(location.search).get('list') : null);

  function toggleBulkPage() {
    if (bulk && bulk.kind === 'page') { exitBulk(); return; }
    const list = bulkPageList();
    if (list) enterBulk(list, 'page');
  }
  const rowTitleText = (row) => {
    const t = row.querySelector('#video-title');
    return ((t && t.textContent) || '').trim();
  };

  function bulkToggleRow(row, on) {
    const vid = rowVideoId(row);
    if (!vid) return;
    if (on === undefined) on = !bulk.sel.has(vid);
    if (on) bulk.sel.set(vid, { setVideoId: rowSetVideoId(row), title: rowTitleText(row) });
    else bulk.sel.delete(vid);
  }

  function bulkOnClick(ev) {
    if (!bulk || bulk.busy) return;
    const row = ev.target.closest(bulk.rowSel);
    if (!row || ev.target.closest('.ycfp-qa')) return; // let our own buttons work
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    const rows = bulkRows(bulk);
    const vid = rowVideoId(row);
    if (ev.shiftKey && bulk.last) {
      const ids = rows.map(rowVideoId);
      const a = ids.indexOf(bulk.last);
      const b = ids.indexOf(vid);
      if (a >= 0 && b >= 0) {
        const on = !bulk.sel.has(vid) || bulk.sel.has(bulk.last);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) bulkToggleRow(rows[i], on);
      } else bulkToggleRow(row);
    } else bulkToggleRow(row);
    bulk.last = vid;
    refreshBulk();
  }

  // Swallow the press too — YouTube starts some navigation on pointer events.
  function bulkSwallow(ev) {
    if (!bulk) return;
    const row = ev.target.closest(bulk.rowSel);
    if (row && !ev.target.closest('.ycfp-qa')) ev.stopPropagation();
  }

  function refreshBulk() {
    if (!bulk) return;
    for (const row of bulkRows(bulk)) {
      row.classList.add('ycfp-bulk-row');
      row.style.position = 'relative';
      row.classList.toggle('ycfp-sel', bulk.sel.has(rowVideoId(row)));
    }
    const n = bulk.sel.size;
    bulk.count.textContent = `${n} selected`;
    const off = bulk.busy || !n;
    bulk.moveBtn.disabled = off || !bulk.target.value;
    bulk.removeBtn.disabled = off || !bulk.canEdit;
    bulk.moveBtn.textContent = bulk.canEdit ? 'Move' : 'Copy';
  }

  // Keep the mode in step with the page: leave it when the panel goes away
  // or a different playlist starts; re-tag rows YouTube has just loaded.
  function ensureBulk() {
    if (!bulk) return;
    const listId = bulkListId(bulk.kind);
    if (!bulk.panel.isConnected || listId !== bulk.listId
      || (bulk.kind === 'page' && bulkPageList() !== bulk.panel)) { exitBulk(); return; }
    if (!bulk.bar.isConnected) mountBulkBar();
    refreshBulk();
  }

  function mountBulkBar() {
    const first = bulk.kind === 'page' && bulk.panel.querySelector(bulk.rowSel);
    const items = bulk.kind === 'page' ? first && first.closest('#contents') : bulk.panel.querySelector('#items');
    if (items) items.before(bulk.bar);
    else bulk.panel.prepend(bulk.bar);
  }

  async function enterBulk(panel, kind) {
    if (bulk) exitBulk();
    const listId = bulkListId(kind);
    if (!listId) return;
    const cfg = loadCfg();
    const mk = (label, title, fn, cls = '') => {
      const b = el('button', { class: 'ycfp-qa-btn ' + cls, title }, label);
      b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(); });
      return b;
    };
    const target = el('select', { class: 'ycfp-bulk-target', title: 'Playlist to move the selected videos to' });
    target.append(el('option', { value: '' }, 'Move to…'));
    const quick = el('optgroup', { label: 'Quick actions' });
    for (const a of cfg.quickActions) {
      const pid = parsePlaylistId(a.target);
      if (pid && pid !== listId) {
        quick.append(el('option', { value: pid, 'data-name': a.name || playlistTitleOf(pid) }, `${a.label} — ${a.name || pid}`));
      }
    }
    if (quick.children.length) target.append(quick);
    const mine = el('optgroup', { label: 'Your playlists (loading…)' });
    target.append(mine);
    target.append(el('option', { value: '__other' }, 'Other — paste a URL or ID…'));

    const state = {
      panel, kind, rowSel: BULK_ROW[kind], listId, canEdit: editableCache.get(listId) === true,
      sel: new Map(), last: null, busy: false, target,
    };
    bulk = state;
    state.count = el('span', { class: 'ycfp-bulk-count' }, '0 selected');
    state.status = el('span', { class: 'ycfp-bulk-status' });
    state.moveBtn = mk('Move', 'Move the selected videos to the chosen playlist', () => bulkMove());
    state.removeBtn = mk('✕', 'Remove the selected videos from this playlist', () => bulkRemove(), 'ycfp-qa-x');
    state.bar = el('div', { class: 'ycfp-bulk-bar' + (kind === 'page' ? ' ycfp-bulk-page' : '') },
      state.count,
      mk('All', 'Select every loaded video', () => {
        bulkRows(state).forEach((r) => bulkToggleRow(r, true)); refreshBulk();
      }, 'ycfp-qa-toggle'),
      mk('None', 'Clear the selection', () => { state.sel.clear(); refreshBulk(); }, 'ycfp-qa-toggle'),
      target, state.moveBtn, state.removeBtn,
      mk('Done', 'Leave select mode', () => exitBulk(), 'ycfp-qa-toggle'),
      state.status);
    for (const evName of ['mousedown', 'pointerdown', 'touchstart', 'click']) {
      state.bar.addEventListener(evName, (ev) => ev.stopPropagation());
    }
    target.addEventListener('change', () => {
      if (target.value === '__other') {
        const pid = parsePlaylistId(prompt('Playlist URL or ID to move the selected videos to:') || '');
        if (pid && pid !== listId) {
          const o = el('option', { value: pid }, playlistTitleOf(pid));
          target.insertBefore(o, target.lastElementChild);
          target.value = pid;
        } else target.value = '';
      }
      refreshBulk();
    });
    mountBulkBar();
    panel.addEventListener('click', bulkOnClick, true);
    for (const evName of ['mousedown', 'pointerdown', 'touchstart']) {
      panel.addEventListener(evName, bulkSwallow, true);
    }
    const btn = kind === 'page' ? document.querySelector('#ycfp-float .ycfp-float-bulk')
      : panel.querySelector('.ycfp-bulk-btn');
    if (btn) btn.classList.add('ycfp-on');
    refreshBulk();

    // Editability and the list of your playlists, both from cached lookups.
    const sample = bulkRows(state).map(rowVideoId).find(Boolean);
    state.canEdit = await isPlaylistEditable(listId, sample);
    if (bulk !== state) return;
    refreshBulk();
    if (sample) {
      const map = await getMembership(sample);
      if (bulk !== state) return;
      const quickIds = new Set([...quick.querySelectorAll('option')].map((o) => o.value));
      const ids = [...map.keys()].filter((p) => p !== listId && !quickIds.has(p));
      ids.sort((a, b) => playlistTitleOf(a).localeCompare(playlistTitleOf(b)));
      for (const p of ids) mine.append(el('option', { value: p }, playlistTitleOf(p)));
    }
    mine.label = 'Your playlists';
    if (!mine.children.length) mine.remove();
  }

  function exitBulk() {
    if (!bulk) return;
    const { panel, bar } = bulk;
    panel.removeEventListener('click', bulkOnClick, true);
    for (const evName of ['mousedown', 'pointerdown', 'touchstart']) {
      panel.removeEventListener(evName, bulkSwallow, true);
    }
    bar.remove();
    for (const row of panel.querySelectorAll('.ycfp-bulk-row')) row.classList.remove('ycfp-bulk-row', 'ycfp-sel');
    document.querySelectorAll('.ycfp-bulk-btn.ycfp-on, .ycfp-float-bulk.ycfp-on')
      .forEach((b) => b.classList.remove('ycfp-on'));
    bulk = null;
  }

  // Remove entries in batches: by per-entry handle when known (that copy
  // only), else by video id.
  async function removeManyFromPlaylist(listId, entries, cfg, log) {
    for (let i = 0; i < entries.length; i += cfg.batchSize) {
      const chunk = entries.slice(i, i + cfg.batchSize);
      const res = await api('browse/edit_playlist', {
        playlistId: listId,
        actions: chunk.map((e) => (e.setVideoId
          ? { action: 'ACTION_REMOVE_VIDEO', setVideoId: e.setVideoId }
          : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: e.id })),
      });
      if (res.status && res.status !== 'STATUS_SUCCEEDED') {
        throw new Error(`remove batch returned ${res.status} — ${i} of ${entries.length} were removed before the failure.`);
      }
      archivePatch(listId, '', [], chunk.map((e) => e.id));
      log(`Removed ${Math.min(i + chunk.length, entries.length)}/${entries.length}…`);
      await sleep(cfg.batchDelayMs);
    }
    invalidateExclCache();
  }

  const playingPanelTitle = () => {
    const h = document.querySelector('ytd-playlist-panel-renderer h3 a, ytd-playlist-panel-renderer .title');
    return ((h && h.textContent) || '').trim();
  };

  async function bulkRun(fn) {
    const state = bulk;
    state.busy = true;
    refreshBulk();
    const log = (m) => { state.status.textContent = m; };
    try {
      await fn(state, log);
    } catch (e) {
      console.warn('[YCFP] bulk action failed:', e);
      log(`Failed: ${e.message || e}`);
    } finally {
      state.busy = false;
      if (bulk === state) refreshBulk();
    }
  }

  const bulkEntries = (state) => [...state.sel].map(([id, v]) => ({
    id, setVideoId: v.setVideoId, title: v.title, playlistId: state.listId,
    playlistTitle: state.kind === 'page' ? document.title.replace(/ - YouTube$/, '') : playingPanelTitle(),
  }));

  function bulkFinish(state, entries, log, msg) {
    for (const e of entries) {
      membershipCache.delete(e.id);
      const row = bulkRows(state).find((r) => rowVideoId(r) === e.id);
      if (row) { row.classList.add('ycfp-removed'); row.dataset.ycfpRemovedId = e.id; }
    }
    state.sel.clear();
    log(msg);
  }

  function bulkMove() {
    return bulkRun(async (state, log) => {
      const target = state.target.value;
      if (!target) return;
      const opt = state.target.selectedOptions[0];
      const name = (opt && opt.dataset.name) || playlistTitleOf(target);
      const cfg = loadCfg();
      const entries = bulkEntries(state);
      // Don't add a second copy of songs the target already holds.
      let have = new Set();
      try {
        log(`Reading ${name}…`);
        have = new Set((await fetchPlaylistVideos(target, name, () => {}, null)).map((v) => v.id));
      } catch (e) { /* unknown — add them all */ }
      const toAdd = [...new Set(entries.map((e) => e.id))].filter((id) => !have.has(id));
      if (toAdd.length) await addToPlaylist(target, toAdd, cfg, log);
      if (!state.canEdit) {
        bulkFinish(state, [], log, `Copied ${toAdd.length} to ${name}`
          + (entries.length > toAdd.length ? ` (${entries.length - toAdd.length} already there)` : '') + '.');
        return;
      }
      await removeManyFromPlaylist(state.listId, entries, cfg, log);
      journalRemovals(entries, 'move', { id: target, title: name });
      bulkFinish(state, entries, log, `Moved ${entries.length} to ${name}`
        + (entries.length > toAdd.length ? ` (${entries.length - toAdd.length} were already there)` : '') + '.');
    });
  }

  function bulkRemove() {
    if (!bulk || !bulk.canEdit || !bulk.sel.size) return;
    if (!confirm(`Remove ${bulk.sel.size} video(s) from this playlist?`)) return;
    return bulkRun(async (state, log) => {
      const entries = bulkEntries(state);
      await removeManyFromPlaylist(state.listId, entries, loadCfg(), log);
      journalRemovals(entries, 'quick');
      bulkFinish(state, entries, log, `Removed ${entries.length}.`);
    });
  }

  function ensureQuickActions() {
    blockPanelAutoScroll();
    ensurePanelJumpButton();
    ensureBulk();
    sweepRemovedMarks();
    ensurePlaylistPageStrips(); // row strips on the /playlist page view
    const params = new URLSearchParams(location.search);
    const onWatch = location.pathname === '/watch';
    const listId = onWatch ? params.get('list') : null;
    const videoId = onWatch ? params.get('v') : null;
    const existing = document.getElementById('ycfp-qa');

    // Watch-panel mini strips only — .ycfp-qa-pl strips on the /playlist
    // page have their own lifecycle in ensurePlaylistPageStrips().
    const panelMinis = () =>
      document.querySelectorAll('ytd-playlist-panel-renderer .ycfp-qa-mini');

    if (!videoId) {
      if (existing) existing.remove();
      const minis = panelMinis();
      if (minis.length) minis.forEach((e) => e.remove());
      return;
    }

    // Solo watch page (no playlist): show the letter buttons above the video
    // title — add/toggle into their target playlists only (no ✕, nothing to
    // remove from).
    if (!listId) {
      panelMinis().forEach((e) => e.remove());
      if (!hasQuickActions()) { if (existing) existing.remove(); return; }
      const key = `solo|${videoId}`;
      if (existing && existing.isConnected && existing.dataset.key === key) return;
      if (existing) existing.remove();
      const host = document.querySelector('ytd-watch-metadata #title')
        || document.querySelector('#above-the-fold #title');
      if (!host) return;
      const strip = buildQuickStrip(null, videoId, false, null, false);
      strip.dataset.key = key;
      strip.classList.add('ycfp-qa-solo');
      host.prepend(strip);
      return;
    }

    // ▤ mode: keep mini strips on all rows (cheap per-row checks each tick).
    // Works on foreign playlists too — canEdit=false makes them copy-only.
    const wantMinis = editableCache.has(listId) && loadCfg().qaAllRows;
    if (wantMinis) {
      ensureAllRowStrips(listId, editableCache.get(listId) === true);
    } else if (panelMinis().length) {
      panelMinis().forEach((e) => e.remove());
    }

    const key = `${listId}|${videoId}`;
    const stripIsCurrent = (strip, row) =>
      strip && strip.isConnected && strip.dataset.key === key
      && (!row || row.contains(strip)); // must sit on the *current* row
    if (stripIsCurrent(existing, findRowForVideo(videoId))) return;
    if (qaBusy) return;
    qaBusy = true;

    (async () => {
      try {
        // Foreign playlists still get a strip, but in copy-only mode (no ✕,
        // moves only add to the target). Skip entirely if there'd be no
        // buttons to show.
        const canEdit = await isPlaylistEditable(listId, videoId);
        if (!canEdit && !hasQuickActions()) {
          const cur = document.getElementById('ycfp-qa');
          if (cur) cur.remove();
          return;
        }
        // Re-check after the await — the DOM may have moved on.
        const cur = document.getElementById('ycfp-qa');
        const curRow = findRowForVideo(videoId);
        if (stripIsCurrent(cur, curRow)) return;
        if (cur) cur.remove();

        // Attach to the currently-playing row of the side playlist panel;
        // fall back to the panel itself if the row isn't found.
        const panel = document.querySelector('#secondary ytd-playlist-panel-renderer, ytd-playlist-panel-renderer');
        const host = curRow || panel;
        if (!host) return;
        const strip = buildQuickStrip(listId, videoId, false, rowSetVideoId(curRow), canEdit);
        strip.dataset.key = key;
        if (curRow) {
          const mini = curRow.querySelector('.ycfp-qa-mini');
          if (mini) mini.remove(); // main strip replaces the row's mini strip
          curRow.style.position = 'relative';
        } else {
          strip.classList.add('ycfp-qa-header');
        }
        host.append(strip);
      } finally {
        qaBusy = false;
      }
    })();
  }

  // ------------------------------------------------------------------
  // Collection logic
  // ------------------------------------------------------------------

  // Drop Shorts from a channel's upload list: filter both by the isShort tag
  // (new-UI data) and by membership in the channel's UUSH… shorts playlist.
  async function stripShorts(videos, channelId, label, log, guard) {
    let shortsIds = new Set();
    try {
      const shorts = await fetchPlaylistVideos(
        'UUSH' + channelId.slice(2), `${label}: shorts`, log, guard, { quiet: true });
      shortsIds = new Set(shorts.map((v) => v.id));
    } catch (e) { /* channel has no shorts playlist */ }
    const before = videos.length;
    const out = videos.filter((v) => !v.isShort && !shortsIds.has(v.id));
    if (out.length !== before) log(`${label}: excluded ${before - out.length} Shorts.`);
    return out;
  }

  // Drop live streams: the channel's auto-generated UULV… streams playlist,
  // plus any entry the data itself marks as live (see liveStatus).
  async function stripLive(videos, channelId, label, log, guard) {
    let liveIds = new Set();
    try {
      const lives = await fetchPlaylistVideos(
        'UULV' + channelId.slice(2), `${label}: streams`, log, guard, { quiet: true });
      liveIds = new Set(lives.map((v) => v.id));
      log(`${label}: streams playlist lists ${liveIds.size} videos.`);
    } catch (e) {
      log(`${label}: ⚠ streams playlist unavailable — filtering by LIVE badge only.`);
    }
    let byBadge = 0, byList = 0;
    const out = videos.filter((v) => {
      if (v.isLive) { byBadge++; return false; }
      if (liveIds.has(v.id)) { byList++; return false; }
      return true;
    });
    if (byBadge || byList) {
      log(`${label}: excluded ${byBadge + byList} live streams (${byBadge} by badge, ${byList} via the streams playlist).`);
    }
    return out;
  }

  // Drop what hasn't aired yet — scheduled streams, premieres, countdown
  // placeholders — and anything with no playable duration at all (private,
  // deleted or members-only placeholders come through the uploads playlist
  // the same way). Deliberately independent of "skip live streams": a
  // scheduled item is not a stream you can watch, it is an empty row, and
  // the UULV… streams playlist never lists it, so stripLive can't see it.
  function stripUpcoming(videos, label, log) {
    let sched = 0, noDur = 0;
    const out = videos.filter((v) => {
      if (v.isUpcoming) { sched++; return false; }
      // Zero duration on a non-Short means YouTube gave us no length: live
      // now, not yet released, or unavailable. Shorts legitimately have no
      // duration badge in the grid UI and are kept.
      if (!(v.seconds > 0) && !v.isShort) { noDur++; return false; }
      return true;
    });
    if (sched || noDur) {
      log(`${label}: excluded ${sched + noDur} not-yet-released videos`
        + ` (${sched} scheduled / premiere${noDur ? `, ${noDur} with no duration — live now, private or deleted` : ''}).`);
    }
    return out;
  }

  // Every song on a channel's album / single playlists (OLAK5uy…), read
  // from its Releases tab (or Home, which is all a Topic channel has).
  // Some "- Topic" channels have NO uploads playlist at all ("The playlist
  // does not exist") — their songs exist only as releases. That is why
  // e.g. CALLISTER pulled nothing: the main channel's uploads are all
  // Shorts and the Topic's UU… list 404'd, so the companion was dropped.
  async function fetchReleaseVideos(channelId, label, log, guard, opts = {}) {
    const home = await api('browse', { browseId: channelId });
    const pages = [home];
    const relTab = deepCollect(home, 'tabRenderer').find((t) => {
      const url = t && t.endpoint && deepFind(t.endpoint, 'url');
      return typeof url === 'string' && /\/releases$/.test(url);
    });
    const relParams = relTab && deepFind(relTab.endpoint, 'browseEndpoint');
    if (relParams && relParams.params) {
      let data = await api('browse', { browseId: channelId, params: relParams.params });
      const used = new Set();
      for (let i = 0; data && i < 20; i++) {
        pages.push(data);
        if (opts.noContinue) break;
        const tok = deepCollect(data, 'continuationCommand').map((c) => c && c.token)
          .find((t) => t && !used.has(t));
        if (!tok) break;
        used.add(tok);
        if (guard) guard();
        data = await api('browse', { continuation: tok });
      }
    }
    const albums = [...new Set(pages.flatMap((p) => JSON.stringify(p).match(/OLAK5uy_[\w-]{33}/g) || []))];
    const out = [];
    const seen = new Set();
    for (const pl of (opts.noContinue ? albums.slice(0, 3) : albums)) {
      if (guard) guard();
      try {
        const vids = await fetchPlaylistVideos(pl, `${label}: release`, log, guard, { quiet: true });
        for (const v of vids) if (!seen.has(v.id)) { seen.add(v.id); out.push(v); }
      } catch (e) {
        if (guard) guard();
      }
    }
    if (!opts.quiet) log(`${label}: no uploads (or only Shorts) — read ${albums.length} release(s) instead, ${out.length} song(s).`);
    return out;
  }

  // The uploads playlist, or — when the channel has none (or it is empty) —
  // its releases.
  async function fetchUploadsOrReleases(channelId, label, log, guard, opts = {}) {
    let vids = null;
    try {
      vids = await fetchPlaylistVideos('UU' + channelId.slice(2), label, log, guard, opts);
    } catch (e) {
      if (guard) guard();
    }
    if (vids && vids.length) return vids;
    const rel = await fetchReleaseVideos(channelId, label, log, guard, opts);
    if (!rel.length && !vids) throw new Error('no uploads playlist and no releases');
    rel.fromReleases = true;
    return rel;
  }

  // All uploads of one channel + its companion (Topic ↔ main) channel.
  // The channel's own uploads, with Shorts/live stripped per config.
  async function fetchMainUploads(channelId, cfg, log, guard) {
    const channelTitle = await getChannelTitle(channelId);
    log(`Channel: ${channelTitle}`);

    let main = await fetchUploadsOrReleases(channelId, `${channelTitle}: uploads`, log, guard);
    log(`${channelTitle}: ${main.length} uploads.`);
    // The newest ids as the uploads feed itself lists them, before any
    // Shorts/live filtering — that is exactly the shape of a "New Songs"
    // baseline (see nsBaselineNow, nsMarkerIds), and costs nothing extra.
    const rawTop = nsMarkerIds(main);
    if (cfg.excludeShorts) main = await stripShorts(main, channelId, channelTitle, log, guard);
    if (cfg.excludeLive) main = await stripLive(main, channelId, channelTitle, log, guard);
    if (cfg.excludeUpcoming) main = stripUpcoming(main, channelTitle, log);
    // Nothing left (e.g. CALLISTER: every upload is a Short, the songs sit
    // on the Topic channel) — its Releases tab lists those albums too, so
    // the songs come in even when the Topic counterpart isn't found.
    if (!main.length && !main.fromReleases) {
      try {
        main = await fetchReleaseVideos(channelId, `${channelTitle}: releases`, log, guard);
        if (cfg.excludeUpcoming) main = stripUpcoming(main, channelTitle, log);
      } catch (e) {
        if (guard) guard();
      }
    }
    return { channelTitle, main, rawTop };
  }

  // Locate the companion channel — from a normal channel its "- Topic"
  // channel, from a Topic channel the main one. Always returns
  // {id, name, label, candidates}; `id` is null when none was found and is
  // the best-scoring candidate otherwise. `candidates` holds every channel
  // with that exact name, so the review step can list them all when the name
  // is ambiguous. `main` is only used to score them against each other.
  async function resolveCompanion(channelId, channelTitle, main, cfg, log, guard) {
    const onTopic = TOPIC_SUFFIX.test(channelTitle);
    const name = onTopic ? channelTitle.replace(TOPIC_SUFFIX, '').trim() : `${channelTitle} - Topic`;
    const label = onTopic ? 'Main channel' : 'Topic channel';
    if (!cfg.includeTopicChannel) return { id: null, name, label, off: true, candidates: [] };
    log(`Searching for ${label.toLowerCase()} ("${name}")…`);
    const candidates = await findCompanionCandidates(name, channelId, onTopic, main, log, guard);
    if (!candidates.length) log(`No ${label.toLowerCase()} found.`);
    else if (candidates.length > 1) log(`${candidates.length} channels named "${name}" — choose below.`);
    return { id: candidates.length ? candidates[0].id : null, name, label, candidates };
  }

  // The companion channels the user ticked in the review step, as
  // {id, name, label} — several when an ambiguous name was resolved to more
  // than one real channel.
  function chosenCompanions(p) {
    if (!p || !p.companion) return [];
    if (p.companionChoices) return p.companionChoices.filter((c) => c.cb.checked).map((c) => c.entry);
    // No review block was built for this channel (Topic matching off).
    return p.companion.id ? [p.companion] : [];
  }

  // Uploads of every chosen companion, concatenated. One bad match must not
  // sink the others — fetchCompanionUploads already swallows its own errors.
  async function fetchChosenCompanions(p, cfg, log, guard, link, openTab = true) {
    let out = [];
    for (const c of chosenCompanions(p)) {
      out = out.concat(await fetchCompanionUploads(c, cfg, log, guard, link, openTab));
    }
    return out;
  }

  // The companion's uploads. A bad match (or a channel with no real uploads
  // playlist) can 404 here — that must never sink the run, so failures fall
  // back to an empty list and the main channel's uploads alone.
  async function fetchCompanionUploads(companion, cfg, log, guard, link, openTab = true) {
    if (!companion || !companion.id) return [];
    const { id, name, label } = companion;
    const url = `${ORIGIN}/channel/${id}`;
    if (openTab) window.open(url, '_blank'); // may be popup-blocked; link as fallback
    if (link) link(url, `${label}: ${name}`);
    try {
      let vids = await fetchUploadsOrReleases(id, `${label} uploads`, log, guard);
      log(`${label} uploads: ${vids.length} videos.`);
      companion.rawTop = nsMarkerIds(vids); // New Songs baseline
      if (cfg.excludeShorts) vids = await stripShorts(vids, id, name, log, guard);
      if (cfg.excludeLive) vids = await stripLive(vids, id, name, log, guard);
      if (cfg.excludeUpcoming) vids = stripUpcoming(vids, name, log);
      return vids;
    } catch (e) {
      if (guard) guard(); // re-throws if the user cancelled; otherwise swallow
      log(`⚠ ${label} ("${name}") couldn't be fetched (${e.message || e}) — using the main channel only.`);
      return [];
    }
  }

  // Exclusion sets from the configured playlists. Cached for the session
  // (15 min TTL) — several 5k exclusion lists cost ~50 requests each run
  // otherwise.
  let exclCache = null; // { key, time, data }

  // Any playlist write may change an exclusion playlist (quick-moves often
  // target them), so every mutation drops the cache. THIS is what previously
  // let just-moved songs slip past the exclusion check.
  function invalidateExclCache() { exclCache = null; }

  async function buildExclusionSets(cfg, log, guard) {
    const cacheKey = JSON.stringify(
      [[...cfg.excludePlaylists].sort(), !!cfg.dedupeByTitleDuration, !!cfg.fuzzyCollect]);
    if (exclCache && exclCache.key === cacheKey
      && Date.now() - exclCache.time < 15 * 60 * 1000) {
      log('Using exclusion lists cached earlier this session (auto-refreshes after 15 min).');
      // The ledger can have grown since the fetch was cached — it is cheap
      // and always rebuilt from localStorage.
      return Object.assign({}, exclCache.data, buildGoneSets(cfg));
    }
    const exclIds = new Set();
    const exclKeys = new Set();
    const exclFuzz = new Map();
    for (const entry of cfg.excludePlaylists) {
      const pid = parsePlaylistId(entry);
      if (!pid) { log(`⚠ Could not parse excluded playlist "${entry}".`); continue; }
      const vids = await fetchPlaylistVideos(pid, `Exclusion ${pid}`, log, guard);
      for (const v of vids) {
        exclIds.add(v.id);
        if (v.seconds > 0) {
          if (cfg.dedupeByTitleDuration) exclKeys.add(dupeKey(v));
          if (cfg.fuzzyCollect) fuzzBucketAdd(exclFuzz, v.seconds, titleVariants(v.title, v.channel));
        }
      }
      log(`Exclusion ${pid}: ${vids.length} videos.`);
    }
    const data = { exclIds, exclKeys, exclFuzz };
    exclCache = { key: cacheKey, time: Date.now(), data };
    return Object.assign({}, data, buildGoneSets(cfg));
  }

  async function applyExclusions(videos, excl, cfg, goneCfg = cfg) {
    const kept = [];
    const ids = new Set();
    const keys = new Set();
    const keptFuzz = new Map();
    let nExcluded = 0, nDupes = 0, nDeleted = 0, n = 0;
    const deleted = []; // which ones the ledger held back, for the log
    for (const v of videos) {
      if (++n % 300 === 0) await sleep(0); // keep the UI responsive
      const k = v.seconds > 0 ? dupeKey(v) : null;
      const vars = cfg.fuzzyCollect && v.seconds > 0 ? titleVariants(v.title, v.channel) : null;
      if (excl.exclIds.has(v.id)
        || (cfg.dedupeByTitleDuration && titleDurationHit(excl.exclKeys, v.title, v.seconds))
        || (vars && fuzzBucketHit(excl.exclFuzz, vars, v.seconds))) { nExcluded++; continue; }
      if (goneHit(excl, v, goneCfg)) { nDeleted++; deleted.push(v); continue; }
      if (ids.has(v.id)
        || (cfg.dedupeByTitleDuration && titleDurationHit(keys, v.title, v.seconds))
        || (vars && fuzzBucketHit(keptFuzz, vars, v.seconds))) { nDupes++; continue; }
      ids.add(v.id);
      if (k) keys.add(k);
      if (vars) fuzzBucketAdd(keptFuzz, v.seconds, vars);
      kept.push(v);
    }
    return { kept, nExcluded, nDupes, nDeleted, deleted };
  }

  // Resolve one line of user input (@handle, URL, UC-id, or exact channel
  // name) to a UC… channel id.
  async function resolveChannelInput(s) {
    s = (s || '').trim();
    if (!s) return null;
    const m = s.match(/(UC[\w-]{22})/);
    if (m) return m[1];
    let url = null;
    if (/^https?:\/\//i.test(s)) url = s;
    else if (s.startsWith('@')) url = `${ORIGIN}/${s}`;
    else if (/^[\w.-]+$/.test(s)) url = `${ORIGIN}/@${s}`;
    if (url) {
      try {
        const data = await api('navigation/resolve_url', { url });
        const ep = deepFind(data, 'browseEndpoint');
        if (ep && ep.browseId && ep.browseId.startsWith('UC')) return ep.browseId;
      } catch (e) { /* fall through to search */ }
    }
    return findChannelByExactName(s, null);
  }

  // Prebuilt "already in target" sets, updatable between per-channel adds.
  function makeHaveSets(existing, cfg) {
    const ids = new Set(existing.map((v) => v.id));
    const keys = new Set(
      cfg.dedupeByTitleDuration ? existing.filter((v) => v.seconds > 0).map(dupeKey) : []);
    const fuzz = new Map();
    if (cfg.fuzzyCollect) {
      for (const v of existing) {
        if (v.seconds > 0) fuzzBucketAdd(fuzz, v.seconds, titleVariants(v.title, v.channel));
      }
    }
    return { ids, keys, fuzz, count: existing.length };
  }

  // Filters `videos` down to those not already in the target playlist.
  async function filterAgainstTarget(videos, targetId, cfg, log, guard) {
    const existing = await fetchPlaylistVideos(targetId, 'Target playlist', log, guard);
    const haveIds = new Set(existing.map((v) => v.id));
    const haveKeys = new Set(
      cfg.dedupeByTitleDuration ? existing.filter((v) => v.seconds > 0).map(dupeKey) : []);
    const haveFuzz = new Map();
    if (cfg.fuzzyCollect) {
      for (const v of existing) {
        if (v.seconds > 0) fuzzBucketAdd(haveFuzz, v.seconds, titleVariants(v.title, v.channel));
      }
    }
    const out = [];
    let n = 0;
    for (const v of videos) {
      if (++n % 300 === 0) await sleep(0);
      if (haveIds.has(v.id)) continue;
      if (cfg.dedupeByTitleDuration && titleDurationHit(haveKeys, v.title, v.seconds)) continue;
      if (cfg.fuzzyCollect && v.seconds > 0
        && fuzzBucketHit(haveFuzz, titleVariants(v.title, v.channel), v.seconds)) continue;
      out.push(v);
    }
    log(`${out.length} of ${videos.length} are not yet in the target.`);
    const room = PLAYLIST_CAP - existing.length;
    if (out.length > room) {
      log(`⚠ Target only has room for ${room} more videos (5000 cap) — truncating.`);
      return out.slice(0, Math.max(0, room));
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Playlist deduplicator
  // Matching approach inspired by ytmusic-deleter (apastel):
  //   - strip parentheticals/bracketed decorations from titles
  //   - also compare the part after "Artist - " for UGC-style titles
  //   - fuzzy score with a 0.8 cutoff (theirs: partial_ratio >= 80)
  // plus a duration guard (±fuzzyDurationTolerance, 15s by default) that
  // ytmusic-deleter doesn't have.
  // ------------------------------------------------------------------
  const FUZZY_CUTOFF = 0.8;
  // Different-artist fuzzy matches need a much higher bar, so a main channel
  // and its "- Topic" are grouped in preference to unrelated channels.
  const FUZZY_CUTOFF_XCH = 0.92;
  // How much longer the containing title may be before "one contains the
  // other" stops counting as a match (1.4 = up to 40% of extra text).
  const SUBSTR_MAX_GROWTH = 1.4;
  // Duration slack for fuzzy matches, in seconds (⚙ settings). Cached like the
  // drop words; capped so the ±tolerance scan in fuzzBucketHit stays cheap.
  let durTolCache = null;
  function getDurTol() {
    if (durTolCache === null) {
      const v = parseInt(loadCfg().fuzzyDurationTolerance, 10);
      durTolCache = Math.max(0, Math.min(Number.isFinite(v) ? v : 15, 120));
    }
    return durTolCache;
  }
  // A fuzzy group covering more distinct videos than this is suspicious —
  // usually a shared boilerplate phrase ("free emotional type beat", …)
  // pulled unrelated songs together; such groups are re-split.
  const MAX_GROUP_IDS = 5;
  const COMMON_TOKEN_FRAC = 0.6; // token in ≥60% of a group's videos = boilerplate
  // Stands in for "nothing distinctive left once the shared words are gone".
  // Every such entry gets the SAME marker, so they still match each other and
  // a real group of identically-titled uploads survives the split.
  const BLANK_REDUCED = '\u0000';

  const DECORATION_RES = [
    /\bofficial\s*(music\s*)?(video|audio|visuali[sz]er)\b/g,
    /\bmusic\s*video\b/g,
    /\blyric(s)?(\s*video)?\b/g,
    /\bvisuali[sz]er\b/g,
    /\baudio\s*only\b/g,
    /\bofficial\b/g,
    /\bremaster(ed)?(\s*\d{4})?\b/g,
    /\bfull\s*(song|version)\b/g,
    /\b(hd|hq|4k)\b/g,
    /\bm\/v\b/g,
  ];

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Artist/song separator: " - ", an en/em dash, or the run-together "--"
  // some channels use ("cornandbeans--{Rose}").
  const DASH_SPLIT = /\s+[-\u2013\u2014]\s+|\s*--+\s*/;
  // A trailing segment that names the release a track came from, not the
  // track itself ("Brandon Jenner - Shadow - Burning Ground EP").
  const RELEASE_TAIL = /\b(ep|lp|album|single|mixtape|soundtrack|ost)$/;

  // User-defined words dropped from titles before fuzzy comparison (⚙ settings,
  // space/newline separated). Parsed once and cached — titleVariants runs per
  // video, so re-reading localStorage every call would be wasteful.
  let dropWordsCache = null;
  function getDropWords() {
    if (!dropWordsCache) {
      const raw = loadCfg().fuzzyDropWords || '';
      dropWordsCache = new Set(
        normTitle(raw).replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean));
    }
    return dropWordsCache;
  }

  // Content-changing renditions. An entry that carries one of these is a
  // DIFFERENT track from one that doesn't (instrumental ≠ vocal, live ≠
  // studio, remix ≠ original …), so the deduper must never merge across a
  // mismatch even when the cleaned titles are identical. `live` is detected
  // conservatively (parenthetical / "live at|from|…" / "- live") so ordinary
  // titles containing the word "live" don't trip it.
  const VERSION_QUALIFIERS = [
    ['instrumental', /\binstrumental\b|\boff\s*vocal\b|\bkaraoke\b/],
    ['acoustic', /\bacoustic\b/],
    ['live', /\(live\b|\[live\b|\blive\s+(at|from|in|on|@|session|version|performance|concert|acoustic)\b|[-–]\s*live\b|\blive\s*\d{4}\b/],
    ['remix', /\bremix\b|\bbootleg\b|\bvip\s*(mix)?\b|\bflip\b|\bre[-\s]?edit\b/],
    ['sped', /\bsped\s*up\b|\bspeed\s*up\b|\bnightcore\b/],
    ['slowed', /\bslowed\b|\bslow(ed)?\s*[+&]?\s*reverb\b/],
    ['cover', /\bcover\b/],
    ['piano', /\bpiano\s*(version)?\b/],
    ['8d', /\b8d\b/],
    ['demo', /\bdemo\b/],
    ['extended', /\bextended\s*(mix|version)?\b/],
    ['radio', /\bradio\s*edit\b/],
    ['slowed-tiktok', /\btiktok\b/],
  ];

  // A signature of which qualifiers a title carries — two titles with
  // different signatures are different renditions and stay unmerged.
  function versionKey(title) {
    const t = normTitle(title);
    const tags = [];
    for (const [tag, re] of VERSION_QUALIFIERS) if (re.test(t)) tags.push(tag);
    return tags.join(',');
  }

  // The same signature as a bitmask. Only equality is ever asked of it, and
  // the feed-mark index stores one per video — where the joined tag list
  // ("instrumental,sped") cost seventeen characters a row, a mask costs one
  // or two.
  const VQ_BIT = new Map(VERSION_QUALIFIERS.map(([tag], i) => [tag, 1 << i]));
  const vqMaskFromKey = (key) => {
    let m = 0;
    for (const t of String(key || '').split(',')) m |= VQ_BIT.get(t) || 0;
    return m;
  };
  const versionMask = (title) => vqMaskFromKey(versionKey(title));

  // Normalized artist identity: a channel and its "<Artist> - Topic" share
  // one key, so they count as the same artist for fuzzy grouping.
  const artistKey = (channel) => normTitle(String(channel || '').replace(TOPIC_SUFFIX, ''));

  // Cleaned title variants for similarity comparison. When `artist` is given
  // (the channel/uploader name), its words are stripped from the title too,
  // so "Gracie Abrams - Close To You" and the "- Topic" upload "Close To You"
  // compare on the bare song title. "<Artist> - Topic" is reduced to the
  // artist first.
  function titleVariants(title, artist, keepBrackets) {
    const drop = getDropWords();
    const clean = (s) => {
      // Fold accents so "Café"/"Cafe" and "Beyoncé"/"Beyonce" compare equal.
      s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
      // Round and square brackets hold decorations ("(Official Video)"), so
      // their contents go. BRACES DO NOT: "cornandbeans--{Fire Storm}" keeps
      // the song name in there, and dropping it left every upload on such a
      // channel comparing as the bare word "cornandbeans".
      // keepBrackets unwraps the other two instead of dropping them; only the
      // group splitter asks for that form.
      s = keepBrackets ? s.replace(/[([)\]]/g, ' ')
        : s.replace(/[([][^)\]]*[)\]]/g, ' '); // strip_parentheticals
      for (const re of DECORATION_RES) s = s.replace(re, ' ');
      // Drops every symbol / punctuation mark — only letters and digits survive.
      s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
      if (drop.size && s) {
        // Whole-word removal; if the title is nothing but drop words, keep it
        // as-is rather than blanking it out.
        const kept = s.split(' ').filter((w) => !drop.has(w)).join(' ');
        if (kept) s = kept;
      }
      return s;
    };
    // "Artist - Song - Album EP": the last segment names the release, not the
    // song. Drop it when a middle segment survives, so "… - Shadow - Burning
    // Ground EP" reads as "Shadow" rather than matching the song "Burning
    // Ground" through the EP tag they share.
    // '[FREE] Chill Indie Pop Guitar Type Beat - "Circles"': everything but
    // the quoted name is the producer's boilerplate, shared word for word by
    // hundreds of different beats. Compare beats on their name alone.
    if (TYPE_BEAT_RE.test(title)) {
      const q = String(title).match(/["“”«»「『]([^"“”«»」』]+)["“”«»」』]/);
      const name = q ? clean(normTitle(q[1])) : '';
      if (name) return [name];
    }
    let parts = normTitle(title).split(DASH_SPLIT);
    if (parts.length >= 3 && RELEASE_TAIL.test(clean(parts[parts.length - 1]))) parts = parts.slice(0, -1);
    const full = clean(parts.join(' - '));
    const variants = full ? [full] : [];

    // Strip the artist's words (whole-word) from the cleaned title. Only used
    // if something real is left, so a self-titled track isn't blanked. One
    // character is something real: "K. - Cigarettes After Sex" is the song
    // "K", and falling back to the full title left it matching every other
    // "… - Cigarettes After Sex" upload through the artist's name.
    const artClean = artist ? clean(normTitle(String(artist).replace(TOPIC_SUFFIX, ''))) : '';
    if (artClean && full) {
      const toks = artClean.split(' ').filter((w) => w.length > 1);
      if (toks.length) {
        const re = new RegExp('\\b(?:' + toks.map(escapeRe).join('|') + ')\\b', 'g');
        const stripped = full.replace(re, ' ').replace(/\s+/g, ' ').trim();
        if (stripped && stripped !== full) {
          variants.unshift(stripped); // cleanest form → primary comparison target
        }
      }
    }

    // UGC "Artist - Song": also compare just the part after the last dash —
    // unless that part is the uploader's own name ("Song - Artist"), which
    // would make every such upload of theirs look like the same song.
    const dash = parts;
    if (dash.length > 1) {
      const after = clean(dash[dash.length - 1]);
      if (after && !variants.includes(after) && after !== artClean) variants.push(after);
    }
    return variants;
  }

  // Sørensen–Dice similarity on character bigrams (fast fuzzy stand-in for
  // partial_ratio) + substring containment bonus.
  function bigramCounts(s) {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const b = s.slice(i, i + 2);
      m.set(b, (m.get(b) || 0) + 1);
    }
    return m;
  }

  function diceSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    // Containment only means "same song" when the extra text is a trimming,
    // not a second title: "shadow" sits inside "shadow burning ground ep"
    // without being that track. Anything longer falls through to the bigram
    // score and is rated on its own merits.
    if (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))
      && Math.max(a.length, b.length) <= SUBSTR_MAX_GROWTH * Math.min(a.length, b.length)) return 0.9;
    if (a.length < 2 || b.length < 2) return 0;
    const A = bigramCounts(a), B = bigramCounts(b);
    let inter = 0, ca = 0, cb = 0;
    A.forEach((c, g) => { if (B.has(g)) inter += Math.min(c, B.get(g)); ca += c; });
    B.forEach((c) => { cb += c; });
    return (2 * inter) / (ca + cb);
  }

  // Variant arrays are [fullCleanedTitle, afterDashPart?]. The dash variant
  // is never compared against another dash variant: for "Song - Artist"
  // titles that part is the ARTIST, and dash-vs-dash would match every song
  // by the same artist. Legit "Artist - Song" pairs still match via their
  // full variants.
  function similarScore(variantsA, variantsB) {
    let best = 0;
    for (let i = 0; i < variantsA.length; i++) {
      for (let j = 0; j < variantsB.length; j++) {
        if (i > 0 && j > 0) continue; // dash-variant vs dash-variant: skip
        best = Math.max(best, diceSimilarity(variantsA[i], variantsB[j]));
        if (best >= 1) return best;
      }
    }
    return best;
  }

  // Numbered pieces of one series ("Idea 7" / "Idea 12", "atom 1" /
  // "atom 10", "Pt. 1" / "Pt. 2", "No. 1" / "No. 2") look near-identical to
  // the bigram score but are different tracks. Two titles whose numbers
  // differ — neither set contained in the other — never match. A subset is
  // fine: "Symphony No. 5" vs "Symphony No. 5, Op. 67" is still one piece.
  const numbersOf = (variants) => new Set((variants.join(' ').match(/\b\d+\b/g) || []).map(Number));
  function numbersClash(a, b) {
    if (!a.size || !b.size) return false;
    const aInB = [...a].every((n) => b.has(n));
    const bInA = [...b].every((n) => a.has(n));
    return !aInB && !bInA;
  }

  // Duration-bucketed fuzzy index: map seconds → [titleVariants…]. Lets the
  // collector reuse the deduper's matching without O(n²) comparisons.
  function fuzzBucketAdd(map, seconds, variants) {
    const arr = map.get(seconds);
    if (arr) arr.push(variants); else map.set(seconds, [variants]);
  }

  function fuzzBucketHit(map, variants, seconds) {
    if (!seconds || !map.size) return false;
    const tol = getDurTol();
    for (let s = seconds - tol; s <= seconds + tol; s++) {
      const arr = map.get(s);
      if (!arr) continue;
      for (const other of arr) {
        if (numbersClash(numbersOf(variants), numbersOf(other))) continue;
        if (similarScore(variants, other) >= FUZZY_CUTOFF) return true;
      }
    }
    return false;
  }

  // "Select default" for a playlist picker (boxes = [{p, cb}]): ticks exactly
  // your default (= excluded) playlists from ⚙ settings, unticks the rest.
  function defaultSelBtn(boxes) {
    const ids = defaultPlaylistIds();
    const n = boxes.filter((b) => ids.has(b.p.id)).length;
    const btn = el('button', { class: 'ycfp-btn ycfp-secondary' }, `Select default (${n})`);
    btn.title = ids.size ? 'Tick only your default playlists (the excluded playlists in ⚙ settings)'
      : 'No default playlists yet — tick excluded playlists in ⚙ settings';
    btn.disabled = !n;
    btn.addEventListener('click', () => boxes.forEach((b) => { b.cb.checked = ids.has(b.p.id); }));
    return btn;
  }

  // Your playlists (the /feed/playlists library), for the dedupe picker.
  async function getOwnPlaylists(log) {
    const out = [];
    const seenP = new Set();
    const addP = (id, title) => {
      if (!id || seenP.has(id) || /^RD/.test(id)) return;
      seenP.add(id);
      out.push({ id, title: title || id });
    };
    const collect = (data) => {
      // Scoped to the library's own list — the feed also carries shelves of
      // playlists that aren't yours, which used to end up in the picker.
      const section = playlistSection(data);
      if (!section) return;
      const root = section.items;
      for (const g of deepCollect(root, 'gridPlaylistRenderer')) {
        if (g) addP(g.playlistId, textOf(g.title));
      }
      for (const p of deepCollect(root, 'playlistRenderer')) {
        if (p) addP(p.playlistId, textOf(p.title));
      }
      for (const lv of deepCollect(root, 'lockupViewModel')) {
        if (!lv || !lv.contentId) continue;
        if (lv.contentType && !/PLAYLIST|ALBUM|PODCAST/.test(lv.contentType)) continue;
        const meta = deepFind(lv, 'lockupMetadataViewModel');
        addP(lv.contentId, meta && meta.title
          ? (typeof meta.title.content === 'string' ? meta.title.content : textOf(meta.title))
          : '');
      }
    };
    const usedTokens = new Set();
    let data = await api('browse', { browseId: 'FEplaylist_aggregation' });
    for (;;) {
      collect(data);
      log(`Found ${out.length} playlists…`, true);
      const next = nextSectionToken(playlistSection(data), usedTokens);
      if (!next) break;
      data = await api('browse', { continuation: next });
      await sleep(150);
    }
    if (out.length === 0) {
      // Fallback: the "Save to playlist" list (needs any video id as anchor)
      for (const p of await getUserPlaylists('dQw4w9WgXcQ')) addP(p.id, p.title);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Unlinked pairs: video-ID pairs the user has explicitly flagged (✕ on a
  // result group) as NOT duplicates of each other. Consulted below so a
  // future scan never re-groups them. Keyed on video ID (stable across
  // scans/playlists), not entry index or group membership.
  // ------------------------------------------------------------------
  const UNLINK_KEY = 'ycfp-dedupe-unlinked-v1';
  const pairKey = (a, b) => (a < b ? `${a} ${b}` : `${b} ${a}`);
  const loadUnlinkedPairs = () => {
    try { return new Set(JSON.parse(kvGet(UNLINK_KEY)) || []); } catch (e) { return new Set(); }
  };
  const saveUnlinkedPairs = (set) => kvSet(UNLINK_KEY, JSON.stringify([...set]));

  // ------------------------------------------------------------------
  // Matching modes. All four run off ONE fetch of your playlists — the scan
  // is the expensive part, the grouping is cheap — so you can switch between
  // them in the results view and each keeps its own ticks (see runDedupeFlow).
  //   simple    — same video, or identical title + same length. No guessing.
  //   fuzzy     — similar cleaned titles, durations within the ⚙ tolerance.
  //   titlelen  — similar titles, but the lengths must match (±2s). Stricter
  //               than fuzzy: catches re-uploads, not different edits.
  //   title     — similar titles, duration ignored entirely. The loosest —
  //               finds the same song at different lengths (radio edit vs
  //               album cut, a version with a long outro) and needs the most
  //               eyeballing.
  // ------------------------------------------------------------------
  const MATCH_MODES = [
    { key: 'simple', label: 'Simple — same video, or same title + same length only' },
    { key: 'fuzzy', label: 'Fuzzy — also group similar versions (official / lyric / audio variants)' },
    { key: 'titlelen', label: 'Similar title + same length — similar titles, but only when the lengths match (±2s)' },
    { key: 'title', label: 'Similar titles — duration ignored entirely (loosest; check these carefully)' },
  ];
  const MODE_LABEL = (k) => (MATCH_MODES.find((m) => m.key === k) || MATCH_MODES[0]).label;
  const isFuzzyMode = (mode) => mode === 'fuzzy' || mode === 'title' || mode === 'titlelen';
  // null = don't constrain durations at all.
  const modeDurTol = (mode) => (mode === 'title' ? null
    : (mode === 'titlelen' ? EXACT_SECONDS_TOLERANCE : getDurTol()));

  // Blocking keys for duration-free matching: two entries are only compared
  // when they share one. Without the duration window an all-pairs sweep of a
  // few thousand entries is minutes of work; with it, it's a moment.
  function titleBlocks(variants) {
    const keys = new Set();
    for (const v of variants.slice(0, 2)) {
      if (!v) continue;
      keys.add('p:' + v.slice(0, 5));
      let n = 0;
      for (const tok of v.split(' ')) {
        if (tok.length < 4) continue;
        keys.add('t:' + tok);
        if (++n >= 6) break;
      }
    }
    return keys;
  }
  // A block bigger than this is a stopword-ish bucket ("official", "video");
  // comparing it all-pairs costs more than it finds.
  const MAX_BLOCK = 400;
  const TYPE_BEAT_RE = /\btype\s*beat\b/i;

  // Union-find grouping of duplicate entries. Tiers:
  //   T1 same videoId · T2 same normalized title + exact duration ·
  //   T3 (fuzzy modes) similar cleaned title, within the mode's duration rule.
  // `mode` is a MATCH_MODES key; a boolean is accepted for old saved scans.
  async function analyzeDuplicates(entries, mode, log) {
    if (typeof mode === 'boolean') mode = mode ? 'fuzzy' : 'simple';
    const fuzzy = isFuzzyMode(mode);
    const unlinkedPairs = loadUnlinkedPairs();
    // T1 (identical video ID) is never blockable — it's literally the same
    // video, not a heuristic guess.
    const blocked = (i, j) => {
      const a = entries[i].id, b = entries[j].id;
      return !!a && !!b && a !== b && unlinkedPairs.has(pairKey(a, b));
    };
    // Grouping is transitive, so checking only the pair being compared let an
    // unlinked A↮B back in through a third video matching both (A~C, C~B).
    // Each group tracks the video ids it holds instead, and a merge that would
    // put an unlinked pair in one group is refused.
    const unlinkedOf = new Map(); // id → ids it is unlinked from
    for (const k of unlinkedPairs) {
      const [a, b] = k.split(' ');
      if (!a || !b) continue;
      if (!unlinkedOf.has(a)) unlinkedOf.set(a, []);
      if (!unlinkedOf.has(b)) unlinkedOf.set(b, []);
      unlinkedOf.get(a).push(b);
      unlinkedOf.get(b).push(a);
    }
    const parent = entries.map((_, i) => i);
    const idsOf = entries.map((e) => new Set([e.id])); // valid at roots only
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (a, b) => {
      a = find(a); b = find(b);
      if (a === b) return;
      if (idsOf[a].size < idsOf[b].size) [a, b] = [b, a];
      for (const id of idsOf[b]) {
        for (const x of unlinkedOf.get(id) || []) if (idsOf[a].has(x)) return;
      }
      parent[b] = a;
      for (const id of idsOf[b]) idsOf[a].add(id);
      idsOf[b] = null;
    };
    const bucketPush = (map, k, i) => {
      const arr = map.get(k);
      if (arr) arr.push(i); else map.set(k, [i]);
    };

    const byId = new Map();
    const byTitle = new Map();
    entries.forEach((e, i) => {
      bucketPush(byId, e.id, i);
      if (e.seconds > 0) bucketPush(byTitle, normTitle(e.title), i);
    });
    for (const arr of byId.values()) for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
    // Same normalized title with durations within tolerance — the two data
    // models can disagree by a second or two on the same video.
    for (const arr of byTitle.values()) {
      arr.sort((a, b) => entries[a].seconds - entries[b].seconds);
      for (let i = 1; i < arr.length; i++) {
        if (entries[arr[i]].seconds - entries[arr[i - 1]].seconds <= EXACT_SECONDS_TOLERANCE
          && !blocked(arr[i - 1], arr[i])) {
          union(arr[i - 1], arr[i]);
        }
      }
    }

    // Precomputed per-entry keys, reused by the fuzzy pass and the splitter.
    let variants = null, vkey = null, akey = null;
    if (fuzzy) {
      log(`Matching similar titles (${mode})…`);
      variants = entries.map((e) => titleVariants(e.title, e.channel));
      // Instrumental / live / remix / … renditions never merge with a
      // different rendition, even if the cleaned titles match.
      // A "… Type Beat" instrumental is its own kind of track: it never
      // merges with a song, even one it is named after (beat "Believe" vs
      // the song "Believe"). Folded into the rendition key, so the splitter
      // and the zero-duration pass below honour it too.
      vkey = entries.map((e) => versionKey(e.title) + (TYPE_BEAT_RE.test(e.title) ? '|beat' : ''));
      akey = entries.map((e) => artistKey(e.channel));
      const nums = variants.map(numbersOf);
      // One pair test, shared by both sweeps below.
      const tryPair = (i, j) => {
        if (find(i) === find(j)) return;
        if (vkey[i] !== vkey[j]) return; // instrumental ≠ vocal, live ≠ studio, …
        if (numbersClash(nums[i], nums[j])) return; // "Idea 7" ≠ "Idea 12"
        if (blocked(i, j)) return; // explicitly unlinked by the user
        // Different artists need a much higher bar (main↔Topic preferred).
        const cutoff = (akey[i] && akey[j] && akey[i] !== akey[j]) ? FUZZY_CUTOFF_XCH : FUZZY_CUTOFF;
        if (similarScore(variants[i], variants[j]) >= cutoff) union(i, j);
      };
      const durTol = modeDurTol(mode);
      if (durTol === null) {
        // Duration ignored: block on shared title fragments instead of a
        // duration window, so this stays a comparison of plausible pairs
        // rather than every pair in the scan.
        const blocks = new Map();
        entries.forEach((_, i) => {
          for (const k of titleBlocks(variants[i])) bucketPush(blocks, k, i);
        });
        let done = 0, skipped = 0;
        for (const bucket of blocks.values()) {
          if (bucket.length < 2) continue;
          if (bucket.length > MAX_BLOCK) { skipped++; continue; }
          if (++done % 200 === 0) { await sleep(0); log(`Matching titles… ${done}/${blocks.size} groups`, true); }
          for (let x = 1; x < bucket.length; x++) {
            for (let y = 0; y < x; y++) tryPair(bucket[x], bucket[y]);
          }
        }
        if (skipped) {
          log(`Note: ${skipped} title fragment(s) are shared by more than ${MAX_BLOCK} entries `
            + '(boilerplate like "official video") and were not compared word-for-word — '
            + 'matches on the distinctive parts of those titles still count.');
        }
      } else {
        // Only compare entries whose durations are within tolerance:
        // sort by duration and slide a window.
        const idx = entries.map((_, i) => i)
          .filter((i) => entries[i].seconds > 0)
          .sort((a, b) => entries[a].seconds - entries[b].seconds);
        let windowStart = 0;
        for (let x = 0; x < idx.length; x++) {
          if (x % 250 === 0) { await sleep(0); log(`Matching titles… ${x}/${idx.length}`, true); }
          const i = idx[x];
          while (entries[idx[windowStart]].seconds < entries[i].seconds - durTol) windowStart++;
          for (let y = windowStart; y < x; y++) tryPair(i, idx[y]);
        }
      }
      // Zero-duration entries: exact cleaned-title matches, still split by
      // rendition (an instrumental upload stays separate from the vocal one).
      const byClean = new Map();
      entries.forEach((e, i) => {
        if (e.seconds === 0) for (const v of variants[i]) bucketPush(byClean, v + '|' + vkey[i], i);
      });
      for (const arr of byClean.values()) for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
    }

    const groupsMap = new Map();
    entries.forEach((_, i) => bucketPush(groupsMap, find(i), i));
    // A lone entry is still a duplicate when it stands for several physical
    // copies in one playlist (a list whose data carries no per-entry handles,
    // so the copies collapsed into one row — see extractVideos).
    let groups = [...groupsMap.values()]
      .filter((g) => g.length > 1 || (entries[g[0]].copies || 1) > 1);

    // Break apart oversized fuzzy clusters caused by shared boilerplate.
    if (fuzzy) {
      const refined = [];
      let splitCount = 0;
      for (const g of groups) {
        const subs = splitFuzzyGroup(g, entries, variants, vkey, akey, log, blocked);
        if (subs.length > 1) splitCount++;
        for (const s of subs) if (s.length > 1) refined.push(s);
      }
      if (splitCount) log(`Split ${splitCount} oversized group(s) that shared boilerplate text.`);
      groups = refined;
    }

    groups.sort((a, b) => b.length - a.length);
    return groups;
  }

  // An oversized fuzzy group (too many distinct videos) is almost always a
  // false cluster glued together by a phrase most of its titles share
  // (e.g. "free emotional piano type beat"). Strip the tokens that appear in
  // ≥COMMON_TOKEN_FRAC of the group's videos, then re-cluster on what's left,
  // so only entries that still match on their DISTINCTIVE words stay grouped.
  function splitFuzzyGroup(group, entries, variants, vkey, akey, log, blocked, depth) {
    const ids = new Set(group.map((i) => entries[i].id));
    if (ids.size <= MAX_GROUP_IDS) return [group];

    // Token document-frequency across DISTINCT videos (copies don't inflate).
    const df = new Map();
    const seen = new Set();
    for (const i of group) {
      for (const tok of new Set((variants[i][0] || '').split(' ').filter(Boolean))) {
        const k = entries[i].id + '|' + tok;
        if (seen.has(k)) continue;
        seen.add(k);
        df.set(tok, (df.get(tok) || 0) + 1);
      }
    }
    const need = Math.max(2, Math.ceil(COMMON_TOKEN_FRAC * ids.size));
    const common = new Set([...df].filter(([, c]) => c >= need).map(([t]) => t));
    if (!common.size) return [group]; // nothing obviously shared

    // Distinctive-token-only titles. Falling back to the FULL form when
    // nothing distinctive is left just re-merges the group this was asked to
    // break up — that is what kept "cornandbeans--{Wildflower}" glued to
    // "cornandbeans--{Blaze}". So retry on the bracket-preserving form first,
    // and only then fall back to the shared blank marker.
    const dropCommon = (s) => s.split(' ').filter((w) => w && !common.has(w)).join(' ');
    const reduced = group.map((i) => {
      const kept = dropCommon(variants[i][0] || '');
      if (kept) return kept;
      const alt = dropCommon(titleVariants(entries[i].title, entries[i].channel, true)[0] || '');
      return alt || BLANK_REDUCED;
    });
    if (log) log(`Re-splitting a ${ids.size}-video group; dropped shared words: ${[...common].join(', ')}.`);

    // Re-cluster within the group on the reduced titles.
    const parent = group.map((_, k) => k);
    const find = (k) => (parent[k] === k ? k : (parent[k] = find(parent[k])));
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const i = group[a], j = group[b];
        if (entries[i].id === entries[j].id) { union(a, b); continue; } // copies of one video
        if (vkey[i] !== vkey[j]) continue;
        if (numbersClash(numbersOf(variants[i]), numbersOf(variants[j]))) continue;
        const di = entries[i].seconds, dj = entries[j].seconds;
        if (di > 0 && dj > 0 && Math.abs(di - dj) > getDurTol()) continue;
        if (blocked && blocked(i, j)) continue; // explicitly unlinked by the user
        const cutoff = (akey[i] && akey[j] && akey[i] !== akey[j]) ? FUZZY_CUTOFF_XCH : FUZZY_CUTOFF;
        if (diceSimilarity(reduced[a], reduced[b]) >= cutoff) union(a, b);
      }
    }
    const sub = new Map();
    group.forEach((gi, k) => {
      const r = find(k);
      if (!sub.has(r)) sub.set(r, []);
      sub.get(r).push(gi);
    });
    const parts = [...sub.values()];
    // One pass only strips what the WHOLE group shares; a surviving chunk can
    // carry boilerplate of its own. Re-split it, while passes make progress.
    if (parts.length > 1 && (depth || 0) < 3) {
      return parts.flatMap((p) =>
        splitFuzzyGroup(p, entries, variants, vkey, akey, log, blocked, (depth || 0) + 1));
    }
    return parts;
  }

  const groupCopies = (group, entries) =>
    group.reduce((n, i) => n + (entries[i].copies || 1), 0);

  function groupLabel(group, entries) {
    const ids = new Set(group.map((i) => entries[i].id));
    if (group.length === 1) {
      return `${groupCopies(group, entries)} copies in one playlist — tick to trim to a single copy`;
    }
    if (ids.size === 1) return 'same video, multiple entries';
    const timed = group.filter((i) => entries[i].seconds > 0);
    const keys = new Set(timed.map((i) => dupeKey(entries[i])));
    if (keys.size < timed.length) return 'same title + duration';
    return 'similar (fuzzy match)';
  }

  // True when a group's entries come from more than one channel. "Artist"
  // and "Artist - Topic" are treated as the SAME artist (those main↔Topic
  // matches are expected), so this only flags genuinely different channels —
  // the ones worth eyeballing before removing.
  function groupCrossChannel(group, entries) {
    const names = new Set();
    for (const i of group) {
      const c = normTitle((entries[i].channel || '').replace(TOPIC_SUFFIX, ''));
      if (c) names.add(c);
    }
    return names.size > 1;
  }

  const fmtDur = (s) => !s ? '?:??'
    : (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}`)
      + ':' + String(s % 60).padStart(2, '0');

  // ------------------------------------------------------------------
  // Removal history: everything that left one of your playlists — removed
  // by the script's buttons, removed by you in YouTube's own UI (noticed on
  // the next full read), or MOVED to another of your playlists — with undo.
  //
  // Kept in the IndexedDB archive (store "events", see below) since v3.37.0:
  // no 3000-row cap, and it no longer competes for the 5 MB localStorage
  // quota. The old localStorage journal is imported once and then deleted;
  // it is still used, as a fallback, when IndexedDB is unavailable.
  //
  // One row per video per event:
  //   { k, t, kind: 'removed'|'moved', src, id, title, channel, seconds,
  //     playlistId, playlistTitle, to: [{id, title}], restored, unverified }
  // src: quick (✕), move (quick-move buttons), dedupe, channel, shorts,
  //      dead (🪦 cleanup), detected (you did it in YouTube; noticed later).
  // ------------------------------------------------------------------
  const LOG_KEY = 'ycfp-removal-log-v1';
  const loadRemovalLog = () => {
    try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch (e) { return []; }
  };
  const saveRemovalLog = (l) => lsSet(LOG_KEY, JSON.stringify(l.slice(-3000)));

  function journalRemovals(entries, src, to = null) {
    if (!entries.length) return;
    const t = Date.now();
    const isMove = src === 'move' || src === 'unavail';
    const rows = entries.map((e) => ({
      t, src,
      kind: isMove ? 'moved' : 'removed',
      id: e.id,
      title: e.title || '',
      channel: e.channel || '',
      seconds: e.seconds || 0,
      playlistId: e.playlistId,
      playlistTitle: e.playlistTitle || '',
      to: to ? [to] : [],
    }));
    // A move is a keep, not a deletion — the video is still in your library,
    // just somewhere else. Everything else is you throwing it out, so it goes
    // to the ledger straight away rather than waiting for the next full read
    // of that playlist to notice it's gone.
    if (isMove) noteMoved(entries.map((e) => e.id));
    const done = evAdd(rows);
    if (!isMove) done.then(() => recordDeleted(rows));
    return done;
  }

  // ------------------------------------------------------------------
  // "I deleted this on purpose" ledger
  //
  // A video taken out of a playlist — by hand in YouTube's own UI, or with
  // this script's ✕ / dedupe / remove-channel buttons — used to come straight
  // back the next time that channel was collected. The ledger stops that:
  // every full playlist read is diffed against the archive's copy of how
  // that playlist looked last time, and whatever has disappeared since is
  // recorded as deliberately removed. Collecting then skips those videos by
  // id, and — when the matching options are on — by title+duration and by
  // fuzzy variant too, so the Topic-channel copy of a song you deleted can't
  // sneak back in through the other channel.
  //
  // A video that disappeared from one playlist but is in another of yours
  // was MOVED, not deleted (classifyMissing checks, and asks YouTube when
  // the archive doesn't know), so it is never ledgered — and anything the
  // ledger holds that a later read finds in one of your playlists is taken
  // back out (forgetKeptInPlaylist).
  // ------------------------------------------------------------------
  const SNAP_KEY = 'ycfp-playlist-snapshots-v1';
  const GONE_KEY = 'ycfp-deleted-ledger-v1';
  const GONE_CAP = 8000;      // oldest entries beyond this are forgotten
  const SNAP_CAP = 40;        // playlists tracked; least recently seen dropped
  // A drop this big is far more likely to be a half-finished fetch than a
  // deliberate purge, so it is reported instead of being written to the
  // ledger. The snapshot is still refreshed, so a genuine purge only needs
  // the collect to be run twice.
  const SNAP_SANE_DROP = 0.5;
  const SNAP_SANE_MIN = 50;
  // Missing videos the archive can't place are checked against YouTube
  // itself (one "Save to playlist" lookup each) — up to this many per read.
  // The rest are recorded as removed but flagged unverified, and 📜 Removed
  // videos → "Check for moves" can settle them later.
  const MOVE_VERIFY_CAP = 150;

  const loadSnaps = () => {
    try { return JSON.parse(kvGet(SNAP_KEY)) || {}; } catch (e) { return {}; }
  };
  const saveSnaps = (s) => {
    const keys = Object.keys(s);
    if (keys.length > SNAP_CAP) {
      keys.sort((a, b) => (s[a].ts || 0) - (s[b].ts || 0));
      for (const k of keys.slice(0, keys.length - SNAP_CAP)) delete s[k];
    }
    kvSet(SNAP_KEY, JSON.stringify(s));
  };
  // Taking a video out of Watch Later means you watched it, not that you
  // don't want it — and Available replacements is a staging list, emptied
  // as its videos find a home. Removals from either never go on the ledger;
  // entries recorded from them before that rule are dropped on load (and on
  // the next save). Matched by id, or by name for the replacements list.
  const NO_LEDGER_IDS = new Set(['WL', 'PLN4hsx6eibfo']);
  const NO_LEDGER_TITLE_RE = /^\s*(watch later|available replacements)\s*$/i;
  const ledgerable = (pid, title = '') => !NO_LEDGER_IDS.has(pid) && !NO_LEDGER_TITLE_RE.test(String(title));
  // Older entries may carry only the playlist name (p), not its id (pid).
  const noLedgerEntry = (e) => !ledgerable(e.pid, e.p) || NO_LEDGER_IDS.has(e.p);
  const loadGone = () => {
    let g;
    try { g = JSON.parse(kvGet(GONE_KEY)) || {}; } catch (e) { return {}; }
    for (const [id, e] of Object.entries(g)) if (e && noLedgerEntry(e)) delete g[id];
    return g;
  };
  // Bumped on every write so the cached matching sets rebuild themselves.
  let goneVersion = 0;
  const saveGone = (g) => {
    const ids = Object.keys(g);
    if (ids.length > GONE_CAP) {
      ids.sort((a, b) => (g[a].ts || 0) - (g[b].ts || 0));
      for (const id of ids.slice(0, ids.length - GONE_CAP)) delete g[id];
    }
    kvSet(GONE_KEY, JSON.stringify(g));
    goneVersion++;
    goneSetsCache = null;
  };
  const goneCount = () => Object.keys(loadGone()).length;

  // Videos the quick-action buttons MOVED to another playlist. They vanish
  // from the source playlist exactly like a deletion does, so the snapshot
  // diff has to be told they were kept, not thrown out.
  const MOVED_KEY = 'ycfp-moved-v1';
  const MOVED_TTL_MS = 90 * 24 * 60 * 60 * 1000;
  const loadMoved = () => {
    try { return JSON.parse(kvGet(MOVED_KEY)) || {}; } catch (e) { return {}; }
  };
  function noteMoved(ids) {
    const m = loadMoved();
    const now = Date.now();
    for (const [id, ts] of Object.entries(m)) if (now - ts > MOVED_TTL_MS) delete m[id];
    for (const id of ids) m[id] = now;
    kvSet(MOVED_KEY, JSON.stringify(m));
  }

  // Put entries straight into the ledger (used when the script itself does
  // the removing, so the metadata is right there). Anything still in
  // another of your playlists — a duplicate copy the deduper took out, say —
  // is not a deletion and stays collectable.
  async function recordDeleted(entries) {
    const idx = await archIndex(60 * 1000);
    const gone = loadGone();
    let added = 0;
    for (const e of entries) {
      if (!e.id || gone[e.id] || !ledgerable(e.playlistId, e.playlistTitle) || archWhereElse(idx, e.id, e.playlistId).length) continue;
      const meta = archMeta(idx, e.id);
      gone[e.id] = {
        t: e.title || meta[0] || '', s: e.seconds || meta[1] || 0, c: e.channel || meta[2] || '',
        p: e.playlistTitle || e.playlistId || '', pid: e.playlistId || '', ts: Date.now(),
      };
      added++;
    }
    if (added) saveGone(gone);
  }

  // Undoing a removal means you want the video back — so it must stop being
  // treated as deliberately deleted.
  function forgetDeleted(ids) {
    const gone = loadGone();
    let n = 0;
    for (const id of ids) if (gone[id]) { delete gone[id]; n++; }
    if (n) saveGone(gone);
    return n;
  }

  // Everything that was in `prev` (Map id → [id, title, seconds, channel])
  // and is not in the playlist any more is sorted into MOVED (it is in
  // another of your playlists) or REMOVED (it isn't — you threw it out).
  // Both are written to the history; only the removed ones go on the ledger.
  //
  // Where a video went is answered by the archive first (free), then by
  // YouTube's own "Save to playlist" membership, which knows about every
  // playlist you have — including ones the script has never read. Before
  // v3.37.0 only a size-capped localStorage index was consulted, so a song
  // moved by hand into a playlist it hadn't read recently was recorded as
  // deleted (and then skipped by every collect).
  //
  // A video YouTube itself killed does NOT come through here — its row stays
  // in the playlist as a tombstone, so it is never missing. Those are handled
  // by the archive's deadKind() pass instead.
  async function classifyMissing(pid, title, prev, nowSet, log) {
    const moved = loadMoved();
    const missing = [...prev.keys()].filter((id) => !nowSet.has(id) && !moved[id]);
    if (!missing.length) return;
    if (missing.length > SNAP_SANE_MIN && missing.length > prev.size * SNAP_SANE_DROP) {
      log(`⚠ "${title || pid}": ${missing.length} of ${prev.size} videos are missing since the last check — `
        + 'too many to assume you removed them all, so nothing was added to the deleted-video ledger. '
        + 'Run this again and the next diff will be recorded normally.');
      return;
    }
    const idx = await archIndex(60 * 1000);
    const gone = loadGone();
    const events = [];
    let nMoved = 0, nRemoved = 0, verified = 0, unverified = 0;
    for (const id of missing) {
      const r = prev.get(id) || [id, '', 0, ''];
      const meta = archMeta(idx, id);
      const ev = {
        t: Date.now(), src: 'detected', id,
        title: r[1] || meta[0] || '', seconds: r[2] || meta[1] || 0, channel: r[3] || meta[2] || '',
        playlistId: pid, playlistTitle: title || pid, to: [],
      };
      let where = archWhereElse(idx, id, pid);
      let checked = !!where.length;
      if (!where.length && verified < MOVE_VERIFY_CAP) {
        verified++;
        if (verified === 1 || verified % 10 === 0) log(`"${title || pid}": checking where ${missing.length} missing video(s) went… (${verified})`, true);
        const mem = await fetchMembership(id);
        if (mem.ok) {
          checked = true;
          where = [...mem.map].filter(([p, inIt]) => inIt && p !== pid)
            .map(([p]) => ({ id: p, title: playlistTitleOf(p) }));
        }
        await sleep(80);
      }
      if (where.length) {
        ev.kind = 'moved';
        ev.to = where;
        nMoved++;
        // Moved, not deleted — if an earlier diff got this wrong, undo it.
        if (gone[id]) delete gone[id];
      } else {
        ev.kind = 'removed';
        if (!checked) { ev.unverified = true; unverified++; }
        nRemoved++;
        if (!gone[id] && ledgerable(pid, title)) {
          gone[id] = { t: ev.title, s: ev.seconds, c: ev.channel, p: ev.playlistTitle, pid, ts: Date.now() };
        }
      }
      events.push(ev);
    }
    saveGone(gone);
    await evAdd(events);
    const parts = [];
    if (nRemoved) parts.push(ledgerable(pid, title)
      ? `${nRemoved} removed — future collects will skip ${nRemoved === 1 ? 'it' : 'them'}`
      : `${nRemoved} removed (${title || pid} — not added to the deleted-video ledger)`);
    if (nMoved) parts.push(`${nMoved} moved to another of your playlists — kept, not counted as deleted`);
    log(`"${title || pid}": ${missing.length} video(s) left since the last read: ${parts.join('; ')}.`
      + (unverified ? ` (${unverified} could not be checked for a move yet — 📜 Removed videos → "Check for moves".)` : '')
      + ' 📜 lists them all.');
  }

  // Diff a freshly-read playlist against its last snapshot and record what
  // vanished. `videos` must be a COMPLETE read of the playlist.
  //
  // Only used when IndexedDB is unavailable — archiveTrack() does this job
  // and more, without spending any of the localStorage quota.
  async function trackPlaylistSnapshot(pid, title, videos, log) {
    if (!pid || !Array.isArray(videos) || !videos.length) return;
    const snaps = loadSnaps();
    const prev = snaps[pid];
    const nowSet = new Set(videos.map((v) => v.id));
    if (prev && Array.isArray(prev.ids) && prev.ids.length) {
      await classifyMissing(pid, title, new Map(prev.ids.map((id) => [id, [id, '', 0, '']])), nowSet, log);
    }
    snaps[pid] = { ts: Date.now(), title: title || pid, ids: [...nowSet] };
    saveSnaps(snaps);
  }

  // Called with a complete read of one of your own playlists: anything in it
  // that the ledger lists as deleted is evidently still kept, so it comes
  // back out — and a history row that called it "removed" is corrected to
  // "moved" (or "restored", when it is back in the very playlist it left).
  // Covers a move whose destination is read after its source.
  async function forgetKeptInPlaylist(pid, title, videos, log) {
    const here = new Set(videos.map((v) => v.id));
    const gone = loadGone();
    let n = 0;
    for (const id of here) if (gone[id]) { delete gone[id]; n++; }
    if (n) {
      saveGone(gone);
      log(`${n} video(s) in "${title}" were on the deleted-video ledger — they're still in your library `
        + '(moved, not removed), so collects no longer skip them.');
    }
    const removedIds = await evRemovedIds();
    if (![...here].some((id) => removedIds.has(id))) return;
    const fix = [];
    for (const e of await evAll()) {
      if (e.kind !== 'removed' || e.restored || !here.has(e.id)) continue;
      if (e.playlistId === pid) e.restored = true;
      else { e.kind = 'moved'; e.to = [{ id: pid, title: title || pid }]; e.reclassified = true; }
      fix.push(e);
    }
    if (fix.length) await evPut(fix);
  }

  // ------------------------------------------------------------------
  // Playlist archive (IndexedDB)
  //
  // Every complete read of one of your own playlists is written here: the
  // id, title, length and channel of every video it held at that moment.
  // Three things need it.
  //
  //  1. Room. The snapshots above hold ids only and live in localStorage,
  //     which this script shares with YouTube itself inside one ~5 MB
  //     origin quota — so they were capped at 40 playlists and were the
  //     second thing thrown away when the quota filled. IndexedDB is a
  //     separate, disk-backed store measured in hundreds of megabytes: no
  //     playlist cap, and nothing else the script remembers has to be
  //     evicted to make the snapshot fit. A playlist written here has its
  //     localStorage snapshot deleted, so the quota is handed back.
  //
  //  2. Names for the dead. When YouTube takes a video down, or its owner
  //     makes it private, the entry STAYS in your playlist — as a row
  //     titled "[Deleted video]" with no duration and no channel. At that
  //     point the real title is gone from YouTube for good, so the only
  //     way to know what you lost is to have written it down beforehand.
  //     That is what the archive is: the last metadata that was actually
  //     readable for everything in your playlists, kept so a tombstone can
  //     be given its name back (archiveTrack → openDeadVideos).
  //
  //  3. "What do I already have?" — which of your playlists a video is in.
  //     It tells a move from a deletion (classifyMissing), and it is the
  //     index behind the ✓ marks (v3.37.0: this replaced the separate
  //     localStorage index, which cost 1.3 MB of quota and a rewrite on
  //     every collect).
  //
  // Videos are stored as compact arrays, [id, title, seconds, channel] —
  // roughly 70 bytes each, so a 20,000-video library is under 2 MB. The
  // script's own adds and removals patch the record in between full reads
  // (archivePatch), so the next diff doesn't mistake them for your edits.
  //
  // Every call here degrades to null/false instead of throwing: IndexedDB
  // is unavailable in some private-browsing modes, and callers fall back to
  // the localStorage snapshots when it is.
  // ------------------------------------------------------------------
  const ARCH_DB = 'ycfp-archive';
  const ARCH_VER = 2;
  const ARCH_PL = 'playlists';  // one record per playlist, keyed by pid
  const ARCH_DEAD = 'deaths';   // dead entries awaiting review, keyed "pid|videoId"
  const ARCH_EV = 'events';     // removal / move history, auto-numbered

  let archDbPromise = null;
  function archiveDb() {
    if (archDbPromise) return archDbPromise;
    archDbPromise = new Promise((resolve) => {
      let settled = false;
      const done = (db) => {
        if (settled) { if (db) db.close(); return; }
        settled = true;
        if (!db) archDbPromise = null; // let a later call try again
        resolve(db);
      };
      let req;
      try { req = indexedDB.open(ARCH_DB, ARCH_VER); } catch (e) { done(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ARCH_PL)) db.createObjectStore(ARCH_PL, { keyPath: 'pid' });
        if (!db.objectStoreNames.contains(ARCH_DEAD)) db.createObjectStore(ARCH_DEAD, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(ARCH_EV)) db.createObjectStore(ARCH_EV, { keyPath: 'k', autoIncrement: true });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab running a newer version needs this connection gone
        // before it can upgrade the database — never hold it up.
        db.onversionchange = () => { db.close(); archDbPromise = null; };
        done(db);
      };
      req.onerror = () => {
        console.warn('[YCFP] IndexedDB unavailable — falling back to localStorage snapshots:', req.error);
        done(null);
      };
      // A YouTube tab still running an older version of the script holds
      // the database open at the old version. Reloading that tab lets the
      // upgrade through; until then, this page falls back rather than hangs.
      req.onblocked = () => {
        console.warn('[YCFP] Archive upgrade is waiting for another YouTube tab — reload your other YouTube tabs.');
        setTimeout(() => done(null), 5000);
      };
      // An open that never reports back at all must not hang a scan either.
      setTimeout(() => {
        if (!settled) console.warn('[YCFP] IndexedDB did not open in 15s — falling back to localStorage snapshots.');
        done(null);
      }, 15000);
    });
    return archDbPromise;
  }

  // One IDB request as a promise that resolves to its result and never
  // rejects — a failed read here is a missing snapshot, not something worth
  // aborting a scan for.
  const idbReq = (r) => new Promise((res) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  });

  // Run `fn` against one object store. `fn` may await IDB requests it makes
  // itself (that keeps the transaction alive), but must not await anything
  // else — a macrotask would let the transaction auto-commit underneath it.
  // A transaction that never completes (another tab frozen mid-write, say)
  // gives up after a while and reads as "unavailable", like any other failure.
  const ARCH_OP_TIMEOUT_MS = 20000;
  async function archStore(name, mode, fn) {
    const db = await archiveDb();
    if (!db) return null;
    let timer;
    try {
      return await Promise.race([
        fn(db.transaction(name, mode).objectStore(name)),
        new Promise((res) => {
          timer = setTimeout(() => {
            console.warn(`[YCFP] archive store ${name} (${mode}) did not finish in ${ARCH_OP_TIMEOUT_MS / 1000}s — skipped.`);
            res(null);
          }, ARCH_OP_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      console.warn('[YCFP] archive store', name, e);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const archiveGet = (pid) => archStore(ARCH_PL, 'readonly', (st) => idbReq(st.get(pid)));
  const archivePutRaw = (rec) => archStore(ARCH_PL, 'readwrite', (st) => idbReq(st.put(rec)).then(() => true));
  const archiveAll = () => archStore(ARCH_PL, 'readonly', (st) => idbReq(st.getAll()));
  const archiveClear = () => archStore(ARCH_PL, 'readwrite', (st) => idbReq(st.clear()).then(() => true))
    .then((ok) => { archIdx = null; if (ok) archBusPost({ clear: true }); return ok; });
  const deathsAll = () => archStore(ARCH_DEAD, 'readonly', (st) => idbReq(st.getAll()));
  const deathsClear = () => archStore(ARCH_DEAD, 'readwrite', (st) => idbReq(st.clear()).then(() => true));
  const deathsDrop = (keys) => archStore(ARCH_DEAD, 'readwrite', (st) => {
    for (const k of keys) st.delete(k);
    return Promise.resolve(keys.length);
  });

  async function archivePut(rec) {
    const ok = await archivePutRaw(rec);
    if (ok) { archIdxSet(rec); archBusPost({ pid: rec.pid }); }
    return ok;
  }

  // Tell the other YouTube tabs a playlist was (re)written, so their index —
  // and the ✓ marks drawn from it — catch up at once instead of waiting out
  // the index's max age. Only the id travels; they read the record themselves.
  const archBus = (() => { try { return new BroadcastChannel('ycfp-archive'); } catch (e) { return null; } })();
  function archBusPost(msg) {
    try { if (archBus) archBus.postMessage(msg); } catch (e) { /* ignore */ }
  }
  let archBusPids = new Set(), archBusClear = false, archBusTimer = null;
  if (archBus) {
    archBus.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.clear) archBusClear = true;
      else if (m.pid) archBusPids.add(m.pid);
      else return;
      // A full read writes hundreds of playlists in a row: apply them in batches.
      clearTimeout(archBusTimer);
      archBusTimer = setTimeout(archBusFlush, 400);
    };
  }
  async function archBusFlush() {
    const pids = [...archBusPids], clear = archBusClear;
    archBusPids = new Set(); archBusClear = false;
    if (archIdxLoading) await archIdxLoading;
    if (clear) { archIdx = null; await archIndex(0); return; }
    if (!archIdx) return; // nothing loaded here yet — the first load reads it fresh
    for (const pid of pids) {
      const rec = await archiveGet(pid);
      if (rec) archIdxSet(rec);
    }
  }

  // ---- "which of your playlists is this video in", from the archive ----
  //
  // Built once from every archived playlist (a single getAll — ~20 k rows is
  // a few tens of milliseconds) and kept in step with every write this tab
  // makes. Another tab's writes are picked up when it is rebuilt: callers
  // pass how stale they can live with.
  let archIdx = null;        // { at, byVid: Map(id → Set(pid)), byPid: Map(pid → Set(id)), meta: Map(id → [t,s,c]), titles: Map(pid → title) }
  let archIdxLoading = null;
  let archIdxVerSeq = 0;
  function archIdxEmpty() {
    return { at: Date.now(), byVid: new Map(), byPid: new Map(), meta: new Map(), titles: new Map(), ver: ++archIdxVerSeq };
  }
  function archIdxSet(rec, into = archIdx) {
    if (!into || !rec || !rec.pid) return;
    const old = into.byPid.get(rec.pid);
    if (old) {
      for (const id of old) {
        const s = into.byVid.get(id);
        if (s) { s.delete(rec.pid); if (!s.size) into.byVid.delete(id); }
      }
    }
    const ids = new Set();
    for (const r of rec.v || []) {
      if (!Array.isArray(r) || !r[0]) continue;
      ids.add(r[0]);
      const s = into.byVid.get(r[0]);
      if (s) s.add(rec.pid); else into.byVid.set(r[0], new Set([rec.pid]));
      if (r[1] && !into.meta.has(r[0])) into.meta.set(r[0], [r[1], r[2] || 0, r[3] || '']);
    }
    into.byPid.set(rec.pid, ids);
    into.titles.set(rec.pid, rec.title || rec.pid);
    // Never reused, even across rebuilds: the ✓ marks stamp rows with it,
    // and a rebuilt index landing on an old number would leave them stale.
    into.ver = ++archIdxVerSeq;
  }
  async function archIndex(maxAgeMs = 10 * 60 * 1000) {
    if (archIdx && Date.now() - archIdx.at < maxAgeMs) return archIdx;
    if (!archIdxLoading) {
      archIdxLoading = (async () => {
        try {
          const all = await archiveAll();
          const idx = archIdxEmpty();
          if (Array.isArray(all)) for (const rec of all) archIdxSet(rec, idx);
          idx.ok = Array.isArray(all);
          archIdx = idx;
          return idx;
        } catch (e) {
          // One malformed record must not wedge every later caller on a
          // rejected promise — hand back an empty (not-ok) index instead.
          console.warn('[YCFP] archive index', e);
          const idx = archIdxEmpty();
          idx.ok = false;
          return idx;
        } finally {
          archIdxLoading = null;
        }
      })();
    }
    return archIdxLoading;
  }
  // Your other playlists (not `pid`) the archive says hold this video.
  const archWhereElse = (idx, id, pid) => (idx && idx.byVid.get(id)
    ? [...idx.byVid.get(id)].filter((p) => p !== pid).map((p) => ({ id: p, title: idx.titles.get(p) || p }))
    : []);
  const archMeta = (idx, id) => (idx && idx.meta.get(id)) || ['', 0, ''];

  // Keep the archive in step with the script's own edits between full reads:
  // a video it added is "in" the playlist (so removing it by hand later is
  // noticed), one it removed is not (so the next diff doesn't count it again).
  // Serialized — two quick clicks must not race a read-modify-write.
  let archPatchChain = Promise.resolve();
  function archivePatch(pid, title, addVideos, dropIds) {
    if (!pid || !/^(PL|LL|WL|FL)/.test(pid)) return archPatchChain;
    archPatchChain = archPatchChain.then(async () => {
      if (!(await archiveDb())) return;
      let rec = await archiveGet(pid);
      if (!rec) {
        if (!addVideos || !addVideos.length) return;
        rec = { pid, title: title || pid, ts: 0, n: 0, v: [], partial: true };
      }
      const drop = new Set(dropIds || []);
      const have = new Set();
      const v = [];
      for (const r of rec.v || []) {
        if (drop.has(r[0])) continue;
        v.push(r);
        have.add(r[0]);
      }
      const idx = archIdx;
      for (const a of addVideos || []) {
        const id = typeof a === 'string' ? a : a.id;
        if (!id || have.has(id)) continue;
        have.add(id);
        const m = typeof a === 'string' ? archMeta(idx, id) : [a.title || '', a.seconds || 0, a.channel || ''];
        v.push([id, m[0] || '', m[1] || 0, m[2] || '']);
      }
      rec.v = v;
      rec.n = v.length;
      if (title && !rec.title) rec.title = title;
      await archivePut(rec);
    }).catch((e) => console.warn('[YCFP] archive patch', e));
    return archPatchChain;
  }

  // ---- the history ("events") store ----
  let evMigrated = null;
  // One-time import: the old localStorage journal, plus ledger rows that no
  // journal row explains (deletions noticed by a diff were never journalled
  // before v3.37.0 — they only existed in the ledger).
  function evMigrate() {
    if (evMigrated) return evMigrated;
    evMigrated = (async () => {
      const db = await archiveDb();
      if (!db) return false;
      const FLAG = 'ycfp-events-migrated-v1';
      let already = false;
      try { already = !!localStorage.getItem(FLAG); } catch (e) { already = false; }
      const old = loadRemovalLog();
      if (already && !old.length) return true;
      // Claim the import before the (async) write, so a second YouTube tab
      // loading at the same moment finds nothing left to import twice.
      try { localStorage.removeItem(LOG_KEY); } catch (e) { /* ignore */ }
      lsSet(FLAG, '1');
      const rows = old.map((e) => Object.assign({}, e, {
        kind: e.kind || (e.src === 'move' ? 'moved' : 'removed'), to: e.to || [],
      }));
      const journalled = new Set(old.map((e) => e.id));
      // Rows written to localStorage while IndexedDB was unavailable come
      // through again later — the ledger import is for the first time only.
      for (const [id, g] of Object.entries(already ? {} : loadGone())) {
        if (journalled.has(id)) continue;
        const p = String(g.p || '');
        rows.push({
          t: g.ts || 0, src: 'detected', kind: 'removed', id,
          title: g.t || '', channel: g.c || '', seconds: g.s || 0,
          playlistId: g.pid || (/^(PL|LL|WL|FL)[\w-]{8,}$/.test(p) ? p : ''),
          playlistTitle: p, to: [], legacy: true,
        });
      }
      rows.sort((a, b) => (a.t || 0) - (b.t || 0));
      const ok = await archStore(ARCH_EV, 'readwrite', (st) => {
        for (const r of rows) st.add(r);
        return Promise.resolve(true);
      });
      if (!ok) {
        // Put everything back where it was; the next page load retries.
        if (old.length) saveRemovalLog(old);
        if (!already) { try { localStorage.removeItem(FLAG); } catch (e) { /* ignore */ } }
        evMigrated = null;
        return false;
      }
      return true;
    })();
    return evMigrated;
  }

  let evIdCache = null; // Set of video ids with a live "removed" row
  async function evAll() {
    if (!(await evMigrate())) {
      return loadRemovalLog().map((e, i) => Object.assign({ k: 'ls' + i }, e, {
        kind: e.kind || (e.src === 'move' ? 'moved' : 'removed'), to: e.to || [],
      }));
    }
    return (await archStore(ARCH_EV, 'readonly', (st) => idbReq(st.getAll()))) || [];
  }
  async function evAdd(rows) {
    if (!rows.length) return;
    if (!(await evMigrate())) {
      const l = loadRemovalLog();
      for (const r of rows) l.push(r);
      saveRemovalLog(l);
    } else {
      await archStore(ARCH_EV, 'readwrite', (st) => {
        for (const r of rows) st.add(r);
        return Promise.resolve(true);
      });
    }
    if (evIdCache) for (const r of rows) if (r.kind === 'removed') evIdCache.add(r.id);
  }
  // Rewrite rows in place (they carry their key `k`).
  async function evPut(rows) {
    if (!rows.length) return;
    if (!(await evMigrate())) {
      const l = loadRemovalLog();
      for (const r of rows) {
        const i = typeof r.k === 'string' && r.k.startsWith('ls') ? parseInt(r.k.slice(2), 10) : -1;
        if (i >= 0 && l[i]) { const c = Object.assign({}, r); delete c.k; l[i] = c; }
      }
      saveRemovalLog(l);
    } else {
      await archStore(ARCH_EV, 'readwrite', (st) => {
        for (const r of rows) st.put(r);
        return Promise.resolve(true);
      });
    }
    evIdCache = null;
  }
  async function evDelete(keys) {
    if (!keys.length) return;
    if (!(await evMigrate())) {
      const drop = new Set(keys);
      saveRemovalLog(loadRemovalLog().filter((e, i) => !drop.has('ls' + i)));
    } else {
      await archStore(ARCH_EV, 'readwrite', (st) => {
        for (const k of keys) st.delete(k);
        return Promise.resolve(true);
      });
    }
    evIdCache = null;
  }
  async function evRemovedIds() {
    if (!evIdCache) {
      const s = new Set();
      for (const e of await evAll()) if (e.kind === 'removed' && !e.restored) s.add(e.id);
      evIdCache = s;
    }
    return evIdCache;
  }

  // How many dead entries are waiting to be reviewed. Held in a variable so
  // the floating button, which is re-checked every two seconds, can show the
  // count without touching the database.
  let deadPending = 0;
  async function refreshDeadCount() {
    const rows = await deathsAll();
    const cfg = loadCfg();
    deadPending = Array.isArray(rows) ? rows.filter((r) => deadTracked(r.pid, cfg)).length : 0;
    return deadPending;
  }

  // The excluded playlists (⚙ settings) are your defaults. With any set,
  // dead videos are only tracked in those; with none, in every playlist.
  const defaultPlaylistIds = (cfg = loadCfg()) =>
    new Set((cfg.excludePlaylists || []).map(parsePlaylistId).filter(Boolean));
  const deadTracked = (pid, cfg = loadCfg()) => {
    const ids = defaultPlaylistIds(cfg);
    return !ids.size || ids.has(pid);
  };

  // What a playlist row looks like once the video behind it is gone. The
  // wording is YouTube's and is localized, so isPlayable:false (set in
  // extractVideos) is the signal that actually carries; the titles are
  // matched too because the newer lockup UI does not expose isPlayable.
  // A genuine upload called "Deleted Video" would still have a duration,
  // and requiring the duration to be absent keeps it out of the report.
  const DEAD_TITLE_RE = /^[[(\s]*(deleted|private|unavailable|removed|unlisted)\s+video[\])\s]*$/i;
  function deadKind(v) {
    if (!v) return null;
    const m = String(v.title || '').trim().match(DEAD_TITLE_RE);
    if (m && !(v.seconds > 0)) return m[1].toLowerCase();
    return v.dead ? (m ? m[1].toLowerCase() : 'unavailable') : null;
  }

  // Write this read of `pid` into the archive and diff it against the last
  // one. Returns true when the archive handled it — the caller then skips
  // the localStorage snapshot entirely — and false when IndexedDB is
  // unusable, so the old path still runs.
  async function archiveTrack(pid, title, videos, log) {
    if (!pid || !Array.isArray(videos) || !videos.length) return false;
    if (!(await archiveDb())) return false;
    await archPatchChain; // let pending patches land first

    const prev = await archiveGet(pid);
    const prevMap = new Map();
    if (prev && Array.isArray(prev.v)) for (const r of prev.v) prevMap.set(r[0], r);
    // First archived read of a playlist that already had a localStorage
    // snapshot: carry those ids across so this run still diffs against them
    // rather than starting blind and silently forgiving a deletion.
    if (!prev) {
      const s = loadSnaps()[pid];
      if (s && Array.isArray(s.ids)) {
        for (const id of s.ids) if (!prevMap.has(id)) prevMap.set(id, [id, '', 0, '']);
      }
    }

    // Each row keeps the last metadata that was actually readable: once an
    // entry has turned into a tombstone, overwriting its row with
    // "[Deleted video]" would throw away the one thing this exists to hold.
    const rows = [];
    const found = [];
    const rowSeen = new Set();
    for (const v of videos) {
      if (rowSeen.has(v.id)) continue; // a keepDupes read lists copies separately
      rowSeen.add(v.id);
      const old = prevMap.get(v.id);
      const oldTitle = old && old[1] && !DEAD_TITLE_RE.test(String(old[1]).trim()) ? old[1] : '';
      const kind = deadKind(v);
      if (!kind) {
        rows.push([v.id, v.title || '', v.seconds || 0, v.channel || '']);
        continue;
      }
      rows.push([v.id, oldTitle, (old && old[2]) || 0, (old && old[3]) || '']);
      found.push({
        key: `${pid}|${v.id}`, id: v.id, kind, pid, playlistTitle: title || pid,
        title: oldTitle, seconds: (old && old[2]) || 0, channel: (old && old[3]) || '',
        setVideoId: v.setVideoId || null, copies: v.copies || 1,
      });
    }

    // Write first, diff second: the diff asks "is it in another of your
    // playlists?", and this playlist's fresh contents are part of the answer
    // for every OTHER playlist's diff from now on.
    const ok = await archivePut({ pid, title: title || pid, ts: Date.now(), n: videos.length, v: rows });
    const nowSet = new Set(videos.map((v) => v.id));
    if (prevMap.size) await classifyMissing(pid, title, prevMap, nowSet, log);
    if (ok) {
      // The localStorage snapshot is dead weight now — the archive holds
      // strictly more, and handing those bytes back is half the point.
      const snaps = loadSnaps();
      if (snaps[pid]) { delete snaps[pid]; saveSnaps(snaps); }
    } else {
      // The write failed (a disk quota, most likely) but the diff above has
      // already run, so the caller must NOT fall back to trackPlaylistSnapshot
      // and diff the same read a second time. Leave a localStorage snapshot
      // behind instead: the next archived read seeds its "before" from there.
      log('⚠ The playlist archive could not be written — falling back to the small localStorage snapshot '
        + 'for this playlist, which records ids only (no titles to name a deleted video with).');
      const snaps = loadSnaps();
      snaps[pid] = { ts: Date.now(), title: title || pid, ids: [...nowSet] };
      saveSnaps(snaps);
    }
    if (found.length && deadTracked(pid)) await recordDeaths(found, log);
    await clearRevived(pid, title, videos, found, log);
    // Handled either way: the diff has been done exactly once.
    return true;
  }

  // Merge freshly-spotted tombstones into the pending review list. One that
  // is already recorded keeps its first-seen date and whatever metadata was
  // recovered back then, which a later read can no longer supply.
  async function recordDeaths(found, log) {
    // A playlist read sometimes serves live videos as tombstone rows; 44
    // perfectly playable songs were once listed as "deleted" that way. Only
    // what the player itself confirms gone is recorded.
    const alive = await aliveAmong(found.map((d) => d.id));
    if (alive.size) {
      log(`${alive.size} entr${alive.size === 1 ? 'y' : 'ies'} looked deleted in the playlist read but still play — not listed as dead.`);
      found = found.filter((d) => !alive.has(d.id));
      if (!found.length) return;
    }
    const now = Date.now();
    const existing = new Map();
    const olds = await deathsAll();
    if (Array.isArray(olds)) for (const o of olds) existing.set(o.key, o);
    const fresh = [];
    const recs = found.map((d) => {
      const old = existing.get(d.key);
      if (!old) fresh.push(d);
      return Object.assign({}, old || {}, d, {
        title: d.title || (old && old.title) || '',
        seconds: d.seconds || (old && old.seconds) || 0,
        channel: d.channel || (old && old.channel) || '',
        firstSeen: (old && old.firstSeen) || now,
        lastSeen: now,
      });
    });
    await archStore(ARCH_DEAD, 'readwrite', (st) => {
      for (const r of recs) st.put(r);
      return Promise.resolve(true);
    });
    await refreshDeadCount();
    if (!fresh.length) return;
    const named = fresh.filter((d) => d.title);
    const shown = named.slice(0, 6).map((d) => `"${d.title}"${d.channel ? ` — ${d.channel}` : ''}`);
    const more = named.length - shown.length;
    const unnamed = fresh.length - named.length;
    log(`⚠ "${fresh[0].playlistTitle}": ${fresh.length} video(s) have been deleted or made private on YouTube`
      + (shown.length ? ` — ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}` : '')
      + (unnamed ? ` (${unnamed} with no recorded name: already gone the first time this playlist was archived)` : '')
      + '. They are still sitting in the playlist — "🪦 Dead videos" reviews and removes them.');
  }

  // Ids among `ids` that videoAlive() says still play (a few at a time).
  async function aliveAmong(ids) {
    const alive = new Set();
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += 6) {
      const part = uniq.slice(i, i + 6);
      const res = await Promise.all(part.map((id) => videoAlive(id)));
      part.forEach((id, j) => { if (res[j]) alive.add(id); });
    }
    return alive;
  }

  // A pending death whose video this complete read of `pid` found playable
  // again is taken off the 🪦 list. YouTube occasionally serves a playlist
  // page with live videos as "[Deleted video]" rows; without this, one such
  // read left them listed as dead for good.
  async function clearRevived(pid, title, videos, found, log) {
    const stillDead = new Set(found.map((d) => d.id));
    const alive = new Set(videos.filter((v) => !stillDead.has(v.id)).map((v) => v.id));
    const olds = await deathsAll();
    if (!Array.isArray(olds)) return;
    const keys = olds.filter((o) => o.pid === pid && alive.has(o.id)).map((o) => o.key);
    if (!keys.length) return;
    await deathsDrop(keys);
    await refreshDeadCount();
    log(`"${title || pid}": ${keys.length} video(s) on the 🪦 dead list are playable again — taken off it.`);
  }

  // Size of the archive, for the settings dialog.
  async function archiveStats() {
    const all = await archiveAll();
    if (!Array.isArray(all)) return null;
    let videos = 0;
    let bytes = 0;
    for (const r of all) {
      videos += (r.v && r.v.length) || 0;
      for (const row of r.v || []) {
        bytes += 2 * (24 + String(row[1] || '').length + String(row[3] || '').length);
      }
    }
    return { playlists: all.length, videos, bytes };
  }

  // Matching sets for the ledger, shaped like the exclusion sets so the
  // collect pipeline can use them the same way. Cached until the ledger or
  // the matching options change.
  let goneSetsCache = null;
  function buildGoneSets(cfg) {
    const key = `${goneVersion}|${!!cfg.dedupeByTitleDuration}|${!!cfg.fuzzyCollect}`;
    if (goneSetsCache && goneSetsCache.key === key) return goneSetsCache.data;
    const gone = loadGone();
    const goneIds = new Set(Object.keys(gone));
    const goneKeys = new Set();
    const goneFuzz = new Map();
    for (const [id, g] of Object.entries(gone)) {
      if (!g.t || !(g.s > 0)) continue;
      if (cfg.dedupeByTitleDuration) goneKeys.add(normTitle(g.t) + '|' + g.s);
      if (cfg.fuzzyCollect) fuzzBucketAdd(goneFuzz, g.s, titleVariants(g.t, g.c));
    }
    const data = { goneIds, goneKeys, goneFuzz };
    goneSetsCache = { key, data };
    return data;
  }

  // True when this video is one you deliberately removed before. Tolerates an
  // exclusion object built without ledger sets (callers that opt out).
  function goneHit(excl, v, cfg) {
    if (!cfg.skipDeleted || !excl || !excl.goneIds || !excl.goneIds.size) return false;
    if (excl.goneIds.has(v.id)) return true;
    if (cfg.dedupeByTitleDuration && titleDurationHit(excl.goneKeys, v.title, v.seconds)) return true;
    if (cfg.fuzzyCollect && v.seconds > 0 && excl.goneFuzz && excl.goneFuzz.size
      && fuzzBucketHit(excl.goneFuzz, titleVariants(v.title, v.channel), v.seconds)) return true;
    return false;
  }

  // Re-add previously removed entries to the playlists they came from
  // (at the end — original positions can't be restored).
  async function undoRemovals(entries, cfg, log, guard) {
    forgetDeleted(entries.map((e) => e.id));
    const byPl = new Map();
    for (const e of entries) {
      const arr = byPl.get(e.playlistId);
      if (arr) arr.push(e); else byPl.set(e.playlistId, [e]);
    }
    let restored = 0;
    for (const [pl, list] of byPl) {
      if (guard) guard();
      // One add per record: each record is one physical entry that was
      // removed, so de-duplicating the ids here would restore too few.
      const ids = list.map((e) => e.id);
      for (let i = 0; i < ids.length; i += cfg.batchSize) {
        const res = await api('browse/edit_playlist', {
          playlistId: pl,
          actions: ids.slice(i, i + cfg.batchSize)
            .map((id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id })),
        });
        if (res.status && res.status !== 'STATUS_SUCCEEDED') {
          throw new Error(`undo batch returned ${res.status}`);
        }
        await sleep(cfg.batchDelayMs);
      }
      restored += ids.length;
      archivePatch(pl, list[0].playlistTitle || '', list, []);
      log(`${list[0].playlistTitle || pl}: restored ${ids.length} videos (added at the end).`);
    }
    invalidateExclCache();
    return restored;
  }

  // Remove the given entries. Prefers per-entry removal (setVideoId).
  //
  // Without a handle the only available action is REMOVE_VIDEO_BY_VIDEO_ID,
  // which wipes EVERY copy of that video in the playlist — including copies
  // the caller meant to keep. It used to compensate by re-adding a single
  // copy whenever any same-id entry was kept, so keeping two of three copies
  // silently lost one. Now the survivors are counted (`copies` per entry) and
  // exactly that many are put back, and only the copies that really
  // disappeared are journalled, so Undo restores the right number.
  async function executeRemovals(toRemove, kept, cfg, log, guard, src = 'dedupe', to = null) {
    const byPl = new Map();
    for (const e of toRemove) {
      const arr = byPl.get(e.playlistId);
      if (arr) arr.push(e); else byPl.set(e.playlistId, [e]);
    }
    let removed = 0;
    const allFailed = new Set();
    // One record per physical copy actually removed — what Undo must re-add.
    const allRemoved = [];
    for (const [pl, list] of byPl) {
      if (guard) guard();
      const actions = [];
      const reAdd = [];
      const netCopies = new Map(); // entry → physical copies actually lost
      const byVid = new Map();
      for (const e of list) {
        const arr = byVid.get(e.id);
        if (arr) arr.push(e); else byVid.set(e.id, [e]);
      }
      for (const [vid, es] of byVid) {
        if (es.every((e) => e.setVideoId)) {
          for (const e of es) {
            actions.push({ payload: { action: 'ACTION_REMOVE_VIDEO', setVideoId: e.setVideoId, removedVideoId: e.id }, entries: [e] });
          }
        } else {
          actions.push({ payload: { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: vid }, entries: es });
          // Everything with this id goes; put back one copy per copy kept.
          let keepCount = 0;
          for (const k of kept) {
            if (k.playlistId === pl && k.id === vid) keepCount += (k.copies || 1);
          }
          for (let n = 0; n < keepCount; n++) reAdd.push(vid);
          let losing = es.reduce((n, e) => n + (e.copies || 1), 0) - keepCount;
          for (const e of es) {
            const share = Math.max(0, Math.min(e.copies || 1, losing));
            netCopies.set(e, share);
            losing -= share;
          }
        }
      }

      const failed = new Set();
      const runOne = async (payload) => {
        const res = await api('browse/edit_playlist', { playlistId: pl, actions: [payload] });
        if (res.status && res.status !== 'STATUS_SUCCEEDED') throw new Error(`status ${res.status}`);
      };

      for (let i = 0; i < actions.length; i += cfg.batchSize) {
        if (guard) guard();
        const chunk = actions.slice(i, i + cfg.batchSize);
        try {
          const res = await api('browse/edit_playlist', {
            playlistId: pl, actions: chunk.map((a) => a.payload),
          });
          if (res.status && res.status !== 'STATUS_SUCCEEDED') throw new Error(`status ${res.status}`);
        } catch (e) {
          // Whole batch rejected (e.g. one bad setVideoId poisons it) —
          // retry entry by entry so only the actual offenders are skipped.
          log(`⚠ Removal batch failed (${e.message || e}) — retrying one by one…`);
          for (const a of chunk) {
            if (guard) guard();
            try {
              await runOne(a.payload);
            } catch (e2) {
              // Stale per-entry handle → fall back to remove-by-video-id.
              let recovered = false;
              if (a.payload.action === 'ACTION_REMOVE_VIDEO') {
                try {
                  await runOne({ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: a.entries[0].id });
                  log(`⚠ "${a.entries[0].title || a.entries[0].id}": stale entry handle — removed by video id (all copies in this playlist).`);
                  recovered = true;
                } catch (e3) { /* reported below */ }
              }
              if (!recovered) {
                for (const en of a.entries) failed.add(en);
                log(`⚠ Could not remove "${a.entries[0].title || a.entries[0].id}" — skipped (${e2.message || e2}).`);
              }
            }
            await sleep(cfg.batchDelayMs);
          }
        }
        await sleep(cfg.batchDelayMs);
      }

      if (reAdd.length) {
        log(`${list[0].playlistTitle}: re-adding ${reAdd.length} kept cop${reAdd.length === 1 ? 'y' : 'ies'} at the end of the playlist (no per-entry handle was available, so removal had to take every copy).`);
        for (let i = 0; i < reAdd.length; i += cfg.batchSize) {
          await api('browse/edit_playlist', {
            playlistId: pl,
            actions: reAdd.slice(i, i + cfg.batchSize)
              .map((id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id })),
          });
          await sleep(cfg.batchDelayMs);
        }
      }

      const okList = list.filter((e) => !failed.has(e));
      removed += okList.length;
      for (const e of failed) allFailed.add(e);
      log(`${list[0].playlistTitle}: removed ${okList.length} entries${failed.size ? ` (${failed.size} failed)` : ''}.`);
      // Journal one record per physical copy that is really gone, so Undo
      // re-adds the same number it took away.
      const journal = [];
      for (const e of okList) {
        const n = netCopies.has(e) ? netCopies.get(e) : (e.copies || 1);
        for (let k = 0; k < n; k++) journal.push(e);
      }
      journalRemovals(journal, src, to);
      archivePatch(pl, list[0].playlistTitle || '', [], okList.map((e) => e.id));
      for (const e of journal) allRemoved.push(e);
    }
    invalidateExclCache();
    return { removed, failed: allFailed, removedCopies: allRemoved };
  }

  // ------------------------------------------------------------------
  // Dialog UI (Trusted-Types safe, adaptive to YouTube's theme)
  // ------------------------------------------------------------------
  const CSS = `
    .ycfp-chip { display: inline-flex; align-items: center; margin-left: 8px; padding: 0 12px;
      height: 32px; align-self: center; border-radius: 8px; cursor: pointer; white-space: nowrap;
      font-family: Roboto, Arial, sans-serif; font-size: 1.4rem; font-weight: 500; user-select: none;
      background: var(--yt-spec-additive-background, rgba(255,255,255,.1));
      color: var(--yt-spec-text-primary, #f1f1f1);
      border: 2px solid #890097; box-sizing: border-box; }
    .ycfp-chip:hover { background: var(--yt-spec-touch-response, rgba(255,255,255,.2)); }
    .ycfp-chip-noexcl { border-color: #c47612; }
    /* hide accidental duplicates from injection races, per variant */
    .ycfp-chip-excl ~ .ycfp-chip-excl { display: none; }
    .ycfp-chip-noexcl ~ .ycfp-chip-noexcl { display: none; }

    #ycfp-float { position: fixed; right: 16px; bottom: 90px; z-index: 2147483645;
      display: flex; flex-direction: column; gap: 6px; align-items: flex-end;
      font-family: Roboto, Arial, sans-serif; }
    .ycfp-float-btn { background: #890097; color: #fff; border: 0; border-radius: 18px;
      padding: 9px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,.4); }
    .ycfp-float-btn:hover { background: #b247cc; }
    .ycfp-float-btn.ycfp-gear { padding: 9px 11px; background: #333; }
    .ycfp-float-btn.ycfp-gear:hover { background: #555; }
    .ycfp-float-btn.ycfp-float-alt { background: #c47612; }
    .ycfp-float-btn.ycfp-float-alt:hover { background: #e89a3c; }
    .ycfp-float-btn.ycfp-float-dedupe { background: #1b7f3b; }
    .ycfp-float-btn.ycfp-float-dedupe:hover { background: #26a34d; }
    .ycfp-float-btn.ycfp-float-multi { background: #3949ab; }
    .ycfp-float-btn.ycfp-float-multi:hover { background: #5261c7; }
    .ycfp-float-btn.ycfp-float-shorts { background: #a13333; }
    .ycfp-float-btn.ycfp-float-shorts:hover { background: #c44d4d; }
    .ycfp-float-btn.ycfp-float-rmch { background: #8a4b12; }
    .ycfp-float-btn.ycfp-float-rmch:hover { background: #b3661f; }
    .ycfp-float-btn.ycfp-float-ns { background: #00707d; }
    .ycfp-float-btn.ycfp-float-ns:hover { background: #0e93a3; }
    .ycfp-float-btn.ycfp-float-bp { background: #6a3fb0; }
    .ycfp-float-btn.ycfp-float-bp:hover { background: #8352d6; }
    .ycfp-float-btn.ycfp-float-bd { background: #96590a; }
    .ycfp-float-btn.ycfp-float-bd:hover { background: #c1770f; }
    .ycfp-float-btn.ycfp-float-pb { background: #0b6e6e; }
    .ycfp-float-btn.ycfp-float-pb:hover { background: #10908f; }
    .ycfp-float-btn.ycfp-float-binge { background: #1565c0; }
    .ycfp-float-btn.ycfp-float-binge:hover { background: #1e7ae0; }
    .ycfp-float-btn.ycfp-float-unav { background: #5d4037; }
    .ycfp-float-btn.ycfp-float-unav:hover { background: #7b5a4d; }
    .ycfp-float-btn.ycfp-float-dead { background: #8a1f2e; }
    .ycfp-float-btn.ycfp-float-dead:hover { background: #b52a3c; }
    .ycfp-float-btn.ycfp-collapse { background: #333; padding: 6px 12px; font-size: 12px; }
    .ycfp-float-btn.ycfp-collapse:hover { background: #555; }
    #ycfp-float.ycfp-collapsed .ycfp-float-btn:not(.ycfp-collapse) { display: none; }

    .ycfp-dialog { border: none; border-radius: 12px; padding: 16px; width: min(92vw, 560px);
      background: var(--yt-spec-menu-background, #282828);
      color: var(--yt-spec-text-primary, #f1f1f1);
      font-family: Roboto, Arial, sans-serif; font-size: 14px; }
    .ycfp-dialog::backdrop { background: rgba(0,0,0,.7); }
    .ycfp-head { display: flex; align-items: center; margin-bottom: 10px; }
    .ycfp-title { flex: 1; font-size: 18px; font-weight: 600; }
    .ycfp-x { background: none; border: 0; color: inherit; font-size: 24px; cursor: pointer; line-height: 1; }
    .ycfp-body label { display: block; margin: 8px 0 3px; }
    .ycfp-body select, .ycfp-body input[type="text"], .ycfp-body textarea {
      width: 100%; box-sizing: border-box; padding: 6px; border-radius: 6px;
      border: 1px solid #555; background: var(--yt-spec-badge-chip-background, #1a1a1a);
      color: inherit; font-size: 13px; }
    .ycfp-body textarea { height: 80px; font-family: Consolas, monospace; font-size: 12px; }
    .ycfp-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .ycfp-btn { background: #890097; color: #fff; border: 0; border-radius: 6px;
      padding: 7px 12px; font-weight: 600; cursor: pointer; font-size: 13px; }
    .ycfp-btn:hover { background: #b247cc; }
    .ycfp-btn.ycfp-secondary { background: #444; }
    .ycfp-btn.ycfp-secondary:hover { background: #666; }
    .ycfp-log { margin-top: 12px; max-height: 200px; overflow-y: auto; background: #000;
      border-radius: 6px; padding: 8px; font-family: Consolas, monospace; font-size: 11px;
      color: #ddd; white-space: pre-wrap; display: none; }
    .ycfp-log a { color: #3ea6ff; }
    .ycfp-check { display: flex; align-items: center; gap: 6px; margin: 8px 0; }
    .ycfp-body label.ycfp-check { display: flex; cursor: pointer; }
    .ycfp-check input { width: auto; }

    .ycfp-qa { position: absolute; right: 4px; top: 4px; z-index: 100;
      display: flex; gap: 4px; }
    .ycfp-qa.ycfp-qa-header { position: static; padding: 6px 10px; }
    .ycfp-float-btn.ycfp-float-lib { background: #c2185b; }
    .ycfp-float-btn.ycfp-float-lib:hover { background: #e0457b; }
    .ycfp-rate { display: inline-flex; flex-direction: column; gap: 2px; padding: 2px 4px;
      background: rgba(20,20,20,.85); border-radius: 7px; box-shadow: 0 1px 4px rgba(0,0,0,.5); }
    .ycfp-rate-row { display: flex; gap: 2px; align-items: center; }
    .ycfp-rate button { min-width: 20px; height: 18px; border: 0; border-radius: 5px; padding: 0 4px;
      background: #3a3a3a; color: #ddd; font: 700 11px/18px Roboto, Arial, sans-serif; cursor: pointer; }
    .ycfp-rate button:hover { filter: brightness(1.4); }
    .ycfp-rate .ycfp-rate-cat.ycfp-on { color: #fff; background: var(--ycfp-c, #890097); }
    .ycfp-rate .ycfp-rate-cat.ycfp-pending { outline: 1px dashed #fff; }
    .ycfp-rate .ycfp-rate-cat[data-c="song"] { --ycfp-c: #d63a6f; }
    .ycfp-rate .ycfp-rate-cat[data-c="music"] { --ycfp-c: #3a7bd6; }
    .ycfp-rate .ycfp-rate-cat[data-c="relax"] { --ycfp-c: #2f9e86; }
    .ycfp-rate .ycfp-rate-cat[data-c="slow"] { --ycfp-c: #8a62d6; }
    .ycfp-rate .ycfp-rate-cat[data-c="electric"] { --ycfp-c: #0ea5c6; }
    .ycfp-rate .ycfp-rate-cat[data-c="classical"] { --ycfp-c: #a07a2c; }
    .ycfp-rate .ycfp-rate-cat[data-c="pop"] { --ycfp-c: #e0569b; }
    .ycfp-rate .ycfp-rate-cat[data-c="rock"] { --ycfp-c: #c4452b; }
    .ycfp-rate .ycfp-rate-cat[data-c="epic"] { --ycfp-c: #b8401f; }
    .ycfp-rate .ycfp-rate-cat[data-c="minecraft"] { --ycfp-c: #4f9a32; }
    .ycfp-rate .ycfp-rate-cat[data-c="hololive"] { --ycfp-c: #2fa7e8; }
    .ycfp-rate .ycfp-rate-star { background: transparent; color: #666; font-size: 14px; min-width: 15px; padding: 0 1px; }
    .ycfp-rate .ycfp-rate-star.ycfp-on { color: #ffc23d; }
    .ycfp-rate .ycfp-rate-fl { margin-left: 3px; }
    .ycfp-rate .ycfp-rate-fl.ycfp-on { background: #6b4f00; color: #ffd36b; }
    .ycfp-rate.ycfp-busy { opacity: .5; pointer-events: none; }
    .ycfp-rate.ycfp-rate-off { opacity: .35; }
    .ycfp-rate.ycfp-rate-mini button { height: 15px; min-width: 15px; font-size: 9px; line-height: 15px; padding: 0 3px; }
    .ycfp-rate.ycfp-rate-mini .ycfp-rate-star { font-size: 11px; }
    .ycfp-qa.ycfp-qa-solo { position: static; display: inline-flex; margin: 0 8px 6px 0; }
    .ycfp-qa-btn { min-width: 26px; height: 26px; border: 0; border-radius: 6px;
      background: #890097; color: #fff; font-size: 13px; font-weight: 700;
      cursor: pointer; padding: 0 7px; line-height: 1;
      box-shadow: 0 1px 4px rgba(0,0,0,.5); }
    .ycfp-qa-btn.ycfp-qa-x { background: #b33; }
    .ycfp-qa-btn:hover:not(:disabled) { filter: brightness(1.35); }
    .ycfp-qa-btn:disabled { cursor: default; }
    .ycfp-qa-btn.ycfp-qa-in { background: #1b5e20; }
    .ycfp-qa-btn.ycfp-qa-toggle { background: #444; }
    .ycfp-qa-btn.ycfp-qa-toggle.ycfp-on { background: #1b7f3b; }
    .ycfp-qa-btn.ycfp-jump { background: #444; align-self: center; margin-right: 4px;
      font-size: 15px; }
    .ycfp-qa-mini { opacity: 0; transition: opacity .12s; }
    ytd-playlist-panel-video-renderer:hover .ycfp-qa-mini { opacity: 1; }
    .ycfp-qa-mini .ycfp-qa-btn { min-width: 20px; height: 20px; font-size: 11px; padding: 0 5px; }
    /* /playlist page rows: vertically centered, left of the ⋮ menu */
    .ycfp-qa.ycfp-qa-pl { right: 44px; top: 50%; transform: translateY(-50%); }
    ytd-playlist-video-renderer:hover .ycfp-qa-pl { opacity: 1; }
    ytd-playlist-panel-video-renderer.ycfp-removed,
    ytd-playlist-video-renderer.ycfp-removed { opacity: 0.4; }
    .ycfp-qa-btn.ycfp-jump.ycfp-on { background: #1b7f3b; }
    .ycfp-bulk-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      padding: 6px 10px; border-bottom: 1px solid #444; font-size: 12px;
      color: var(--yt-spec-text-primary, #fff); }
    .ycfp-bulk-bar .ycfp-qa-btn { height: 24px; font-size: 12px; box-shadow: none; }
    .ycfp-bulk-bar .ycfp-qa-btn:disabled { opacity: .45; }
    .ycfp-bulk-count { font-weight: 700; min-width: 70px; }
    .ycfp-bulk-target { max-width: 170px; height: 24px; border-radius: 6px; border: 1px solid #555;
      background: var(--yt-spec-badge-chip-background, #1a1a1a); color: inherit; font-size: 12px; }
    .ycfp-bulk-status { flex-basis: 100%; opacity: .8; }
    .ycfp-bulk-status:empty { display: none; }
    .ycfp-bulk-bar.ycfp-bulk-page { position: sticky; top: var(--ytd-masthead-height, 56px); z-index: 20;
      background: var(--yt-spec-base-background, #0f0f0f); border-radius: 8px; font-size: 13px; }
    .ycfp-bulk-row { cursor: pointer; }
    .ycfp-bulk-row::before { content: '☐'; position: absolute;
      left: 2px; top: 50%; transform: translateY(-50%); z-index: 5; font-size: 15px; opacity: .7; }
    .ycfp-bulk-row.ycfp-sel { background: rgba(62,166,255,.18); }
    .ycfp-bulk-row.ycfp-sel::before { content: '☑'; opacity: 1; color: #3ea6ff; }
    ytd-playlist-video-renderer.ycfp-bulk-row::before, yt-lockup-view-model.ycfp-bulk-row::before { font-size: 18px; }
    .ycfp-float-btn.ycfp-float-bulk.ycfp-on { background: #1b7f3b; }

    .ycfp-dialog-wide { width: min(94vw, 760px); }
    .ycfp-body { max-height: 60vh; overflow-y: auto; }
    .ycfp-pl-list { max-height: 200px; overflow-y: auto; border: 1px solid #444;
      border-radius: 6px; padding: 6px; margin: 4px 0; }
    .ycfp-pl-list .ycfp-check { margin: 3px 0; }
    .ycfp-results { margin: 8px 0; }
    .ycfp-comparison { padding: 8px 0; }
    .ycfp-comparison-players { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
    .ycfp-comparison-players select { width: 100%; min-width: 0; margin-bottom: 6px; }
    .ycfp-comparison-slot img { width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 6px; }
    .ycfp-comparison-meta { font-size: 11px; opacity: .8; margin: 4px 0; }
    .ycfp-comparison-slot a { display: block; font-size: 11px; color: #8cc8ff; }
    @media (max-width: 540px) { .ycfp-comparison-players { grid-template-columns: 1fr; } }
    .ycfp-group { border: 1px solid #444; border-radius: 8px; padding: 6px 8px; margin-bottom: 8px; }
    .ycfp-group.ycfp-group-xch { border-color: #c47612; }
    .ycfp-group-head { font-weight: 600; margin-bottom: 4px; color: #d9a3e8;
      display: flex; align-items: center; gap: 6px; }
    .ycfp-group-head .ycfp-grp-label { margin-right: auto; }
    .ycfp-xch-star { color: #f0a933; font-weight: 800; font-size: 15px; }
    .ycfp-mini-btn { background: #333; color: #eee; border: 0; border-radius: 5px;
      padding: 2px 8px; font-size: 11px; cursor: pointer; flex: none; }
    .ycfp-mini-btn:hover { background: #555; }
    .ycfp-row-hidden, .ycfp-group-hidden, .ycfp-group-hidden-unlinked, .ycfp-group-hidden-xch, .ycfp-group-hidden-resolved { display: none; }
    .ycfp-unlink-btn { background: #333; color: #eee; border: 0; border-radius: 50%;
      width: 20px; height: 20px; line-height: 20px; text-align: center; font-size: 12px;
      padding: 0; cursor: pointer; flex: none; }
    .ycfp-unlink-btn:hover { background: #a33; }
    .ycfp-group-unlinked { opacity: 0.45; filter: grayscale(0.7); }
    .ycfp-group-unlinked .ycfp-unlink-btn { background: #2b6e3a; }
    .ycfp-group-unlinked .ycfp-unlink-btn:hover { background: #37903f; }
    .ycfp-btn.ycfp-on { background: #1b7f3b; }
    .ycfp-entry { display: flex; align-items: center; gap: 8px; padding: 2px 0; min-width: 0; }
    .ycfp-entry-dur { font-family: Consolas, monospace; color: #aaa; flex: 0 0 44px; text-align: right; }
    .ycfp-entry-title { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: inherit; text-decoration: none; }
    a.ycfp-entry-title:hover { color: #3ea6ff; text-decoration: underline; }
    .ycfp-entry-ch { flex: 0 0 auto; max-width: 130px; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; color: #aaa; font-size: 12px; }
    .ycfp-entry-pl { flex: 0 0 auto; max-width: 170px; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; color: #8ab4f8; font-size: 12px; }
    /* The telling-apart facts in a companion row (handle, subs, video count,
       catalog overlap). They are the whole point of that row, so they get the
       row's spare width instead of the title link, and the full string on
       hover when even that is not enough. */
    .ycfp-entry-facts { flex: 0 1 auto; max-width: 340px; cursor: help; }
    .ycfp-check:hover .ycfp-entry-facts { color: #ddd; }
    .ycfp-entry-gone { opacity: 0.35; text-decoration: line-through; }
    .ycfp-warn { border: 1px solid #c47612; background: rgba(196,118,18,.18); padding: 8px 10px;
      border-radius: 8px; margin-top: 10px; }
    .ycfp-entry .ycfp-btn { padding: 2px 8px; font-size: 11px; flex: 0 0 auto; }
    .ycfp-row select { flex: 1 1 auto; max-width: 320px; padding: 6px; border-radius: 6px;
      border: 1px solid #555; background: var(--yt-spec-badge-chip-background, #1a1a1a); color: inherit; }
    .ycfp-mark { display: inline-block; margin-right: 5px; font-size: 13px; line-height: 1;
      vertical-align: middle; cursor: help; }
    .ycfp-mark-have { color: #3ea55f; }
    .ycfp-mark-variant { color: #e0a44a; }

    /* 📜 Removed & moved videos */
    .ycfp-dialog.ycfp-dialog-review { width: min(96vw, 1040px); }
    .ycfp-dialog-review .ycfp-body { max-height: 70vh; }
    .ycfp-review-filters { position: sticky; top: 0; z-index: 1; padding-bottom: 6px;
      background: var(--yt-spec-menu-background, #282828); }
    .ycfp-review-row { margin-top: 6px; align-items: center; }
    .ycfp-review-row select { flex: 1 1 160px; max-width: none; }
    .ycfp-daterange { display: inline-flex; align-items: center; gap: 4px; }
    .ycfp-daterange input { padding: 5px; border-radius: 6px; border: 1px solid #555; color: inherit;
      background: var(--yt-spec-badge-chip-background, #1a1a1a); color-scheme: dark; }
    .ycfp-review-summary { color: #aaa; font-size: 12px; margin-top: 6px; }
    .ycfp-entry-when { flex: 0 0 74px; color: #aaa; font-size: 12px; white-space: nowrap; }
    .ycfp-bdg { flex: 0 0 auto; font-size: 11px; font-weight: 600; border-radius: 10px; padding: 1px 7px;
      white-space: nowrap; cursor: help; }
    .ycfp-bdg-removed { background: rgba(179,51,51,.25); color: #ff8a80; }
    .ycfp-bdg-moved { background: rgba(62,166,255,.2); color: #8ab4f8; }
    .ycfp-bdg-dupe { background: rgba(196,118,18,.22); color: #f0b35a; }
    .ycfp-bdg-restored { background: rgba(62,165,95,.22); color: #81c995; }
    .ycfp-dialog-review .ycfp-results { overflow-x: hidden; }
    .ycfp-dialog-review .ycfp-entry-title { flex: 1 1 160px; min-width: 90px; }
    .ycfp-dialog-review .ycfp-entry-ch { flex: 0 1 auto; min-width: 40px; max-width: 150px; }
    .ycfp-dialog-review .ycfp-entry-pl { flex: 0 1 auto; min-width: 50px; max-width: 34%; }
  `;

  function injectStyles() {
    if (document.getElementById('ycfp-style')) return;
    const s = document.createElement('style');
    s.id = 'ycfp-style';
    s.textContent = CSS;
    document.head.append(s);
  }

  function openDialog(titleText, wide = false) {
    const old = document.getElementById('ycfp-dialog');
    if (old) {
      // Fire its close event first so any flow waiting on that dialog
      // cancels cleanly instead of running on headless.
      try { old.close(); } catch (e) { /* wasn't open */ }
      old.remove();
    }

    const state = { closed: false };
    const body = el('div', { class: 'ycfp-body' });
    const logBox = el('div', { class: 'ycfp-log' });
    const dlg = el('dialog', { id: 'ycfp-dialog', class: wide ? 'ycfp-dialog ycfp-dialog-wide' : 'ycfp-dialog' },
      el('div', { class: 'ycfp-head' },
        el('div', { class: 'ycfp-title' }, titleText),
        el('button', { class: 'ycfp-x', onclick: () => dlg.close() }, '×')),
      body, logBox);
    dlg.addEventListener('close', () => {
      state.closed = true;
      if (activeLog === log) activeLog = null;
    });
    document.body.append(dlg);
    dlg.showModal();

    let lastTransient = null;
    const log = (msg, transient = false) => {
      logBox.style.display = 'block';
      if (transient && lastTransient) {
        lastTransient.textContent = msg;
      } else {
        const line = el('div', {}, msg);
        logBox.append(line);
        lastTransient = transient ? line : null;
      }
      logBox.scrollTop = logBox.scrollHeight;
    };
    const link = (href, label) => {
      logBox.append(el('div', {}, el('a', { href, target: '_blank' }, `→ Open: ${label}`)));
      logBox.scrollTop = logBox.scrollHeight;
    };
    const guard = () => { if (state.closed) throw new Error('Cancelled (dialog closed).'); };

    activeLog = log; // storage notices land in the dialog you are looking at
    return { dlg, body, log, link, guard, state };
  }

  // Target picker: resolves to {type:'existing', id} | {type:'new', title} | null.
  function pickTarget(ui, playlists, cfg, excludeId) {
    return new Promise((resolve) => {
      const options = [el('option', { value: '' }, '— choose a playlist —')];
      for (const p of playlists) {
        if (p.id === excludeId) continue;
        options.push(el('option', { value: p.id }, p.title));
      }
      const select = el('select', {}, ...options);
      if (cfg.defaultTargetPlaylist) select.value = cfg.defaultTargetPlaylist;
      const pasteInput = el('input', { type: 'text', placeholder: 'e.g. PLxxxx… or a playlist URL' });
      const rememberBox = el('input', { type: 'checkbox', checked: !!cfg.defaultTargetPlaylist });
      const newNameInput = el('input', { type: 'text', placeholder: 'Only used with "Create new"' });

      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      ui.dlg.addEventListener('close', () => finish(null));

      const addBtn = el('button', { class: 'ycfp-btn' }, 'Add to selected playlist');
      addBtn.addEventListener('click', () => {
        const id = parsePlaylistId(pasteInput.value) || select.value;
        if (!id) { ui.log('⚠ Pick a playlist from the list or paste an ID first.'); return; }
        // Persist only the default-target field — `cfg` may be a modified
        // copy (e.g. exclusions blanked for a no-exclusion run).
        const stored = loadCfg();
        stored.defaultTargetPlaylist = rememberBox.checked ? id : '';
        saveCfg(stored);
        cfg.defaultTargetPlaylist = stored.defaultTargetPlaylist;
        picker.remove();
        finish({ type: 'existing', id });
      });
      const newBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Create new instead');
      newBtn.addEventListener('click', () => {
        const title = newNameInput.value.trim();
        if (!title) { ui.log('⚠ Type a name for the new playlist first.'); return; }
        picker.remove();
        finish({ type: 'new', title });
      });

      const picker = el('div', {},
        el('label', {}, 'Add the collected videos to which of your playlists?'),
        select,
        el('label', {}, '…or paste a playlist ID / URL:'),
        pasteInput,
        el('div', { class: 'ycfp-check' }, rememberBox,
          el('span', {}, 'Remember as default target (skip this step next time)')),
        el('label', {}, 'New playlist name:'),
        newNameInput,
        el('div', { class: 'ycfp-row' }, addBtn, newBtn));
      ui.body.append(picker);

      // Auto-continue if a default target is configured and still valid.
      if (cfg.defaultTargetPlaylist && cfg.defaultTargetPlaylist !== excludeId) {
        ui.log(`Using saved default target ${cfg.defaultTargetPlaylist} — clear the "Default target playlist" field in ⚙ settings to be asked again.`);
        picker.remove();
        finish({ type: 'existing', id: cfg.defaultTargetPlaylist });
      }
    });
  }

  // ------------------------------------------------------------------
  // "New Songs" from the bookmarks folder
  //
  // Watches a bookmarks folder of channel links (read from the browser's
  // local Bookmarks file via the companion "YCFP Bookmarks Bridge"
  // userscript — GM_xmlhttpRequest needs a sandboxed script, and this one
  // must stay in the page context for ytcfg). Each channel's baseline is
  // the NS_BASELINE_N newest video ids seen last time; everything above the
  // first baseline hit in the uploads list counts as new. A channel seen in
  // the folder for the first time is baselined at its newest video and
  // contributes nothing that run (you presumably just finished binging it).
  // ------------------------------------------------------------------
  const NS_KEY = 'ycfp-newsongs-v1';
  const NS_BASELINE_N = 15;   // ids kept per channel, so deletions can't orphan the marker
  const NS_PREFIX_CAP = 250;  // give up looking for the baseline after this many videos
  const NS_AUTOSCAN_MS = 30 * 60 * 1000;
  const NS_DEFAULTS = {
    bmFile: 'C:\\Users\\<you>\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data\\Default\\Bookmarks',
    bmFolder: 'Music/Youtube/Done/Final',
    urlToId: {},   // bookmark URL → UC… id (cache, so handles resolve only once)
    channels: {},  // UC… id → { name, recentIds: [], baselinedAt, checkedAt }
    // Bookmarked channel id → its main/Topic counterpart(s), so an artist is
    // watched on both channels even when only one is bookmarked:
    //   { ids: [UC…], names: [..], at, how: 'name'|'search'|'pull'|'none' }
    pairs: {},
    watchPairs: true,
    lastAutoScan: 0,
  };
  const loadNs = () => {
    try {
      const raw = kvGet(NS_KEY);
      if (raw) return Object.assign(JSON.parse(JSON.stringify(NS_DEFAULTS)), JSON.parse(raw));
    } catch (e) { /* use defaults */ }
    return JSON.parse(JSON.stringify(NS_DEFAULTS));
  };
  const saveNs = (ns) => kvSet(NS_KEY, JSON.stringify(ns));

  let nsReqSeq = 0;
  function nsBridgeRequest(msg, timeoutMs, timeoutText) {
    return new Promise((resolve, reject) => {
      const reqId = 'ns' + (++nsReqSeq) + '-' + Date.now();
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error(timeoutText));
      }, timeoutMs);
      const onMsg = (ev) => {
        if (ev.source !== window || ev.origin !== location.origin) return;
        const d = ev.data;
        if (!d || d.ycfpBm !== 'result' || d.reqId !== reqId) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        if (d.ok) resolve(d);
        else reject(new Error(d.error || 'Bookmarks bridge error.'));
      };
      window.addEventListener('message', onMsg);
      window.postMessage(Object.assign({ reqId }, msg), location.origin);
    });
  }

  async function readBookmarkRoots(file) {
    // Ping first so "bridge not running" and "file read failed" give
    // different, actionable errors.
    await nsBridgeRequest({ ycfpBm: 'ping' }, 2500,
      'Bookmarks bridge is not running. Install/enable bookmarks-bridge.user.js (v1.1.0+) in '
      + 'Tampermonkey, then RELOAD this YouTube tab — the bridge only starts on page load. '
      + 'When it runs, the browser console (F12) shows a "[YCFP bridge]" line.');
    const d = await nsBridgeRequest({ ycfpBm: 'read', file }, 15000,
      'The bridge is running but the file read never finished. Usually this means '
      + '"Allow access to file URLs" is off for Tampermonkey '
      + '(brave://extensions → Tampermonkey → Details) — enable it and reload this tab.');
    return d.roots;
  }

  // Find the folder for a path like "Music/Youtube/Done/Final". The first
  // segment may sit anywhere (any root, any depth) — so the path works
  // whether or not it starts with "Bookmarks bar" — the rest must descend.
  function findBookmarkFolder(roots, pathStr) {
    const segs = pathStr.split('/').map((s) => normTitle(s)).filter(Boolean);
    if (!segs.length) return null;
    const descend = (folder, i) => {
      if (i >= segs.length) return folder;
      for (const f of folder.folders) {
        if (normTitle(f.name) === segs[i]) {
          const r = descend(f, i + 1);
          if (r) return r;
        }
      }
      return null;
    };
    const queue = [...roots];
    while (queue.length) {
      const f = queue.shift();
      if (normTitle(f.name) === segs[0]) {
        const r = descend(f, 1);
        if (r) return r;
      }
      queue.push(...f.folders);
    }
    return null;
  }

  // All YouTube links in the configured folder (subfolders included).
  async function nsGetBookmarkLinks(ns) {
    const roots = await readBookmarkRoots(ns.bmFile);
    const folder = findBookmarkFolder(roots, ns.bmFolder);
    if (!folder) throw new Error(`Bookmarks folder "${ns.bmFolder}" not found in ${ns.bmFile}.`);
    const links = [];
    const walk = (f) => { links.push(...f.links); f.folders.forEach(walk); };
    walk(folder);
    return links;
  }

  // "(3) Artist - YouTube" → "Artist"
  const cleanBookmarkName = (s) => (s || '')
    .replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/i, '').trim();

  // Bookmark links → Map(UC… id → display name). /channel/UC… URLs resolve
  // for free; @handles and /c/ URLs go through the API once and are cached.
  async function nsResolveChannels(ns, links, log, guard) {
    const out = new Map();
    for (const l of links) {
      if (guard) guard();
      let id = null;
      const m = (l.url || '').match(/channel\/(UC[\w-]{22})/);
      if (m) id = m[1];
      else if (ns.urlToId[l.url]) id = ns.urlToId[l.url];
      else {
        log(`Resolving "${cleanBookmarkName(l.name)}"…`, true);
        try { id = await resolveChannelInput(l.url); } catch (e) { id = null; }
        if (id) ns.urlToId[l.url] = id;
      }
      if (!id) { log(`⚠ Could not resolve bookmark "${l.name}" (${l.url}) — skipped.`); continue; }
      if (!out.has(id)) out.set(id, cleanBookmarkName(l.name) || id);
    }
    return out;
  }

  // A video that isn't out yet — a scheduled premiere or stream, or a row
  // with no duration (live right now, still processing). Same test as
  // stripUpcoming, which is what keeps these out of a collect.
  const nsNotOutYet = (v) => v.isUpcoming || (!(v.seconds > 0) && !v.isShort);

  // The ids a marker is made of: the NS_BASELINE_N newest uploads that are
  // actually out. A premiere scheduled for Friday sits at the top of the
  // uploads list all week; had it gone into the marker, Friday's run would
  // find it first, stop there, and never collect it (stripUpcoming had
  // already thrown it out of the run that wrote the marker). Worse, anything
  // uploaded below it in the meantime was hidden too. Left out of the
  // marker, it is simply "new" again next run, and collected once it has
  // aired. Falls back to the raw top when nothing qualifies, so a channel
  // whose rows carry no durations still gets a marker.
  function nsMarkerIds(videos) {
    const out = [];
    for (const v of videos) {
      if (out.length >= NS_BASELINE_N) break;
      if (!nsNotOutYet(v)) out.push(v.id);
    }
    return out.length ? out : videos.slice(0, NS_BASELINE_N).map((v) => v.id);
  }

  // How far past the first marker hit to keep reading. The marker ids were
  // the newest ~15 when it was written, so normally they all turn up within
  // 15 rows; the slack covers uploads that YouTube slotted in BETWEEN them
  // since (a video published with an earlier date, a private one made
  // public), which the old stop-at-first-hit logic skipped for good.
  const NS_MARKER_SLACK = 40;

  // Walk a channel's uploads newest-first. Returns:
  //   fresh    — every video above the DEEPEST marker hit that isn't itself
  //              a marker id (capped at NS_PREFIX_CAP)
  //   top      — the next marker (see nsMarkerIds)
  //   hit      — whether any marker id was found at all
  //   inserted — how many of `fresh` sat below the first hit, i.e. would
  //              have been missed by a stop-at-first-hit scan
  async function nsFetchUploads(channelId, recentIds, log, guard, label) {
    const recent = new Set(recentIds || []);
    const items = [];
    const seen = new Set();
    const usedTokens = new Set();
    let firstHit = -1;
    let lastHit = -1;
    let found = 0;
    let data;
    try {
      data = await api('browse', { browseId: 'VLUU' + channelId.slice(2) });
    } catch (e) {
      return { fresh: [], top: [], hit: false, inserted: 0, error: e.message || String(e) };
    }
    for (;;) {
      if (guard) guard();
      const batch = [];
      extractVideos(data, seen, batch);
      for (const v of batch) {
        if (recent.has(v.id)) {
          if (firstHit < 0) firstHit = items.length;
          lastHit = items.length;
          found++;
        }
        items.push(v);
      }
      if (firstHit < 0 && items.length >= NS_PREFIX_CAP) break;
      if (firstHit >= 0 && (found >= recent.size
        || items.length - firstHit > NS_BASELINE_N + NS_MARKER_SLACK)) break;
      const next = nextSectionToken(videoSection(data), usedTokens);
      if (!next) break;
      log(`${label}: scanning uploads… (${firstHit < 0 ? items.length : firstHit} newer than the marker so far)`, true);
      data = await api('browse', { continuation: next });
      await sleep(150);
    }
    const hit = firstHit >= 0;
    const above = hit ? items.slice(0, lastHit) : items;
    const fresh = above.filter((v) => !recent.has(v.id)).slice(0, NS_PREFIX_CAP);
    const inserted = hit ? fresh.filter((v) => items.indexOf(v) > firstHit).length : 0;
    return { fresh, top: nsMarkerIds(items), hit, inserted };
  }

  // Baselines committed only after the videos were actually added, so a
  // failed run leaves them collectible for the next one.
  function nsCommit(ns, pending) {
    for (const id of Object.keys(pending)) {
      if (ns.channels[id]) {
        ns.channels[id].recentIds = pending[id];
        ns.channels[id].checkedAt = Date.now();
      }
    }
    saveNs(ns);
  }

  // ------------------------------------------------------------------
  // Main ↔ Topic counterparts of the watched channels
  //
  // Most artists have two channels: the main one (music videos, live
  // versions, announcements) and the auto-generated "<Artist> - Topic" one
  // (every track of every release). The folder usually holds only ONE of
  // them — checked on 2026-09-24, 60 of the 131 main channels in Final had no
  // Topic bookmark next to them, and for many Topic bookmarks the main
  // channel lived in another folder (100+, 200+, 500+) — so New Songs only
  // ever saw half of what those artists released. Half of the uploads waiting
  // that day were on channels it never checked.
  //
  // So every bookmarked channel is paired with its counterpart, which is then
  // watched exactly like a bookmark. Pairs come from, cheapest first:
  //   1. the pull that harvested it (it chose and reviewed the pair);
  //   2. a name match among channels already watched ("Anson Seabra" ↔
  //      "Anson Seabra - Topic"), no request at all;
  //   3. a channel search by exact name — accepted only when it can't be a
  //      wrong artist: the single same-named channel of the right kind, or the
  //      one whose uploads demonstrably overlap.
  // Results (including "none found") are cached; a miss is retried monthly.
  // ------------------------------------------------------------------
  const NS_PAIR_RETRY_MS = 30 * 24 * 60 * 60 * 1000;

  // "Amber Run Official" / "AmberRunVEVO" / "Amber Run - Topic" → "amberrun"
  const nsArtistKey = (name) => normTitle(name)
    .replace(TOPIC_SUFFIX, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/(official)?(vevo|music|official)$/u, '');

  function nsRememberPair(ns, id, selfName, ids, names, how) {
    ns.pairs[id] = { ids, names, how, at: Date.now() };
    // Pairs are symmetric: the counterpart's own bookmark (if it ever gets
    // one) needs no second lookup.
    for (const cid of ids) {
      const p = ns.pairs[cid];
      if (!p || p.how === 'none') ns.pairs[cid] = { ids: [id], names: [selfName || id], how, at: Date.now() };
      else if (!p.ids.includes(id)) { p.ids.push(id); p.names.push(selfName || id); }
    }
  }

  // Returns Map(counterpart id → name) for the bookmarked channels `chans`
  // (Map id → name). Counterparts that are themselves bookmarked are left
  // out — they are checked anyway. `lookup` false = cache and name matches
  // only (the background scan never searches).
  async function nsCounterparts(ns, chans, log, guard, lookup = true) {
    const out = new Map();
    // Name index over everything this store knows by name.
    const byKey = new Map();
    const addKey = (id, name) => {
      const k = nsArtistKey(name);
      if (!k) return;
      const arr = byKey.get(k);
      if (arr) { if (!arr.some((x) => x.id === id)) arr.push({ id, name }); } else byKey.set(k, [{ id, name }]);
    };
    for (const [id, st] of Object.entries(ns.channels)) addKey(id, st.name || '');
    for (const [id, name] of chans) addKey(id, name);

    let searched = 0, foundBySearch = 0;
    const unmatched = [];
    for (const [id, name] of chans) {
      if (guard) guard();
      const onTopic = TOPIC_SUFFIX.test(name);
      let pair = ns.pairs[id];
      const stale = pair && pair.how === 'none' && Date.now() - (pair.at || 0) > NS_PAIR_RETRY_MS;
      if (!pair || stale) {
        // Name match first: the other kind of channel with the same artist key.
        const other = (byKey.get(nsArtistKey(name)) || [])
          .filter((x) => x.id !== id && TOPIC_SUFFIX.test(x.name) !== onTopic);
        if (other.length === 1) {
          nsRememberPair(ns, id, name, [other[0].id], [other[0].name], 'name');
          pair = ns.pairs[id];
        } else if (lookup) {
          const want = onTopic ? name.replace(TOPIC_SUFFIX, '').trim() : `${name} - Topic`;
          searched++;
          log(`Looking for the ${onTopic ? 'main' : 'Topic'} channel of "${name}"… (${searched})`, true);
          let cands = [];
          try { cands = await searchChannelsByExactName(want, id); } catch (e) { cands = null; }
          if (guard) guard();
          if (cands === null) continue; // search failed — try again next run
          // Topic channels never have a handle; a main channel nearly always
          // does, so the right kind is tried first. Whichever it is, a
          // candidate is only accepted if it shares at least one song with
          // this channel — a bare name match is how unrelated artists get
          // paired, and nobody reviews these the way a pull's pairs are.
          const right = cands.filter((c) => c.hasHandle === onTopic);
          const pool = right.length ? right : cands;
          let pick = null;
          if (pool.length) {
            let own = [];
            try {
              own = await fetchPlaylistVideos('UU' + id.slice(2), 'probe', () => {}, guard,
                { quiet: true, noContinue: true });
            } catch (e) { own = []; }
            let bestScore = 0;
            for (const c of pool.slice(0, 5)) {
              const s = await scoreCandidateOverlap(c.channelId, own, guard);
              if (s > bestScore) { pick = c; bestScore = s; }
            }
          }
          if (pick) {
            nsRememberPair(ns, id, name, [pick.channelId], [pick.title || want], 'search');
            foundBySearch++;
          } else {
            ns.pairs[id] = { ids: [], names: [], how: 'none', at: Date.now(),
              why: pool.length ? `${pool.length} "${want}" channel(s), none sharing any song` : 'none found' };
            unmatched.push(name);
          }
          saveNs(ns); // a cancelled run keeps every lookup it finished
          pair = ns.pairs[id];
        }
      }
      if (!pair) continue;
      pair.ids.forEach((cid, i) => {
        if (!chans.has(cid) && !out.has(cid)) out.set(cid, pair.names[i] || cid);
      });
    }
    if (searched) {
      log(`Counterpart search: ${foundBySearch} of ${searched} found`
        + (unmatched.length ? `; none (or no clear match) for ${unmatched.length}: ${unmatched.slice(0, 12).join(', ')}${unmatched.length > 12 ? ', …' : ''}` : '') + '.');
    }
    return out;
  }

  // Record channels as "already harvested up to here" in the New Songs
  // store, right now, from ids read out of the uploads feed at fetch time.
  //
  // This is what closes the batch-pull gap: a pull takes a channel's FULL
  // back catalog and then moves its bookmark into the watched folder, but
  // nothing wrote a marker, so the channel was only baselined whenever New
  // Songs (or its 30-min auto-scan) next saw the bookmark — and a first
  // sighting collects nothing. Everything uploaded between the pull and that
  // sighting was therefore skipped forever. Baselining at pull time means the
  // very next New Songs run starts from the pull, however many days later.
  //
  // The store is re-read here rather than kept in a long-lived copy: the
  // auto-scan may have written to it while the pull was running, and a whole
  // batch must not clobber its markers.
  function nsBaselineNow(targets, urlMap) {
    const ns = loadNs();
    const added = [];
    const moved = [];
    for (const t of (targets || [])) {
      if (!t || !t.id || !t.top || !t.top.length) continue;
      (ns.channels[t.id] ? moved : added).push(t.name || t.id);
      ns.channels[t.id] = {
        name: t.name || (ns.channels[t.id] && ns.channels[t.id].name) || t.id,
        recentIds: t.top.slice(0, NS_BASELINE_N),
        baselinedAt: Date.now(),
        checkedAt: Date.now(),
        viaPull: true,
      };
    }
    // The pull chose (and you reviewed) each channel's counterpart — record
    // the pair, so New Songs watches both even when only one is bookmarked.
    const head = (targets || [])[0];
    const rest = (targets || []).slice(1).filter((t) => t && t.id);
    if (head && head.id && rest.length) {
      nsRememberPair(ns, head.id, head.name, rest.map((t) => t.id), rest.map((t) => t.name || t.id), 'pull');
    }
    // Free side-benefit: the pull already resolved these bookmark URLs to
    // channel ids, so New Songs never has to resolve the handle again.
    for (const url of Object.keys(urlMap || {})) {
      if (url && urlMap[url]) ns.urlToId[url] = urlMap[url];
    }
    if (added.length || moved.length || rest.length || Object.keys(urlMap || {}).length) saveNs(ns);
    return { added, moved };
  }

  const nsToday = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  async function runNewSongsFlow() {
    if (running) return;
    running = true;
    let afterDedupe = null;
    const cfg = loadCfg();
    const ns = loadNs();
    const ui = openDialog('New songs from bookmarked channels', true);
    try {
      // Options step: source paths + the usual per-run toggles.
      const fileInput = el('input', { type: 'text', value: ns.bmFile });
      const folderInput = el('input', { type: 'text', value: ns.bmFolder });
      const opts = collectOptionRows(cfg);
      // Off by default: these are uploads newer than the last check, so they
      // are almost never in an exclusion playlist already — scanning them
      // costs a full fetch of every excluded playlist for nothing.
      const exclCb = el('input', { type: 'checkbox' });
      const pairCb = el('input', { type: 'checkbox', checked: ns.watchPairs !== false });
      const startBtn = el('button', { class: 'ycfp-btn' }, 'Check for new songs');
      const form = el('div', {},
        el('label', {}, 'Bookmarks file:'),
        fileInput,
        el('label', {}, 'Channel folder (path inside your bookmarks):'),
        folderInput,
        el('div', { class: 'ycfp-check' }, pairCb,
          el('span', {}, 'Also watch each channel\'s main / "- Topic" counterpart, even if it isn\'t bookmarked '
            + '(found once and remembered; the first run does the looking up)')),
        ...opts.rows,
        el('div', { class: 'ycfp-check' }, exclCb,
          el('span', {}, 'Skip videos already in the excluded playlists')),
        el('div', { class: 'ycfp-row' }, startBtn));
      ui.body.append(form);
      await new Promise((res) => {
        startBtn.addEventListener('click', res, { once: true });
        ui.dlg.addEventListener('close', res);
      });
      ui.guard();
      opts.apply();
      const useExcl = exclCb.checked;
      ns.watchPairs = pairCb.checked;
      if (fileInput.value.trim()) ns.bmFile = fileInput.value.trim();
      if (folderInput.value.trim()) ns.bmFolder = folderInput.value.trim();
      saveNs(ns);
      form.remove();

      ui.log(`Reading bookmarks folder "${ns.bmFolder}"…`);
      const links = await nsGetBookmarkLinks(ns);
      ui.log(`${links.length} bookmark(s) in the folder.`);
      const chans = await nsResolveChannels(ns, links, ui.log, ui.guard);
      saveNs(ns); // persist the url→id cache even if the run stops later
      ui.log(`${chans.size} unique channel(s).`);

      // Every channel to check: the bookmarks, plus (option) the other
      // channel of each artist. A counterpart is watched exactly like a
      // bookmark — first sighting baselines it, after that it's collected.
      const watch = new Map(chans);
      if (ns.watchPairs) {
        const extra = await nsCounterparts(ns, chans, ui.log, ui.guard, true);
        saveNs(ns);
        for (const [id, name] of extra) watch.set(id, (ns.channels[id] && ns.channels[id].name) || name);
        if (extra.size) ui.log(`+ ${extra.size} main/Topic counterpart channel(s) that aren't bookmarked themselves.`);
      }

      // Channels seen for the first time: baseline only.
      const justBaselined = new Set();
      for (const [id, name] of watch) {
        if (ns.channels[id]) continue;
        ui.guard();
        const r = await nsFetchUploads(id, [], ui.log, ui.guard, name);
        if (r.error) { ui.log(`⚠ ${name}: ${r.error} — will retry next run.`); continue; }
        ns.channels[id] = { name, recentIds: r.top, baselinedAt: Date.now(), checkedAt: Date.now() };
        justBaselined.add(id);
        saveNs(ns);
        ui.log(`＋ ${name}: ${chans.has(id) ? 'new in the folder' : 'counterpart, first time watched'}`
          + ' — baselined at its latest video (nothing collected this run).');
      }

      // Known channels: collect everything newer than the baseline.
      const fresh = [];
      const pending = {};
      let checked = 0;
      for (const [id, name] of watch) {
        if (!ns.channels[id] || justBaselined.has(id)) continue;
        ui.guard();
        checked++;
        const st = ns.channels[id];
        st.name = name;
        const r = await nsFetchUploads(id, st.recentIds, ui.log, ui.guard, name);
        if (r.error) { ui.log(`⚠ ${name}: ${r.error} — skipped.`); continue; }
        if (st.recentIds.length && !r.hit) {
          ui.log(`⚠ ${name}: none of its last-seen markers were found (deleted videos, or >${NS_PREFIX_CAP} new ones). Re-baselined at the latest video; nothing collected from it.`);
          st.recentIds = r.top;
          st.checkedAt = Date.now();
          saveNs(ns);
          continue;
        }
        if (r.fresh.length) {
          const since = st.checkedAt ? ` since ${new Date(st.checkedAt).toLocaleDateString()}` : '';
          ui.log(`${name}: ${r.fresh.length} new video(s)${since}`
            + `${r.inserted ? ` (${r.inserted} of them slotted in below newer uploads — the old check would have missed those)` : ''}.`);
          for (const v of r.fresh) { if (!v.channel) v.channel = name; fresh.push(v); }
          pending[id] = r.top;
        } else {
          st.recentIds = r.top; // unchanged in practice; keeps the marker fresh
          st.checkedAt = Date.now();
        }
      }
      saveNs(ns);
      ui.log(`Checked ${checked} channel(s), ${justBaselined.size} newly baselined.`);

      if (!fresh.length) { ui.log('✅ No new songs since the last check.'); return; }

      // Optional filters + duplicate collapsing (main ↔ Topic uploads of the
      // same song land here twice when both channels are bookmarked).
      let kept = fresh;
      if (cfg.excludeShorts) {
        const n = kept.length;
        kept = kept.filter((v) => !v.isShort);
        if (n - kept.length) ui.log(`Skipped ${n - kept.length} Short(s) (by data tag).`);
      }
      if (cfg.excludeLive) {
        const n = kept.length;
        kept = kept.filter((v) => !v.isLive);
        if (n - kept.length) ui.log(`Skipped ${n - kept.length} live stream(s).`);
      }
      if (cfg.excludeUpcoming) kept = stripUpcoming(kept, 'New songs', ui.log);
      // The deleted-video ledger applies either way: it costs no fetches, and
      // a song you deleted on purpose shouldn't come back as a "new song".
      const excl = useExcl
        ? await buildExclusionSets(cfg, ui.log, ui.guard)
        : Object.assign({ exclIds: new Set(), exclKeys: new Set(), exclFuzz: new Map() },
          buildGoneSets(cfg));
      // Duplicate skipping on → look-alikes are kept and reviewed in 🧹
      // Dedupe afterwards (see Pull batch); exact ids + the ledger still skip.
      const review = !!(cfg.dedupeByTitleDuration || cfg.fuzzyCollect);
      const filtered = await applyExclusions(kept, excl,
        review ? Object.assign({}, cfg, { dedupeByTitleDuration: false, fuzzyCollect: false }) : cfg, cfg);
      if (filtered.nExcluded || filtered.nDupes || filtered.nDeleted) {
        ui.log(`${kept.length} → ${filtered.kept.length} kept (${filtered.nExcluded} already in excluded playlists, `
          + `${filtered.nDupes} duplicate versions${filtered.nDeleted ? `, ${filtered.nDeleted} you deleted before` : ''}).`);
      }
      // Named, because "you deleted before" is matched by title + length too:
      // if one of these is a song you want, forget it in 📜 Removed videos.
      for (const v of filtered.deleted.slice(0, 20)) {
        ui.log(`  ⤫ held back as deleted before: ${v.channel ? v.channel + ' — ' : ''}${v.title}`);
      }
      kept = filtered.kept;
      if (!kept.length) {
        nsCommit(ns, pending);
        ui.log('✅ Every new video was already known — nothing to add.');
        return;
      }

      // Target: "New Songs YYYY-MM-DD" — reused if it already exists today.
      const title = `New Songs ${nsToday()}`;
      ui.log(`Looking for an existing "${title}" playlist…`);
      const own = await getOwnPlaylists(ui.log);
      const existing = own.find((p) => normTitle(p.title) === normTitle(title));
      let pid;
      if (existing) {
        pid = existing.id;
        const toAdd = await filterAgainstTarget(kept, pid,
          review ? Object.assign({}, cfg, { dedupeByTitleDuration: false, fuzzyCollect: false }) : cfg, ui.log, ui.guard);
        if (toAdd.length) await addToPlaylist(pid, toAdd.map((v) => v.id), cfg, ui.log, ui.guard);
        ui.log(`✅ Added ${toAdd.length} new song(s) to today's existing "${title}".`);
      } else {
        pid = await createPlaylist(title, kept.map((v) => v.id), cfg, ui.log, ui.guard);
        ui.log(`✅ Created "${title}" with ${kept.length} new song(s).`);
      }
      nsCommit(ns, pending);
      ui.link(`${ORIGIN}/playlist?list=${pid}`, title);
      if (review) {
        afterDedupe = {
          focus: { id: pid, title }, mode: cfg.fuzzyCollect ? 'fuzzy' : 'simple',
          carry: [`🆕 New songs: ${kept.length} song(s) went to "${title}".`],
        };
      }
      for (const v of kept) ui.log(`  • ${v.channel ? v.channel + ' — ' : ''}${v.title}`);
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
      if (afterDedupe) setTimeout(() => runDedupeFlow(afterDedupe), 400);
    }
  }

  // ------------------------------------------------------------------
  // Batch-pull channels from a bookmarks folder
  //
  // Unlike "New Songs" (which only watches for uploads newer than a saved
  // baseline), this pulls each channel's FULL back catalog — same as
  // "Collect All" — for a batch of channels sitting in an inbox-style
  // bookmarks folder, then archives the ones it finished by moving their
  // bookmark into a "done" subfolder. Only the folder's direct bookmarks are
  // read (subfolders, e.g. that "done" folder itself, are never descended
  // into), sorted alphabetically, first N taken per run.
  //
  // Moving a bookmark needs real write access, which the file-reading
  // bridge above can't safely provide (editing the Bookmarks JSON while
  // Brave has it open risks corruption or being silently overwritten) — so
  // this talks to a separate companion browser extension (bookmarks-mover-
  // extension/) that uses the real chrome.bookmarks API instead. Protocol
  // tag: ycfpBmx.
  // ------------------------------------------------------------------
  const BP_KEY = 'ycfp-batchpull-v1';
  const BP_DEFAULTS = {
    srcPath: 'Bookmarks Bar/Music/Youtube/Done',
    destPath: 'Bookmarks Bar/Music/Youtube/Done/Final',
    batchSize: 10,
    // Where the ticked main/Topic counterparts' existing bookmarks are
    // looked for (all subfolders) before being moved to destPath.
    searchPath: 'Bookmarks Bar/Music/Youtube',
  };
  const loadBp = () => {
    try {
      const raw = kvGet(BP_KEY);
      if (raw) return Object.assign({}, BP_DEFAULTS, JSON.parse(raw));
    } catch (e) { /* use defaults */ }
    return Object.assign({}, BP_DEFAULTS);
  };
  const saveBp = (bp) => kvSet(BP_KEY, JSON.stringify(bp));

  let bmxReqSeq = 0;
  function bmxRequest(msg, timeoutMs, timeoutText) {
    return new Promise((resolve, reject) => {
      const reqId = 'bmx' + (++bmxReqSeq) + '-' + Date.now();
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error(timeoutText));
      }, timeoutMs);
      const onMsg = (ev) => {
        if (ev.source !== window || ev.origin !== location.origin) return;
        const d = ev.data;
        if (!d || d.ycfpBmx !== 'result' || d.reqId !== reqId) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        if (d.ok) resolve(d);
        else reject(new Error(d.error || 'Bookmarks mover extension error.'));
      };
      window.addEventListener('message', onMsg);
      window.postMessage(Object.assign({ reqId }, msg), location.origin);
    });
  }

  // Returns the extension's version — features added after 1.0.0 check it
  // so an old unpacked copy fails with "update the extension", not with a
  // baffling "unknown request".
  async function bmxPing() {
    const d = await bmxRequest({ ycfpBmx: 'ping' }, 2500,
      'The YCFP Bookmarks Mover extension is not running. Load it as an unpacked extension '
      + '(brave://extensions → enable Developer mode → Load unpacked → select the '
      + 'bookmarks-mover-extension folder), then reload this YouTube tab.');
    return d.version || '1.0.0';
  }

  async function bmxListFolder(path) {
    await bmxPing();
    const d = await bmxRequest({ ycfpBmx: 'listFolder', path }, 8000,
      'The Bookmarks Mover extension did not respond to the folder listing request.');
    return d.items;
  }

  // Every bookmark under `path`, subfolders included; each carries the
  // folder path it sits in, relative to `path`. Extension v1.1.0+.
  async function bmxListTree(path, youtubeOnly) {
    const d = await bmxRequest({ ycfpBmx: 'listTree', path, youtubeOnly: !!youtubeOnly }, 15000,
      'The Bookmarks Mover extension did not respond to the tree listing request.');
    return { items: d.items, total: d.total };
  }

  // Full paths of every bookmark folder, for the folder pickers.
  async function bmxListFolders() {
    const d = await bmxRequest({ ycfpBmx: 'listFolders' }, 8000,
      'The Bookmarks Mover extension did not respond to the folder list request.');
    return d.paths || [];
  }

  async function bmxMoveBookmarks(ids, destPath) {
    if (!ids.length) return { moved: [], failed: [] };
    try {
      const d = await bmxRequest({ ycfpBmx: 'moveBookmarks', ids, destPath }, 60000,
        'The Bookmarks Mover extension did not respond to the move request.');
      return { moved: d.moved, failed: d.failed };
    } catch (e) {
      // The moves often land even when the answer never arrives (the
      // service worker restarts, or a big tree makes it slow) — so look in
      // the destination before calling it a failure.
      let there;
      try {
        there = new Set((await bmxRequest({ ycfpBmx: 'listTree', path: destPath, youtubeOnly: false }, 20000,
          'no answer')).items.filter((b) => !b.folder).map((b) => b.id));
      } catch (e2) { throw e; }
      const moved = ids.filter((id) => there.has(id));
      if (!moved.length) throw e;
      return {
        moved,
        failed: ids.filter((id) => !there.has(id)).map((id) => ({ id, error: 'not found in the destination after the move' })),
      };
    }
  }

  // Deletes bookmarks and hands back full records of what went (title, url,
  // parent, position) — that record IS the undo, so nothing is removed that
  // couldn't be read first. Extension v1.1.0+.
  async function bmxRemoveBookmarks(ids) {
    if (!ids.length) return { removed: [], failed: [] };
    const d = await bmxRequest({ ycfpBmx: 'removeBookmarks', ids }, 30000,
      'The Bookmarks Mover extension did not respond to the delete request.');
    return { removed: d.removed || [], failed: d.failed || [] };
  }

  // Undo counterpart: re-creates removed bookmarks where they were.
  async function bmxCreateBookmarks(nodes, fallbackPath) {
    if (!nodes.length) return { created: [], failed: [] };
    const d = await bmxRequest({ ycfpBmx: 'createBookmarks', nodes, fallbackPath }, 30000,
      'The Bookmarks Mover extension did not respond to the restore request.');
    return { created: d.created || [], failed: d.failed || [] };
  }

  // New bookmarks ({title, url}) at the end of the folder at `destPath`.
  // Extension v1.2.0+.
  async function bmxAddBookmarks(nodes, destPath) {
    if (!nodes.length) return { created: [], failed: [] };
    const d = await bmxRequest({ ycfpBmx: 'addBookmarks', nodes, destPath }, 30000,
      'The Bookmarks Mover extension did not respond to the add request.');
    return { created: d.created || [], failed: d.failed || [] };
  }

  // Folder `name` directly inside `parentPath`, created when missing (v1.3.0+).
  async function bmxEnsureFolder(parentPath, name) {
    await bmxRequest({ ycfpBmx: 'ensureFolder', parentPath, name }, 8000,
      'The Bookmarks Mover extension did not respond to the folder request.');
    return `${parentPath}/${name}`;
  }

  // The main/Topic counterparts you ticked in a pull were fully pulled too,
  // so they belong in the destination folder beside the pulled channel:
  // each one's existing bookmark anywhere under `searchPath` (any link
  // form) is moved there, and one with no bookmark at all gets a new one.
  // Extension v1.2.0+ (addBookmarks).
  async function bpBookmarkCounterparts(picks, destPath, searchPath, log, guard) {
    const want = new Map(); // UC… → { id, name, handle }
    for (const c of picks) if (c && c.id && !want.has(c.id)) want.set(c.id, c);
    if (!want.size) return;
    const version = await bmxPing();
    if (!verAtLeast(version, '1.2.0')) {
      log(`⚠ Counterparts NOT bookmarked: the Bookmarks Mover extension is v${version}, this needs v1.2.0+ (reload it in brave://extensions).`);
      return;
    }
    log(`Bookmarking ${want.size} ticked counterpart(s) into "${destPath}"…`);
    const destKey = destPath.toLowerCase();
    const byBmId = new Map(); // bookmark id → { url, title, inDest }
    for (const root of new Set([searchPath, destPath])) {
      let items;
      try {
        ({ items } = await bmxListTree(root, true));
      } catch (e) {
        log(`⚠ Could not read "${root}" (${e.message || e}) — counterparts there aren't found.`);
        continue;
      }
      for (const b of items) {
        const full = b.folder ? `${root}/${b.folder}` : root;
        byBmId.set(b.id, { url: b.url, title: b.title, inDest: full.toLowerCase() === destKey });
      }
    }
    const ns = loadNs();
    const handleOf = new Map(); // "@x" lowercased → UC…
    const artistOf = new Map(); // artist key + topic flag → [UC…]
    for (const c of want.values()) {
      if (c.handle) handleOf.set(c.handle.toLowerCase(), c.id);
      const ak = `${nsArtistKey(c.name)}|${TOPIC_SUFFIX.test(c.name)}`;
      artistOf.set(ak, [...(artistOf.get(ak) || []), c.id]);
    }
    const found = new Map(); // UC… → [{ bmId, inDest }]
    const hit = (id, bmId, b) => {
      if (!want.has(id)) return;
      found.set(id, [...(found.get(id) || []), { bmId, inDest: b.inDest }]);
    };
    for (const [bmId, b] of byBmId) {
      guard();
      const ref = bdChannelRef(b.url);
      if (!ref) continue;
      if (ref.form === 'id') { hit(ref.key, bmId, b); continue; }
      if (ns.urlToId[b.url]) { hit(ns.urlToId[b.url], bmId, b); continue; }
      if (ref.form === 'handle' && handleOf.has(`@${ref.key}`)) { hit(handleOf.get(`@${ref.key}`), bmId, b); continue; }
      // An unidentified link named like a wanted channel: resolve it (cached).
      const name = cleanBookmarkName(b.title);
      if (!artistOf.has(`${nsArtistKey(name)}|${TOPIC_SUFFIX.test(name)}`)) continue;
      const id = await bdResolveUrl(b.url);
      if (id) { ns.urlToId[b.url] = id; hit(id, bmId, b); }
    }

    const toMove = [], toAdd = [], already = [];
    for (const c of want.values()) {
      const hits = found.get(c.id) || [];
      if (hits.some((h) => h.inDest)) already.push(c.name);
      else if (hits.length) toMove.push(...hits.map((h) => ({ bmId: h.bmId, name: c.name })));
      else {
        const url = c.handle ? `${ORIGIN}/${c.handle}` : `${ORIGIN}/channel/${c.id}`;
        toAdd.push({ c, url });
      }
    }
    if (already.length) log(`Already in "${destPath}": ${already.join(', ')}.`);
    if (toMove.length) {
      try {
        const { moved, failed } = await bmxMoveBookmarks(toMove.map((m) => m.bmId), destPath);
        const ok = new Set(moved);
        log(`Moved ${moved.length}/${toMove.length} existing counterpart bookmark(s): `
          + toMove.filter((m) => ok.has(m.bmId)).map((m) => m.name).join(', ') + '.');
        for (const f of failed) log(`⚠ Could not move bookmark ${f.id}: ${f.error}`);
      } catch (e) {
        log(`⚠ Counterpart bookmarks were NOT moved: ${e.message || e}`);
      }
    }
    if (toAdd.length) {
      try {
        const { created, failed } = await bmxAddBookmarks(
          toAdd.map((a) => ({ title: `${a.c.name} - YouTube`, url: a.url })), destPath);
        const ok = new Set(created.map((n) => n.i));
        toAdd.forEach((a, i) => { if (ok.has(i)) ns.urlToId[a.url] = a.c.id; });
        log(`Bookmarked ${created.length}/${toAdd.length} new counterpart(s): `
          + toAdd.filter((a, i) => ok.has(i)).map((a) => a.c.name).join(', ') + '.');
        for (const f of failed) log(`⚠ Could not bookmark ${f.url}: ${f.error}`);
      } catch (e) {
        log(`⚠ Counterparts were NOT bookmarked: ${e.message || e}`);
      }
    }
    saveNs(ns);
  }

  // ------------------------------------------------------------------
  // Pull batch review tab
  //
  // Before a pull, every candidate bookmark is shown in a second tab, one
  // channel at a time, with a bar at the top right: ◀ ▶ to go back and
  // forth, ✓ Pull, ✕ Reject (stays in the source folder, skipped this run),
  // 📁 Move (moved to another folder right away). It keeps feeding the next
  // bookmark until as many are accepted as the batch size, then the first
  // tab carries on with exactly those. State lives in localStorage (same
  // origin, shared by both tabs); each tab's own copy of this script reads it.
  // ------------------------------------------------------------------
  const BPR_KEY = 'ycfp-bp-review-v1';
  const BPR_TAB = 'ycfp-bpr-tab';
  const bprLoad = () => { try { return JSON.parse(localStorage.getItem(BPR_KEY) || 'null'); } catch (e) { return null; } };
  const bprSave = (st) => { try { localStorage.setItem(BPR_KEY, JSON.stringify(st)); } catch (e) { /* quota */ } };
  const bprAccepted = (st) => st.items.filter((it) => st.dec[it.id] === 'accept');
  const bprUrl = (st, i) => `${st.items[i].url.split('#')[0]}#ycfp-bpr-${st.token}`;

  async function bpReviewBatch(items, bp, ui) {
    let folders = [];
    try { folders = await bmxListFolders(); } catch (e) { /* move picker stays empty */ }
    const st = {
      token: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      items: items.map((b) => ({ id: b.id, title: cleanBookmarkName(b.title) || b.url, url: b.url })),
      idx: 0, dec: {}, need: bp.batchSize, status: 'open', srcPath: bp.srcPath, folders, ts: Date.now(),
    };
    bprSave(st);
    const openBtn = el('button', { class: 'ycfp-btn' }, '🔍 Open the review tab');
    const finishBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Finish with what is accepted');
    const skipBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, `Skip review — take the first ${bp.batchSize}`);
    const status = el('div', {});
    const box = el('div', {},
      el('label', {}, `Review the ${items.length} bookmark(s) in a separate tab: ◀ ▶ to move around, ✓ Pull / ✕ Reject / 📁 Move. `
        + `It keeps going until ${bp.batchSize} are accepted.`),
      status, el('div', { class: 'ycfp-row' }, openBtn, finishBtn, skipBtn));
    ui.body.append(box);
    const open = () => window.open(bprUrl(st, 0), '_blank');
    openBtn.addEventListener('click', open);
    open(); // may be popup-blocked; the button is the fallback
    let accepted;
    try {
      accepted = await new Promise((resolve, reject) => {
        let timer = null;
        const finish = (fn, v) => { clearInterval(timer); window.removeEventListener('storage', tick); fn(v); };
        function tick() {
          const cur = bprLoad();
          if (!cur || cur.token !== st.token) { finish(reject, new Error('The review was replaced by another one.')); return; }
          const acc = bprAccepted(cur);
          const vals = Object.values(cur.dec);
          status.textContent = `Accepted ${acc.length} / ${cur.need} · rejected ${vals.filter((d) => d === 'reject').length}`
            + ` · moved ${vals.filter((d) => String(d).startsWith('moved')).length} · at ${cur.idx + 1} of ${cur.items.length}`;
          if (cur.status === 'done') finish(resolve, acc);
          else if (cur.status === 'cancelled') finish(reject, new Error('Review cancelled in the review tab.'));
          else if (ui.dlg && !ui.dlg.open) {
            cur.status = 'cancelled';
            bprSave(cur);
            finish(reject, new Error('Cancelled (dialog closed).'));
          }
        }
        timer = setInterval(tick, 700);
        window.addEventListener('storage', tick);
        finishBtn.addEventListener('click', () => { const c = bprLoad(); if (c) { c.status = 'done'; bprSave(c); } tick(); });
        skipBtn.addEventListener('click', () => {
          const c = bprLoad();
          if (c) {
            c.items.filter((it) => !c.dec[it.id]).slice(0, Math.max(0, c.need - bprAccepted(c).length))
              .forEach((it) => { c.dec[it.id] = 'accept'; });
            c.status = 'done';
            bprSave(c);
          }
          tick();
        });
      });
    } finally {
      box.remove();
    }
    const fin = bprLoad() || st;
    const moved = Object.values(fin.dec).filter((d) => String(d).startsWith('moved')).length;
    if (moved) ui.log(`${moved} bookmark(s) were moved to other folders during the review.`);
    const rejected = items.filter((b) => fin.dec[b.id] === 'reject');
    if (rejected.length) ui.log(`Rejected (left in "${bp.srcPath}"): ${rejected.map((b) => cleanBookmarkName(b.title)).join(', ')}`);
    const ids = new Set(accepted.map((r) => r.id));
    return items.filter((b) => ids.has(b.id)).slice(0, bp.batchSize);
  }

  let bprLastJson = '';
  function ensureBpReviewBar() {
    const m = location.hash.match(/ycfp-bpr-([a-z0-9]+)/);
    if (m) { try { sessionStorage.setItem(BPR_TAB, m[1]); } catch (e) { /* ignore */ } }
    let token = null;
    try { token = sessionStorage.getItem(BPR_TAB); } catch (e) { /* ignore */ }
    const st = token ? bprLoad() : null;
    let bar = document.getElementById('ycfp-bpr-bar');
    if (!st || st.token !== token || st.status !== 'open') {
      if (bar && st && st.token === token) {
        if (bar.dataset.final !== st.status) {
          bar.dataset.final = st.status;
          bar.replaceChildren(el('b', {}, st.status === 'done'
            ? `✅ Review finished — ${bprAccepted(st).length} accepted. Back to the first tab; this one can be closed.`
            : 'Review cancelled.'));
        }
      } else if (bar) bar.remove();
      return;
    }
    const json = JSON.stringify([st.idx, st.dec, location.pathname]);
    if (bar && json === bprLastJson) return;
    bprLastJson = json;
    if (!bar) {
      bar = el('div', {
        id: 'ycfp-bpr-bar',
        style: 'position:fixed;top:64px;right:16px;z-index:2147483000;background:#202020;color:#fff;'
          + 'border:2px solid #3ea6ff;border-radius:10px;padding:10px 12px;font:13px Roboto,Arial,sans-serif;'
          + 'max-width:380px;box-shadow:0 6px 24px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:6px',
      });
      document.body.append(bar);
    }
    const it = st.items[st.idx];
    const acc = bprAccepted(st).length;
    const d = st.dec[it.id];
    const btn = (label, title, fn, bg) => {
      const b = el('button', {
        title,
        style: `cursor:pointer;border:0;border-radius:6px;padding:5px 9px;font-size:13px;color:#fff;background:${bg || '#3f3f3f'}`,
      }, label);
      b.addEventListener('click', fn);
      return b;
    };
    const rerender = () => { bprLastJson = ''; ensureBpReviewBar(); };
    const go = (i) => {
      const c = bprLoad();
      if (!c || c.token !== st.token) return;
      c.idx = Math.max(0, Math.min(c.items.length - 1, i));
      bprSave(c);
      location.href = bprUrl(c, c.idx);
    };
    const decide = (val) => {
      const c = bprLoad();
      if (!c || c.token !== st.token) return;
      c.dec[it.id] = val;
      if (bprAccepted(c).length >= c.need) c.status = 'done';
      else if (c.idx < c.items.length - 1) {
        c.idx++;
        bprSave(c);
        location.href = bprUrl(c, c.idx);
        return;
      }
      bprSave(c);
      rerender();
    };
    const sel = el('select', { style: 'max-width:220px;background:#303030;color:#fff;border:1px solid #555;border-radius:4px' },
      el('option', { value: '' }, '📁 Move to folder…'),
      ...(st.folders || []).filter((f) => normTitle(f) !== normTitle(st.srcPath)).map((f) => el('option', { value: f }, f)));
    sel.addEventListener('change', async () => {
      const dest = sel.value;
      if (!dest) return;
      sel.disabled = true;
      try {
        const r = await bmxMoveBookmarks([it.id], dest);
        if (!r.moved.length) throw new Error((r.failed[0] && r.failed[0].error) || 'not moved');
        decide(`moved:${dest}`);
      } catch (e) {
        alert(`Could not move this bookmark: ${e.message || e}`);
        sel.disabled = false;
      }
    });
    const left = st.items.length - st.idx - 1;
    bar.replaceChildren(
      el('div', { style: 'display:flex;gap:6px;align-items:center;justify-content:space-between' },
        el('b', {}, `📥 Pull review ${st.idx + 1}/${st.items.length}`),
        el('span', { style: 'display:flex;gap:4px' },
          btn('◀', 'Previous bookmark', () => go(st.idx - 1)),
          btn('▶', 'Next bookmark (no decision)', () => go(st.idx + 1)))),
      el('div', {}, it.title),
      el('div', { style: 'opacity:.8' }, `Accepted ${acc} of ${st.need}`
        + `${d ? ` · this one: ${String(d).replace(/^moved:/, 'moved to ')}` : ''} · ${left} more after this`),
      el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
        btn('✓ Pull', 'Pull this channel in this batch', () => decide('accept'), '#1b7f3b'),
        btn('✕ Reject', 'Skip it this run — the bookmark stays where it is', () => decide('reject'), '#9b2c2c'),
        sel),
      el('div', { style: 'display:flex;gap:6px' },
        btn(`✔ Finish (${acc})`, 'Stop reviewing and pull what is accepted so far', () => {
          const c = bprLoad(); if (c) { c.status = 'done'; bprSave(c); } rerender();
        }),
        btn('Cancel pull', 'Abandon this pull', () => {
          const c = bprLoad(); if (c) { c.status = 'cancelled'; bprSave(c); } rerender();
        })));
  }

  async function runBatchPullFlow() {
    if (running) return;
    running = true;
    let afterDedupe = null;
    const cfg = loadCfg();
    const bp = loadBp();
    const ui = openDialog('Pull channels from bookmarks (batch)', true);
    try {
      const srcInput = el('input', { type: 'text', value: bp.srcPath });
      const destInput = el('input', { type: 'text', value: bp.destPath });
      const sizeInput = el('input', { type: 'number', value: String(bp.batchSize), min: '1', max: '100' });
      const searchInput = el('input', { type: 'text', value: bp.searchPath });
      const nameInput = el('input', { type: 'text', value: `Batch Pull ${nsToday()}` });
      const opts = collectOptionRows(cfg);
      const startBtn = el('button', { class: 'ycfp-btn' }, 'Pull channels');
      const form = el('div', {},
        el('label', {}, 'Source folder (bookmarks path, top level only — subfolders skipped):'),
        srcInput,
        el('label', {}, 'Move processed bookmarks to:'),
        destInput,
        el('label', {}, 'Ticked main/Topic counterparts get bookmarked there too — existing bookmarks of them anywhere in this folder (and its subfolders) are moved:'),
        searchInput,
        el('label', {}, 'How many channels (alphabetically) to pull this run:'),
        sizeInput,
        el('label', {}, 'Into the playlist (reused if one with this name exists, else created):'),
        nameInput,
        ...opts.rows,
        el('div', { class: 'ycfp-row' }, startBtn));
      ui.body.append(form);
      await new Promise((res) => {
        startBtn.addEventListener('click', res, { once: true });
        ui.dlg.addEventListener('close', res);
      });
      ui.guard();
      opts.apply();
      bp.srcPath = srcInput.value.trim() || BP_DEFAULTS.srcPath;
      bp.destPath = destInput.value.trim() || BP_DEFAULTS.destPath;
      bp.batchSize = Math.max(1, parseInt(sizeInput.value, 10) || BP_DEFAULTS.batchSize);
      bp.searchPath = searchInput.value.trim() || BP_DEFAULTS.searchPath;
      saveBp(bp);
      form.remove();

      ui.log(`Reading "${bp.srcPath}"…`);
      const items = await bmxListFolder(bp.srcPath);
      ui.log(`${items.length} channel bookmark(s) found directly in the folder (subfolders skipped).`);
      if (!items.length) { ui.log('Nothing to pull.'); return; }

      items.sort((a, b) =>
        normTitle(cleanBookmarkName(a.title)).localeCompare(normTitle(cleanBookmarkName(b.title))));
      const batch = await bpReviewBatch(items, bp, ui);
      ui.guard();
      if (!batch.length) { ui.log('Nothing accepted — nothing to pull.'); return; }
      ui.log(`Pulling ${batch.length}: ${batch.map((b) => cleanBookmarkName(b.title)).join(', ')}`);

      // --- scan phase: resolve every channel and its companion first, so the
      // whole batch can be reviewed before a single video is added ---
      const prepped = [];
      const unresolved = [];
      for (const bm of batch) {
        ui.guard();
        const label = cleanBookmarkName(bm.title) || bm.url;
        ui.log(`Resolving "${label}"…`);
        let chId = null;
        try {
          chId = await resolveChannelInput(bm.url);
        } catch (e) { chId = null; }
        if (!chId) {
          ui.log(`⚠ Could not resolve "${label}" — left in place for a retry.`);
          unresolved.push({ label, why: 'channel link could not be resolved' });
          continue;
        }
        let channelTitle, main, rawTop;
        try {
          ({ channelTitle, main, rawTop } = await fetchMainUploads(chId, cfg, ui.log, ui.guard));
        } catch (e) {
          ui.guard(); // re-throws on user cancel; otherwise skip this channel
          ui.log(`⚠ Skipped "${label}": ${e.message || e} — left in place for a retry.`);
          unresolved.push({ label, why: e.message || String(e) });
          continue;
        }
        let companion = null;
        try {
          companion = await resolveCompanion(chId, channelTitle, main, cfg, ui.log, ui.guard);
        } catch (e) {
          ui.guard();
          companion = { id: null, name: channelTitle, label: 'Companion channel', error: e.message || String(e) };
          ui.log(`⚠ ${channelTitle}: companion search failed (${companion.error}) — main channel only.`);
        }
        prepped.push({ bm, chId, channelTitle, main, rawTop, companion });
      }
      if (!prepped.length) { ui.log('❌ Nothing could be resolved — nothing pulled.'); return; }

      // --- review phase: the found main/Topic counterparts, each one
      // opt-out-able, plus everything that couldn't be matched ---
      const missing = prepped.filter((p) => p.companion && !p.companion.id && !p.companion.off);
      const found = prepped.filter((p) => p.companion && p.companion.id);
      const reviewRows = el('div', { class: 'ycfp-results' },
        ...prepped.map((p) => companionReviewBlock(p, 'pull')));

      const tickBtn = el('button', { class: 'ycfp-mini-btn' }, 'Untick all counterparts');
      tickBtn.addEventListener('click', () => {
        const on = tickBtn.textContent === 'Tick all counterparts';
        for (const p of found) for (const ch of (p.companionChoices || [])) ch.cb.checked = on;
        tickBtn.textContent = on ? 'Untick all counterparts' : 'Tick all counterparts';
      });
      const goBtn = el('button', { class: 'ycfp-btn' }, `Pull these ${prepped.length} channel(s)`);
      const ambiguous = found.filter((p) => (p.companion.candidates || []).length > 1);
      const notes = [
        `${prepped.length} channel(s) ready.`,
        found.length ? `${found.length} main/Topic counterpart(s) found — untick any that isn't the same artist.` : '',
        ambiguous.length ? `⚠ ${ambiguous.length} name(s) matched several channels — pick the right one: ${ambiguous.map((p) => p.channelTitle).join(', ')}.` : '',
        missing.length ? `⚠ No counterpart found for: ${missing.map((p) => p.channelTitle).join(', ')}.` : '',
        unresolved.length ? `⚠ Not resolved at all (stay in "${bp.srcPath}"): ${unresolved.map((u) => u.label).join(', ')}.` : '',
      ].filter(Boolean);
      for (const n of notes.slice(1)) ui.log(n);
      // Nothing to eyeball (Topic matching off, or every channel matched
      // nothing) — don't make the user click through an empty review.
      if (found.length || missing.length) {
        const review = el('div', {},
          el('label', {}, notes.join(' ')),
          reviewRows,
          el('div', { class: 'ycfp-row' }, goBtn, found.length ? tickBtn : null));
        ui.body.append(review);
        await new Promise((res) => {
          goBtn.addEventListener('click', res, { once: true });
          ui.dlg.addEventListener('close', res);
        });
        ui.guard();
        const dropped = [];
        for (const p of found) {
          for (const ch of (p.companionChoices || [])) if (!ch.cb.checked) dropped.push(ch.entry.name);
        }
        if (dropped.length) {
          ui.log(`Skipping ${dropped.length} counterpart(s) you unticked: ${dropped.join(', ')}.`);
        }
        review.remove();
      }

      const excl = await buildExclusionSets(cfg, ui.log, ui.guard);

      // Target: "Batch Pull YYYY-MM-DD" — reused if it already exists today
      // (same convention as the "New Songs" playlist).
      const title = nameInput.value.trim() || `Batch Pull ${nsToday()}`;
      ui.log(`Looking for an existing "${title}" playlist…`);
      const own = await getOwnPlaylists(ui.log);
      const existingPl = own.find((p) => normTitle(p.title) === normTitle(title));
      let targetId = existingPl ? existingPl.id : null;
      // With duplicate skipping on, title / fuzzy look-alikes are NOT dropped
      // silently any more: they are added, and 🧹 Dedupe opens afterwards
      // with this playlist's copies pre-checked, so you see each one.
      // Exact same-video hits and the deleted-video ledger still skip.
      const review = !!(cfg.dedupeByTitleDuration || cfg.fuzzyCollect);
      const fcfg = review ? Object.assign({}, cfg, { dedupeByTitleDuration: false, fuzzyCollect: false }) : cfg;
      let have;
      if (targetId) {
        const existing = await fetchPlaylistVideos(targetId, 'Target playlist', ui.log, ui.guard);
        have = makeHaveSets(existing, fcfg);
      } else {
        have = makeHaveSets([], fcfg);
      }

      let totalAdded = 0;
      const doneIds = [];
      const names = [];
      const counterparts = []; // ticked companions of the channels that went through
      for (const p of prepped) {
        ui.guard();
        const { bm, channelTitle } = p;
        let videos;
        try {
          const companionVids = await fetchChosenCompanions(p, cfg, ui.log, ui.guard, ui.link, false);
          videos = p.main.concat(companionVids);
        } catch (e) {
          ui.guard(); // re-throws on user cancel; otherwise skip this channel
          ui.log(`⚠ Skipped "${channelTitle}": ${e.message || e} — left in place for a retry.`);
          continue;
        }
        names.push(channelTitle);

        // Exclusions + dedupe against the target playlist, cumulative across
        // every channel already processed this run — same approach as
        // "Collect multiple channels".
        const kept = [];
        let nEx = 0, nDup = 0, nGone = 0, n = 0;
        for (const v of videos) {
          if (++n % 300 === 0) await sleep(0);
          const vars = fcfg.fuzzyCollect && v.seconds > 0 ? titleVariants(v.title, v.channel) : null;
          if (excl.exclIds.has(v.id)
            || (fcfg.dedupeByTitleDuration && titleDurationHit(excl.exclKeys, v.title, v.seconds))
            || (vars && fuzzBucketHit(excl.exclFuzz, vars, v.seconds))) { nEx++; continue; }
          if (goneHit(excl, v, cfg)) { nGone++; continue; }
          if (have.ids.has(v.id)
            || (fcfg.dedupeByTitleDuration && titleDurationHit(have.keys, v.title, v.seconds))
            || (vars && fuzzBucketHit(have.fuzz, vars, v.seconds))) { nDup++; continue; }
          have.ids.add(v.id);
          if (fcfg.dedupeByTitleDuration && v.seconds > 0) have.keys.add(dupeKey(v));
          if (vars) fuzzBucketAdd(have.fuzz, v.seconds, vars);
          kept.push(v);
        }
        ui.log(`${channelTitle}: ${videos.length} → ${kept.length} new (${nEx} excluded, ${nDup} duplicates / already in target`
          + `${nGone ? `, ${nGone} you deleted before` : ''}).`);

        let ids = kept.map((v) => v.id);
        const room = PLAYLIST_CAP - have.count;
        if (ids.length > room) {
          ui.log(`⚠ Playlist cap: room for only ${room} more — truncating.`);
          ids = ids.slice(0, Math.max(0, room));
        }
        if (ids.length) {
          if (!targetId) {
            targetId = await createPlaylist(title, ids, cfg, ui.log, ui.guard);
          } else {
            await addToPlaylist(targetId, ids, cfg, ui.log, ui.guard);
          }
          have.count += ids.length;
          totalAdded += ids.length;
          ui.log(`${channelTitle}: added ${ids.length} (running total ${totalAdded}).`);
        }
        // Mark the channel as harvested in the New Songs store, at the
        // position its uploads feed had when we fetched it. Without this the
        // bookmark lands in the watched folder unmarked and New Songs only
        // baselines it the next time it runs — losing every upload in
        // between. Companions count too: they were fully pulled here as
        // well, and their own bookmarks are usually watched separately.
        // Deliberately a fetch-time position, not "now": anything uploaded
        // during this run is then still collectable next time.
        const nsTargets = [{ id: p.chId, name: channelTitle, top: p.rawTop }];
        for (const c of chosenCompanions(p)) {
          nsTargets.push({ id: c.id, name: c.name, top: c.rawTop });
        }
        const nsUrls = (bm && bm.url && p.chId) ? { [bm.url]: p.chId } : {};
        const { added: nsAdded, moved: nsMoved } = nsBaselineNow(nsTargets, nsUrls);
        if (nsAdded.length || nsMoved.length) {
          ui.log(`${channelTitle}: New songs will now start from this pull`
            + ` (${[...nsAdded, ...nsMoved].join(', ')}`
            + `${nsMoved.length ? ` — ${nsMoved.length} existing marker(s) moved forward` : ''}).`);
        }

        // A channel whose whole catalog turned out to be excluded/duplicate
        // still counts as successfully processed — nothing was lost, so its
        // bookmark can move on.
        doneIds.push(bm.id);
        counterparts.push(...chosenCompanions(p));
      }

      if (targetId) ui.link(`${ORIGIN}/playlist?list=${targetId}`, title);
      ui.log(totalAdded
        ? `✅ Added ${totalAdded} video(s) from ${names.length} channel(s).`
        : 'No new videos to add (everything already accounted for).');
      if (review && targetId && totalAdded) {
        afterDedupe = {
          focus: { id: targetId, title }, mode: cfg.fuzzyCollect ? 'fuzzy' : 'simple',
          carry: [`📥 Batch pull: added ${totalAdded} video(s) from ${names.length} channel(s) to "${title}".`],
        };
      }

      if (doneIds.length) {
        ui.log(`Moving ${doneIds.length} processed bookmark(s) to "${bp.destPath}"…`);
        try {
          const { moved, failed } = await bmxMoveBookmarks(doneIds, bp.destPath);
          ui.log(`Moved ${moved.length}/${doneIds.length}.`);
          for (const f of failed) ui.log(`⚠ Could not move bookmark ${f.id}: ${f.error}`);
        } catch (e) {
          ui.log(`⚠ Bookmarks were NOT moved: ${e.message || e}`);
        }
      }
      if (counterparts.length) {
        try {
          await bpBookmarkCounterparts(counterparts, bp.destPath, bp.searchPath, ui.log, ui.guard);
        } catch (e) {
          ui.guard();
          ui.log(`⚠ Counterparts were NOT bookmarked: ${e.message || e}`);
        }
      }
      if (doneIds.length < batch.length) {
        ui.log(`${batch.length - doneIds.length} channel(s) failed and stayed in "${bp.srcPath}" for next time.`);
      }
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
      if (afterDedupe) setTimeout(() => runDedupeFlow(afterDedupe), 400);
    }
  }

  // ------------------------------------------------------------------
  // Bookmark deduplicator
  //
  // Scans a bookmarks folder AND every subfolder under it for links that
  // point at the same thing written in different forms — most often one
  // channel bookmarked twice:
  //   https://www.youtube.com/@BRDGS
  //   https://www.youtube.com/channel/UCfUY1Y60grOtUOvI__biIlg
  //
  // Grouping follows the playlist deduplicator's tier idea, keyed on the
  // channel rather than the video:
  //   T1 same resolved UC… id (what matches @handle ↔ /channel/UC…)
  //   T2 same link form + name (@BRDGS ↔ @brdgs/videos — no API call)
  //   T3 same normalized URL (any link at all, YouTube or not)
  // There is no fuzzy tier: two links either point at one channel or they
  // don't, so nothing here is a judgement call the way similar titles are.
  //
  // The keeper is the nicest surviving form — @handle > /c/ > /user/ >
  // /channel/UC… , shorter URL wins ties — and every other member of the
  // group is pre-checked for removal, exactly like the playlist deduper
  // pre-checks redundant copies. One entry per group always survives
  // unless you force it.
  //
  // Reading and writing both go through the bookmarks-mover extension
  // (protocol ycfpBmx, v1.1.0+); the file-reading bridge is read-only.
  // ------------------------------------------------------------------
  const BD_KEY = 'ycfp-bmdupe-v1';
  const BD_DEFAULTS = {
    path: 'Bookmarks Bar/Music/Youtube',
    movePath: '',
    resolveHandles: true,
    youtubeOnly: true,
  };
  const loadBd = () => {
    try {
      const raw = kvGet(BD_KEY);
      if (raw) return Object.assign({}, BD_DEFAULTS, JSON.parse(raw));
    } catch (e) { /* use defaults */ }
    return Object.assign({}, BD_DEFAULTS);
  };
  const saveBd = (bd) => kvSet(BD_KEY, JSON.stringify(bd));

  const verAtLeast = (v, min) => {
    const a = String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const b = min.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return true;
  };

  // Preference order for which form of a channel link to KEEP.
  const BD_FORMS = {
    handle: { rank: 0, badge: '@', label: '@handle link' },
    c: { rank: 1, badge: '/c/', label: 'legacy /c/ link' },
    user: { rank: 2, badge: '/u/', label: 'legacy /user/ link' },
    id: { rank: 3, badge: 'UC', label: '/channel/UC… link' },
  };

  // Which channel a YouTube URL names, if any. Sub-paths are fine:
  // "/@BRDGS/videos" is still the @BRDGS channel.
  function bdChannelRef(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null;
    const p = u.pathname;
    let m = p.match(/^\/channel\/(UC[\w-]{22})/);
    if (m) return { form: 'id', key: m[1] };
    m = p.match(/^\/@([^/]+)/);
    if (m) return { form: 'handle', key: decodeURIComponent(m[1]).toLowerCase() };
    m = p.match(/^\/c\/([^/]+)/);
    if (m) return { form: 'c', key: decodeURIComponent(m[1]).toLowerCase() };
    m = p.match(/^\/user\/([^/]+)/);
    if (m) return { form: 'user', key: decodeURIComponent(m[1]).toLowerCase() };
    return null;
  }

  // Literal-duplicate key: same page ignoring protocol, www./m., trailing
  // slash, and tracking junk in the query (?v= and ?list= are kept, since
  // those DO decide what the link points at).
  function bdUrlKey(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^(www|m)\./i, '').toLowerCase();
      const path = u.pathname.replace(/\/+$/, '').toLowerCase();
      const qs = [];
      for (const k of ['v', 'list']) {
        const v = u.searchParams.get(k);
        if (v) qs.push(`${k}=${v}`);
      }
      return `${host}${path}${qs.length ? `?${qs.join('&')}` : ''}`;
    } catch (e) {
      return (url || '').trim().toLowerCase();
    }
  }

  // Strict URL → UC… resolution. resolveChannelInput() falls back to a
  // channel-NAME search when a URL doesn't resolve, which here could glue
  // two unrelated bookmarks into one "duplicate" group and offer a real
  // bookmark for deletion — so this uses the resolver endpoint only and
  // returns null when it says nothing.
  async function bdResolveUrl(url) {
    try {
      const data = await api('navigation/resolve_url', { url });
      const ep = deepFind(data, 'browseEndpoint');
      if (ep && ep.browseId && /^UC[\w-]{22}$/.test(ep.browseId)) return ep.browseId;
    } catch (e) { /* unresolvable — the link still groups by its text */ }
    return null;
  }

  // items → { entries, groups }. Groups are arrays of entry indices, each
  // holding 2+ links to the same thing.
  async function bdAnalyze(items, opts, log, guard) {
    const entries = items.map((b) => ({
      id: b.id,
      title: b.title || '',
      url: b.url,
      folder: b.folder || '',
      ref: bdChannelRef(b.url),
      urlKey: bdUrlKey(b.url),
      chId: null,
    }));
    // /channel/UC… links carry their id already — free, no API.
    for (const e of entries) if (e.ref && e.ref.form === 'id') e.chId = e.ref.key;

    if (opts.resolveHandles) {
      // One lookup per distinct URL, cached in the shared bookmark-URL → id
      // map that "New songs" also fills, so rescans are nearly free.
      const ns = loadNs();
      const byUrl = new Map();
      for (const e of entries) {
        if (!e.ref || e.ref.form === 'id') continue;
        const g = byUrl.get(e.url);
        if (g) g.push(e); else byUrl.set(e.url, [e]);
      }
      const urls = [...byUrl.keys()];
      const fresh = urls.filter((u) => !ns.urlToId[u]);
      log(`${urls.length} non-UC link(s) to identify: ${urls.length - fresh.length} already cached, ${fresh.length} need a lookup.`);
      let n = 0, failed = 0;
      for (const url of urls) {
        guard();
        let id = ns.urlToId[url];
        if (!id) {
          log(`Identifying ${++n}/${fresh.length}: ${url}`, true);
          id = await bdResolveUrl(url);
          if (id) ns.urlToId[url] = id; else failed++;
          await sleep(120);
        }
        if (id) for (const e of byUrl.get(url)) e.chId = id;
      }
      saveNs(ns);
      if (failed) log(`⚠ ${failed} link(s) could not be identified (dead or renamed?) — they still match other links with the same handle text.`);
    } else {
      log('Handle resolution off — only links whose text matches are grouped (@handle ↔ /channel/UC… pairs will be missed).');
    }

    // Union-find over every key an entry can be recognized by.
    const parent = entries.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    const firstByKey = new Map();
    const link = (key, i) => {
      if (!key) return;
      if (firstByKey.has(key)) union(firstByKey.get(key), i);
      else firstByKey.set(key, i);
    };
    entries.forEach((e, i) => {
      if (e.chId) link(`id:${e.chId}`, i);
      if (e.ref) link(`${e.ref.form}:${e.ref.key}`, i);
      link(`url:${e.urlKey}`, i);
    });

    const byRoot = new Map();
    entries.forEach((_, i) => {
      const r = find(i);
      const g = byRoot.get(r);
      if (g) g.push(i); else byRoot.set(r, [i]);
    });
    const groups = [...byRoot.values()].filter((g) => g.length > 1);
    // Biggest messes first; stable label order underneath.
    groups.sort((a, b) => b.length - a.length
      || normTitle(bdGroupLabel(a, entries)).localeCompare(normTitle(bdGroupLabel(b, entries))));
    return { entries, groups };
  }

  const bdRank = (e) => (e.ref ? BD_FORMS[e.ref.form].rank : 4);

  // How far from canonical a URL is spelled. Same channel, same form, but
  // "http://m.youtube.com/@ghost/" is a worse link to keep than
  // "https://www.youtube.com/@Ghost" — and the bare channel page is a
  // better one than a deep link into its /videos tab.
  function bdUrlPenalty(url) {
    let p = 0;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') p += 4;
      if (u.hostname.toLowerCase() !== 'www.youtube.com') p += 2;
      const segs = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      // A channel page is 1 segment (/@name) or 2 (/channel/UC…, /c/x);
      // anything past that is a sub-page.
      p += Math.max(0, segs.length - (/^(channel|c|user)$/i.test(segs[0] || '') ? 2 : 1));
      if (u.search) p += 1;
      if (u.hash) p += 1;
    } catch (e) {
      p += 8;
    }
    return p;
  }

  // The link to keep: nicest form (@handle first), then the most canonical
  // spelling of it, then the shortest, then whichever was found first.
  function bdKeeper(group, entries) {
    return [...group].sort((a, b) => bdRank(entries[a]) - bdRank(entries[b])
      || bdUrlPenalty(entries[a].url) - bdUrlPenalty(entries[b].url)
      || entries[a].url.length - entries[b].url.length
      || a - b)[0];
  }

  function bdGroupLabel(group, entries) {
    const k = entries[bdKeeper(group, entries)];
    return cleanBookmarkName(k.title) || (k.ref ? k.ref.key : k.urlKey);
  }

  // A group whose members disagree about which channel they are (one
  // resolved to a different UC… id than another) is only held together by
  // an exact-URL or same-handle match — worth an eyeball before deleting.
  function bdGroupMixed(group, entries) {
    const ids = new Set(group.map((i) => entries[i].chId).filter(Boolean));
    return ids.size > 1;
  }

  // A–Z inside a bookmarks folder and (optionally) every subfolder: folders
  // first, then bookmarks; nothing changes folder. Extension v1.4.0+.
  async function runBookmarkSortFlow() {
    if (running) return;
    running = true;
    const ui = openDialog('Sort bookmarks A–Z');
    try {
      const version = await bmxPing();
      if (!verAtLeast(version, '1.4.0')) {
        throw new Error(`The YCFP Bookmarks Mover extension is v${version}; sorting needs v1.4.0+. `
          + 'Reload it in brave://extensions (Developer mode → the extension card → ⟳), then reload this YouTube tab.');
      }
      let folderPaths = [];
      try { folderPaths = await bmxListFolders(); } catch (e) { /* type it instead */ }
      const def = folderPaths.find((p) => p.toLowerCase() === 'bookmarks bar/music/youtube') || 'Bookmarks Bar/Music/Youtube';
      const pathInput = folderPaths.length
        ? el('select', {}, ...folderPaths.map((p) => el('option', { value: p }, p)))
        : el('input', { type: 'text', value: def });
      pathInput.value = def;
      const recCb = el('input', { type: 'checkbox', checked: true });
      const goBtn = el('button', { class: 'ycfp-btn' }, 'Sort');
      const form = el('div', {},
        el('label', {}, 'Folder to sort:'),
        pathInput,
        el('label', { class: 'ycfp-check' }, recCb, el('span', {}, 'Every subfolder too (each sorted on its own)')),
        el('div', { class: 'ycfp-row' }, goBtn));
      ui.body.append(form);
      await new Promise((res) => {
        goBtn.addEventListener('click', res, { once: true });
        ui.dlg.addEventListener('close', res);
      });
      ui.guard();
      const path = (pathInput.value || '').trim();
      form.remove();
      ui.log(`Sorting "${path}"${recCb.checked ? ' and its subfolders' : ''}…`);
      const d = await bmxRequest({ ycfpBmx: 'sortFolder', path, recursive: recCb.checked }, 300000,
        'The Bookmarks Mover extension did not answer in time — the sort may still be running; reopen to check.');
      ui.log(`✅ ${d.folders} folder(s) sorted, ${d.moved} item(s) moved into place.`);
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  async function runBookmarkDedupeFlow() {
    if (running) return;
    running = true;
    const bd = loadBd();
    const ui = openDialog('Bookmark deduplicator', true);
    try {
      const version = await bmxPing();
      if (!verAtLeast(version, '1.1.0')) {
        throw new Error(`The YCFP Bookmarks Mover extension is v${version}; this needs v1.1.0+. `
          + 'Reload it in brave://extensions (Developer mode → the extension card → ⟳), then reload this YouTube tab.');
      }

      // --- options step ---
      // Folder picker, so the path never has to be typed. Falls back to a
      // text field if the folder list can't be read for any reason.
      let folderPaths = [];
      try { folderPaths = await bmxListFolders(); } catch (e) { ui.log(`⚠ Could not list folders (${e.message || e}) — type the path instead.`); }
      let pathInput;
      if (folderPaths.length) {
        if (bd.path && !folderPaths.includes(bd.path)) folderPaths = [bd.path, ...folderPaths];
        pathInput = el('select', {}, ...folderPaths.map((p) => el('option', { value: p }, p)));
        pathInput.value = bd.path;
      } else {
        pathInput = el('input', { type: 'text', value: bd.path });
      }
      const resolveCb = el('input', { type: 'checkbox', checked: bd.resolveHandles });
      const ytCb = el('input', { type: 'checkbox', checked: bd.youtubeOnly });
      const scanBtn = el('button', { class: 'ycfp-btn' }, 'Scan for duplicate bookmarks');
      const form = el('div', {},
        el('label', {}, 'Folder to scan (this folder and every subfolder under it):'),
        pathInput,
        el('label', { class: 'ycfp-check' }, resolveCb,
          el('span', {}, 'Look up @handle / legacy links via YouTube (needed to match @handle ↔ /channel/UC… — cached, so only the first scan is slow)')),
        el('label', { class: 'ycfp-check' }, ytCb,
          el('span', {}, 'YouTube links only (uncheck to also catch identical non-YouTube bookmarks)')),
        el('div', { class: 'ycfp-row' }, scanBtn));
      ui.body.append(form);
      await new Promise((res) => {
        scanBtn.addEventListener('click', res, { once: true });
        ui.dlg.addEventListener('close', res);
      });
      ui.guard();
      bd.path = (pathInput.value || '').trim() || BD_DEFAULTS.path;
      bd.resolveHandles = resolveCb.checked;
      bd.youtubeOnly = ytCb.checked;
      saveBd(bd);
      form.remove();

      // --- scan ---
      ui.log(`Reading "${bd.path}" and all its subfolders…`);
      const { items, total } = await bmxListTree(bd.path, bd.youtubeOnly);
      ui.log(`${items.length} bookmark(s)${bd.youtubeOnly && total !== items.length ? ` (of ${total}; non-YouTube links skipped)` : ''}.`);
      if (items.length < 2) { ui.log('Nothing to compare.'); return; }

      const { entries, groups } = await bdAnalyze(items, bd, ui.log, ui.guard);
      ui.guard();
      if (!groups.length) { ui.log('✅ No duplicate bookmarks found.'); return; }
      const dupCount = groups.reduce((n, g) => n + g.length - 1, 0);
      ui.log(`Found ${groups.length} duplicate group(s) — ${dupCount} link(s) beyond the one kept in each.`);

      // --- results UI --- (checkbox semantics: CHECKED = delete)
      const rows = []; // {i, gi, cb, rowEl}
      const cbByIndex = new Map();
      const keepers = new Map(); // group index → entry index kept by default
      const groupEls = groups.map((g, gi) => {
        const keeper = bdKeeper(g, entries);
        keepers.set(gi, keeper);
        const groupCbs = [];
        const groupRows = g.map((i) => {
          const e = entries[i];
          const isKeeper = i === keeper;
          const cb = el('input', {
            type: 'checkbox',
            title: isKeeper ? 'This is the preferred link — kept by default' : 'Check to DELETE this bookmark',
          });
          groupCbs.push(cb);
          const f = e.ref ? BD_FORMS[e.ref.form] : null;
          const rowEl = el('div', { class: 'ycfp-entry' },
            cb,
            el('span', {
              class: 'ycfp-entry-dur',
              title: f ? f.label : 'not a channel link',
            }, f ? f.badge : '—'),
            el('a', {
              class: 'ycfp-entry-title',
              href: e.url,
              target: '_blank',
              rel: 'noreferrer',
              title: `${e.title}\n${e.url}\n— open in a new tab to verify`,
            }, cleanBookmarkName(e.title) || e.url),
            el('span', { class: 'ycfp-entry-ch', title: e.url }, e.url.replace(/^https?:\/\/(www\.)?/, '')),
            el('span', {
              class: 'ycfp-entry-pl',
              title: `${bd.path}${e.folder ? `/${e.folder}` : ''}`,
            }, e.folder || '(top level)'));
          rows.push({ i, gi, cb, rowEl });
          cbByIndex.set(i, cb);
          return rowEl;
        });
        const mixed = bdGroupMixed(g, entries);
        const checkAll = el('button', { class: 'ycfp-mini-btn', title: 'Check every link in this group' }, 'Check all');
        checkAll.addEventListener('click', () => { groupCbs.forEach((cb) => { cb.checked = true; }); });
        const uncheckAll = el('button', { class: 'ycfp-mini-btn', title: 'Uncheck every link in this group' }, 'Uncheck all');
        uncheckAll.addEventListener('click', () => { groupCbs.forEach((cb) => { cb.checked = false; }); });
        return el('div', { class: 'ycfp-group' + (mixed ? ' ycfp-group-xch' : '') },
          el('div', { class: 'ycfp-group-head' },
            mixed ? el('span', {
              class: 'ycfp-xch-star',
              title: 'These links resolved to DIFFERENT channels — check before deleting',
            }, '*') : null,
            el('span', { class: 'ycfp-grp-label' },
              `#${gi + 1} · ${bdGroupLabel(g, entries)} · ${g.length} links`),
            checkAll, uncheckAll),
          ...groupRows);
      });
      const resultsEl = el('div', { class: 'ycfp-results' }, ...groupEls);

      const gone = (r) => r.rowEl.classList.contains('ycfp-entry-gone');

      // Default selection: keep the preferred link of each group, check the
      // rest. Mixed groups (links that resolved to different channels) are
      // left entirely unchecked — those need eyes, not a default.
      const applyPreferred = () => {
        let checked = 0, skipped = 0;
        for (const [gi, g] of groups.entries()) {
          const live = g.filter((i) => !gone(rows.find((r) => r.i === i)));
          if (bdGroupMixed(live, entries)) {
            live.forEach((i) => { cbByIndex.get(i).checked = false; });
            skipped++;
            continue;
          }
          const keeper = live.includes(keepers.get(gi)) ? keepers.get(gi) : bdKeeper(live, entries);
          for (const i of live) {
            const on = i !== keeper;
            cbByIndex.get(i).checked = on;
            if (on) checked++;
          }
        }
        return { checked, skipped };
      };
      const pre = applyPreferred();
      ui.log(`Pre-checked ${pre.checked} link(s) for deletion — the preferred form (@handle where there is one) is kept in every group.`
        + (pre.skipped ? ` ${pre.skipped} group(s) marked ★ resolved to different channels and were left unchecked.` : ''));

      // Hide-unselected toggle, same as the playlist deduper's.
      let hideUnsel = false;
      const hideBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Hide unselected');
      const applyHide = () => {
        for (const r of rows) r.rowEl.classList.toggle('ycfp-row-hidden', hideUnsel && !r.cb.checked);
        groupEls.forEach((gEl, gi) => {
          const any = groups[gi].some((i) => cbByIndex.get(i).checked);
          gEl.classList.toggle('ycfp-group-hidden', hideUnsel && !any);
        });
      };
      hideBtn.addEventListener('click', () => {
        hideUnsel = !hideUnsel;
        hideBtn.textContent = hideUnsel ? 'Show all' : 'Hide unselected';
        hideBtn.classList.toggle('ycfp-on', hideUnsel);
        applyHide();
      });
      resultsEl.addEventListener('change', () => { if (hideUnsel) applyHide(); });

      // Checked = delete. A group with every live link checked would leave
      // no bookmark for that channel at all — that needs Force continue.
      const buildPlan = () => {
        const toRemove = [];
        let emptiedGroups = 0;
        for (const g of groups) {
          const live = rows.filter((r) => g.includes(r.i) && !gone(r));
          if (!live.length) continue;
          const checked = live.filter((r) => r.cb.checked);
          if (!checked.length) continue;
          if (checked.length === live.length) emptiedGroups++;
          for (const r of checked) toRemove.push(r);
        }
        return { toRemove, emptiedGroups };
      };

      let lastRemoved = null;
      const undoBtn = el('button', { class: 'ycfp-btn ycfp-secondary', style: 'display:none' }, '↩ Undo last deletion');
      undoBtn.addEventListener('click', async () => {
        if (undoBtn.disabled || !lastRemoved) return;
        undoBtn.disabled = true;
        try {
          const { created, failed } = await bmxCreateBookmarks(lastRemoved.records, bd.path);
          // A restored bookmark comes back with a NEW id — carry it over, or
          // deleting that row again would address a bookmark that's gone.
          const newIds = new Map(created.map((c) => [c.oldId, c.id]));
          for (const r of lastRemoved.rows) {
            const fresh = newIds.get(entries[r.i].id);
            if (!fresh) continue;
            entries[r.i].id = fresh;
            r.rowEl.classList.remove('ycfp-entry-gone');
          }
          ui.log(`↩ Restored ${created.length} bookmark(s)${failed.length ? `, ${failed.length} failed` : ''}.`);
          for (const f of failed) ui.log(`⚠ Could not restore ${f.url}: ${f.error}`);
          lastRemoved = null;
          undoBtn.style.display = 'none';
        } catch (e) {
          ui.log(`❌ ${e.message || e}`);
        } finally {
          undoBtn.disabled = false;
        }
      });

      const doRemove = async (plan) => {
        ui.log(`Deleting ${plan.toRemove.length} bookmark(s)…`);
        const { removed, failed } = await bmxRemoveBookmarks(plan.toRemove.map((r) => entries[r.i].id));
        const okIds = new Set(removed.map((n) => n.id));
        const okRows = plan.toRemove.filter((r) => okIds.has(entries[r.i].id));
        for (const r of okRows) { r.rowEl.classList.add('ycfp-entry-gone'); r.cb.checked = false; }
        for (const f of failed) ui.log(`⚠ Could not delete bookmark ${f.id}: ${f.error}`);
        lastRemoved = removed.length ? { records: removed, rows: okRows } : null;
        undoBtn.style.display = lastRemoved ? '' : 'none';
        ui.log(`✅ Done: ${removed.length} bookmark(s) deleted${failed.length ? `, ${failed.length} failed` : ''}.`
          + (removed.length ? ' Use ↩ Undo to put them back where they were.' : ''));
      };

      let warnEl = null;
      const clearWarn = () => { if (warnEl) { warnEl.remove(); warnEl = null; } };
      const removeBtn = el('button', { class: 'ycfp-btn' }, 'Delete checked bookmarks');
      // Deleting is the one irreversible-looking step here, so it always
      // goes through a confirmation that spells out what is about to go.
      removeBtn.addEventListener('click', () => {
        if (removeBtn.disabled) return;
        clearWarn();
        const plan = buildPlan();
        if (!plan.toRemove.length) { ui.log('Nothing checked — tick the links you want deleted.'); return; }
        const sample = plan.toRemove.slice(0, 5).map((r) => cleanBookmarkName(entries[r.i].title) || entries[r.i].url);
        const goBtn = el('button', { class: 'ycfp-btn' },
          plan.emptiedGroups ? 'Force continue' : `Yes, delete ${plan.toRemove.length}`);
        const cancelBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Cancel');
        warnEl = el('div', { class: 'ycfp-warn' },
          el('div', {}, `About to delete ${plan.toRemove.length} bookmark(s): `
            + sample.join(', ') + (plan.toRemove.length > sample.length ? `, +${plan.toRemove.length - sample.length} more` : '')),
          plan.emptiedGroups
            ? el('div', {}, `⚠ ${plan.emptiedGroups} group(s) have EVERY link checked — those channels would be left with no bookmark at all.`)
            : null,
          el('div', {}, 'They can be put back with ↩ Undo right afterwards.'),
          el('div', { class: 'ycfp-row' }, cancelBtn, goBtn));
        cancelBtn.addEventListener('click', clearWarn);
        goBtn.addEventListener('click', async () => {
          clearWarn();
          removeBtn.disabled = true;
          try { await doRemove(buildPlan()); }
          catch (e) { ui.log(`❌ ${e.message || e}`); }
          finally { removeBtn.disabled = false; }
        });
        removeBtn.parentElement.insertAdjacentElement('beforebegin', warnEl);
      });

      const uncheckBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Uncheck all');
      uncheckBtn.addEventListener('click', () => {
        rows.forEach((r) => { if (!gone(r)) r.cb.checked = false; });
        if (hideUnsel) applyHide();
      });
      const preferBtn = el('button', {
        class: 'ycfp-btn ycfp-secondary',
        title: 'Re-apply the default: keep the @handle form of each channel, check the rest',
      }, '↺ Prefer @handle links');
      preferBtn.addEventListener('click', () => {
        const p = applyPreferred();
        ui.log(`Checked ${p.checked} link(s) — one preferred link kept per group.`);
        if (hideUnsel) applyHide();
      });

      // Bulk selection by folder: CHECKS the duplicate links that live in
      // one folder. Same rule as the playlist deduper's per-playlist bulk —
      // a group with nothing outside that folder keeps its first link, so
      // this can never wipe a channel entirely.
      const folderCounts = new Map();
      for (const g of groups) {
        for (const i of g) {
          const f = entries[i].folder;
          folderCounts.set(f, (folderCounts.get(f) || 0) + 1);
        }
      }
      const folderOpts = [...folderCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const bulkSel = el('select', {}, ...folderOpts.map(([f, n]) =>
        el('option', { value: f }, `${f || '(top level)'} — ${n} link(s) in duplicate groups`)));
      const bulkBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Select its duplicate links');
      bulkBtn.addEventListener('click', () => {
        const folder = bulkSel.value;
        let marked = 0, skippedMixed = 0;
        for (const g of groups) {
          const live = g.filter((i) => !gone(rows.find((r) => r.i === i)));
          if (live.length < 2) continue;
          if (bdGroupMixed(live, entries)) { skippedMixed++; continue; }
          const inF = live.filter((i) => entries[i].folder === folder);
          if (!inF.length) continue;
          const outside = live.filter((i) => entries[i].folder !== folder);
          const removeIdx = outside.length ? inF : inF.slice(1); // always leaves one
          for (const i of live) cbByIndex.get(i).checked = removeIdx.includes(i);
          marked += removeIdx.length;
        }
        ui.log((marked
          ? `Checked ${marked} link(s) in "${folder || '(top level)'}" — review, then press "Delete checked bookmarks".`
          : `No removable duplicate links in "${folder || '(top level)'}".`)
          + (skippedMixed ? ` Left ${skippedMixed} ★ group(s) alone — those resolved to different channels.` : ''));
        if (hideUnsel) applyHide();
      });

      // Non-destructive alternative: park the checked links in a folder and
      // look at them later instead of deleting them now.
      const moveSel = folderPaths.length
        ? el('select', {},
          el('option', { value: '' }, '— choose a folder —'),
          ...folderPaths.map((p) => el('option', { value: p }, p)))
        : el('input', { type: 'text', value: bd.movePath, placeholder: 'Bookmarks Bar/…' });
      if (folderPaths.length && bd.movePath && folderPaths.includes(bd.movePath)) moveSel.value = bd.movePath;
      const moveBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Move checked there instead');
      moveBtn.addEventListener('click', async () => {
        if (moveBtn.disabled) return;
        const dest = (moveSel.value || '').trim();
        if (!dest) { ui.log('Pick a destination folder first.'); return; }
        const plan = buildPlan();
        if (!plan.toRemove.length) { ui.log('Nothing checked.'); return; }
        moveBtn.disabled = true;
        try {
          bd.movePath = dest;
          saveBd(bd);
          ui.log(`Moving ${plan.toRemove.length} bookmark(s) to "${dest}"…`);
          const { moved, failed } = await bmxMoveBookmarks(plan.toRemove.map((r) => entries[r.i].id), dest);
          const okIds = new Set(moved);
          for (const r of plan.toRemove) {
            if (okIds.has(entries[r.i].id)) { r.rowEl.classList.add('ycfp-entry-gone'); r.cb.checked = false; }
          }
          for (const f of failed) ui.log(`⚠ Could not move bookmark ${f.id}: ${f.error}`);
          ui.log(`✅ Moved ${moved.length}/${plan.toRemove.length} to "${dest}".`);
        } catch (e) {
          ui.log(`❌ ${e.message || e}`);
        } finally {
          moveBtn.disabled = false;
        }
      });

      ui.body.append(
        resultsEl,
        el('div', { class: 'ycfp-row' }, removeBtn, uncheckBtn, preferBtn, hideBtn, undoBtn),
        el('label', {}, 'Select every duplicate link from one folder:'),
        el('div', { class: 'ycfp-row' }, bulkSel, bulkBtn),
        el('label', {}, 'Or park the checked links in a folder instead of deleting them:'),
        el('div', { class: 'ycfp-row' }, moveSel, moveBtn));
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  // ------------------------------------------------------------------
  // Playlist channels → bookmarks (📌)
  //
  // Folded in from the old standalone "YouTube Channel Bookmark Sync"
  // extension (yt-channel-bookmark-sync/), which needed a Data API key and
  // only recognized a bookmark when its /channel/UC… or @handle text matched
  // exactly. Reads the picked playlists through innertube like everything
  // else here, collects every distinct channel that owns a video in them,
  // and bookmarks the ones not yet bookmarked anywhere under the search
  // folder (subfolders included) into the target folder.
  //
  // "Already bookmarked" covers every form a channel link takes:
  //   - /channel/UC… (sub-pages too) — the id is compared directly;
  //   - @handle — compared with the channel's own handle from the playlist
  //     data (free), otherwise resolved to its UC… id;
  //   - /c/ and /user/ legacy links — resolved to their UC… id.
  // Resolution is strict (resolver only, never a name search — same reason
  // as the deduplicator) and shares the URL → id cache with 🆕 New songs and
  // 🔖 Bookmark dupes, so only links none of them has seen cost a request.
  // A channel whose main ↔ "- Topic" counterpart is bookmarked is listed
  // separately, unticked: known pairs (New songs / Pull batch) or a
  // same-artist name match among the bookmarks — no searches.
  // ------------------------------------------------------------------
  const PB_KEY = 'ycfp-plbookmark-v1';
  const PB_DEFAULTS = {
    selection: [],   // own playlist ids ticked last time
    extra: '',       // pasted playlist URLs / ids
    searchPath: 'Bookmarks Bar/Music/Youtube',
    targetPath: '',
    skipReleaseTopic: true,
  };
  const loadPb = () => {
    try {
      const raw = kvGet(PB_KEY);
      if (raw) return Object.assign({}, PB_DEFAULTS, JSON.parse(raw));
    } catch (e) { /* use defaults */ }
    return Object.assign({}, PB_DEFAULTS);
  };
  const savePb = (pb) => kvSet(PB_KEY, JSON.stringify(pb));
  const PB_ALL_ROOTS = ['Bookmarks Bar', 'Other Bookmarks'];

  // The link a new bookmark gets: @handle when the channel has one (the form
  // 🔖 Bookmark dupes keeps), else /channel/UC… (Topic channels never have a
  // handle).
  const pbChannelUrl = (ch) => (ch.path && ch.path.startsWith('/@')
    ? `https://www.youtube.com${ch.path}`
    : `https://www.youtube.com/channel/${ch.id}`);

  async function runPlaylistBookmarkFlow() {
    if (running) return;
    running = true;
    const pb = loadPb();
    const ui = openDialog('Bookmark the channels in playlists', true);
    try {
      const version = await bmxPing();
      if (!verAtLeast(version, '1.2.0')) {
        throw new Error(`The YCFP Bookmarks Mover extension is v${version}; this needs v1.2.0+. `
          + 'Reload it in brave://extensions (Developer mode → the extension card → ⟳), then reload this YouTube tab.');
      }

      // --- options step ---
      ui.log('Loading your playlists…');
      const pls = await getOwnPlaylists(ui.log);
      ui.guard();
      let folderPaths = [];
      try { folderPaths = await bmxListFolders(); } catch (e) { ui.log(`⚠ Could not list folders (${e.message || e}) — type the paths instead.`); }
      const folderPicker = (value, placeholder) => {
        if (!folderPaths.length) return el('input', { type: 'text', value, placeholder });
        // A typed path that differs only in case ("Bookmarks bar/…") is the
        // listed folder, not an extra option beside it.
        value = folderPaths.find((p) => p.toLowerCase() === String(value || '').toLowerCase()) || value;
        const paths = value && !folderPaths.includes(value) ? [value, ...folderPaths] : folderPaths;
        const sel = el('select', {},
          el('option', { value: '' }, '— choose a folder —'),
          ...paths.map((p) => el('option', { value: p }, p)));
        sel.value = value || '';
        return sel;
      };
      const remembered = new Set(pb.selection);
      const boxes = pls.map((p) => ({ p, cb: el('input', { type: 'checkbox', checked: remembered.has(p.id) }) }));
      const extraInput = el('textarea', {
        rows: '3',
        placeholder: 'Other playlists (anyone\'s, public/unlisted) — URLs or ids, one per line',
      });
      extraInput.value = pb.extra;
      const searchInput = folderPicker(pb.searchPath, 'Bookmarks Bar/…');
      // No target chosen yet → the search folder (Bookmarks Bar/Music/Youtube).
      const targetInput = folderPicker(pb.targetPath || pb.searchPath, 'Bookmarks Bar/…');
      const skipReleaseTopic = el('input', { type: 'checkbox', checked: pb.skipReleaseTopic });
      const scanBtn = el('button', { class: 'ycfp-btn' }, 'Find unbookmarked channels');
      const allBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Select all');
      allBtn.addEventListener('click', () => {
        const on = boxes.some((b) => !b.cb.checked);
        boxes.forEach((b) => { b.cb.checked = on; });
      });
      const form = el('div', {},
        el('label', {}, 'Playlists to read:'),
        el('div', { class: 'ycfp-pl-list' },
          ...boxes.map(({ p, cb }) => el('label', { class: 'ycfp-check' }, cb, el('span', {}, p.title)))),
        extraInput,
        el('label', {}, 'Already bookmarked = anywhere in this folder and every subfolder under it:'),
        searchInput,
        el('label', {}, 'Bookmark the missing channels into:'),
        targetInput,
        el('label', { class: 'ycfp-check' }, skipReleaseTopic,
          el('span', {}, 'Skip channels named “Release - Topic” (other Topic channels are included)')),
        el('div', { class: 'ycfp-row' }, scanBtn, allBtn, defaultSelBtn(boxes)));
      ui.body.append(form);
      let plan;
      for (;;) {
        await new Promise((res) => {
          scanBtn.addEventListener('click', res, { once: true });
          ui.dlg.addEventListener('close', res, { once: true });
        });
        ui.guard();
        const picked = boxes.filter((b) => b.cb.checked).map((b) => ({ id: b.p.id, title: b.p.title }));
        const extra = extraInput.value.split(/[\n,]+/).map(parsePlaylistId).filter(Boolean)
          .filter((id) => !picked.some((p) => p.id === id))
          .map((id) => ({ id, title: (pls.find((p) => p.id === id) || {}).title || id }));
        plan = {
          playlists: [...new Map([...picked, ...extra].map((p) => [p.id, p])).values()],
          searchPath: (searchInput.value || '').trim(),
          targetPath: (targetInput.value || '').trim(),
        };
        if (!plan.playlists.length) { ui.log('Pick at least one playlist (or paste one).'); continue; }
        if (!plan.searchPath || !plan.targetPath) { ui.log('Choose both the search folder and the target folder.'); continue; }
        break;
      }
      pb.selection = boxes.filter((b) => b.cb.checked).map((b) => b.p.id);
      pb.extra = extraInput.value;
      pb.searchPath = plan.searchPath;
      pb.targetPath = plan.targetPath;
      pb.skipReleaseTopic = skipReleaseTopic.checked;
      savePb(pb);
      form.remove();

      // --- read the playlists ---
      const chans = new Map(); // UC… → { id, name, path, count, lists: Set }
      let ownerless = 0;
      for (const p of plan.playlists) {
        ui.guard();
        const vids = await fetchPlaylistVideos(p.id, p.title, ui.log, ui.guard);
        const title = vids.title || p.title;
        const before = chans.size;
        for (const v of vids) {
          if (!v.channelId) { if (!v.dead) ownerless++; continue; }
          let c = chans.get(v.channelId);
          if (!c) { c = { id: v.channelId, name: '', path: '', count: 0, lists: new Set() }; chans.set(v.channelId, c); }
          if (!c.name && v.channel) c.name = v.channel.replace(/\s+/g, ' ').trim();
          if (!c.path && v.channelPath) c.path = v.channelPath;
          c.count++;
          c.lists.add(title);
        }
        ui.log(`${title}: ${vids.length} videos, ${chans.size - before} new channel(s).`);
      }
      if (ownerless) ui.log(`(${ownerless} video(s) carried no channel link — skipped.)`);
      ui.log(`${chans.size} distinct channel(s) across ${plan.playlists.length} playlist(s).`);
      if (!chans.size) { ui.log('Nothing to bookmark.'); return; }
      for (const c of chans.values()) if (!c.name) c.name = c.id;
      if (pb.skipReleaseTopic) {
        let skipped = 0;
        for (const [id, c] of chans) {
          if (/^release\s*[-–—]\s*topic$/i.test(c.name.trim())) { chans.delete(id); skipped++; }
        }
        if (skipped) ui.log(`Skipped ${skipped} “Release - Topic” channel(s).`);
        if (!chans.size) { ui.log('Nothing to bookmark after filtering.'); return; }
      }

      // --- index the bookmarks: search tree, plus the target's own tree so a
      // target outside the search folder never gets the same channel twice ---
      ui.log(`Reading "${plan.searchPath}" and all its subfolders…`);
      const byBmId = new Map();
      for (const path of new Set([plan.searchPath, plan.targetPath])) {
        const { items } = await bmxListTree(path, true);
        for (const b of items) byBmId.set(b.id, b);
      }
      // Channels kept anywhere else (e.g. See asap/Channels/Animation Ch)
      // count as bookmarked too, so they aren't offered again every run.
      let elsewhere = 0;
      for (const root of PB_ALL_ROOTS) {
        try {
          const { items } = await bmxListTree(root, true);
          for (const b of items) if (!byBmId.has(b.id)) { byBmId.set(b.id, b); elsewhere++; }
        } catch (e) { /* root missing — fine */ }
      }
      if (elsewhere) ui.log(`+ ${elsewhere} YouTube bookmark(s) outside that folder also checked.`);
      const ns = loadNs();
      const bmIds = new Map();      // UC… → bookmark title it was found under
      const bmKeys = new Map();     // "handle:x" / "c:x" / "user:x" → bookmark title
      const bmArtists = new Map();  // artist key → [{ title, topic }]
      const unresolved = new Map(); // url → title
      for (const b of byBmId.values()) {
        const ref = bdChannelRef(b.url);
        if (!ref) continue; // a video / playlist link, not a channel
        const name = cleanBookmarkName(b.title);
        if (ref.form === 'id') bmIds.set(ref.key, name);
        else {
          bmKeys.set(`${ref.form}:${ref.key}`, name);
          const cached = ns.urlToId[b.url];
          if (cached) bmIds.set(cached, name); else unresolved.set(b.url, name);
        }
        const ak = nsArtistKey(name);
        if (ak) {
          const arr = bmArtists.get(ak) || [];
          arr.push({ title: name, topic: TOPIC_SUFFIX.test(name) });
          bmArtists.set(ak, arr);
        }
      }
      ui.log(`${byBmId.size} YouTube bookmark(s) — ${bmIds.size} channel(s) known by id, ${unresolved.size} link(s) not identified yet.`);

      const handleKey = (c) => {
        const r = c.path ? bdChannelRef(`https://www.youtube.com${c.path}`) : null;
        return r && r.form !== 'id' ? `${r.form}:${r.key}` : null;
      };
      const matchOf = (c) => {
        if (bmIds.has(c.id)) return bmIds.get(c.id);
        const k = handleKey(c);
        return k && bmKeys.has(k) ? bmKeys.get(k) : null;
      };
      const missing = () => [...chans.values()].filter((c) => matchOf(c) === null);

      // Identify the not-yet-resolved links only while a channel is still
      // unmatched; the ones whose title names a missing channel go first,
      // since those are the likeliest to be it under another link form.
      if (missing().length && unresolved.size) {
        const want = new Set(missing().map((c) => nsArtistKey(c.name)));
        const order = [...unresolved.entries()]
          .sort((a, b) => Number(want.has(nsArtistKey(b[1]))) - Number(want.has(nsArtistKey(a[1]))));
        ui.log(`${missing().length} channel(s) unmatched so far — identifying ${order.length} @handle / legacy link(s) (cached for next time)…`);
        let n = 0, failed = 0;
        for (const [url, name] of order) {
          ui.guard();
          if (!missing().length) { ui.log('Every channel matched — stopped identifying early.'); break; }
          ui.log(`Identifying ${++n}/${order.length}: ${url}`, true);
          const id = await bdResolveUrl(url);
          if (id) { ns.urlToId[url] = id; bmIds.set(id, name); } else failed++;
          if (n % 25 === 0) saveNs(ns); // a cancelled run keeps what it found
          await sleep(120);
        }
        saveNs(ns);
        if (failed) ui.log(`⚠ ${failed} bookmark link(s) could not be identified (dead or renamed?) — they only match by their handle text.`);
      }

      // Main ↔ Topic counterpart already bookmarked? Known pairs first, then
      // the other kind of channel with the same artist name.
      const counterpartOf = (c) => {
        const own = ns.pairs[c.id];
        for (const cid of (own && own.ids) || []) if (bmIds.has(cid)) return bmIds.get(cid);
        for (const [bid, p] of Object.entries(ns.pairs)) {
          if (p.ids && p.ids.includes(c.id) && bmIds.has(bid)) return bmIds.get(bid);
        }
        const onTopic = TOPIC_SUFFIX.test(c.name);
        const other = (bmArtists.get(nsArtistKey(c.name)) || []).find((x) => x.topic !== onTopic);
        return other ? other.title : null;
      };

      const sortByName = (a, b) => normTitle(a.name).localeCompare(normTitle(b.name));
      const fresh = [], viaPair = [];
      for (const c of missing()) {
        const cp = counterpartOf(c);
        if (cp) viaPair.push(Object.assign(c, { pairTitle: cp })); else fresh.push(c);
      }
      fresh.sort(sortByName);
      viaPair.sort(sortByName);
      const already = chans.size - fresh.length - viaPair.length;
      ui.log(`✔ ${already} already bookmarked (any link form) · ${fresh.length} not bookmarked`
        + (viaPair.length ? ` · ${viaPair.length} whose main/Topic counterpart is bookmarked` : '') + '.');
      if (!fresh.length && !viaPair.length) { ui.log('✅ Every channel in those playlists is bookmarked already.'); return; }

      // --- review --- (checked = bookmark it)
      const rows = [];
      const rowFor = (c, checked, note) => {
        const cb = el('input', { type: 'checkbox', checked });
        const url = pbChannelUrl(c);
        const rowEl = el('div', { class: 'ycfp-entry' },
          cb,
          el('span', { class: 'ycfp-entry-dur', title: `${c.count} video(s) in: ${[...c.lists].join(', ')}` }, String(c.count)),
          el('a', {
            class: 'ycfp-entry-title', href: url, target: '_blank', rel: 'noreferrer',
            title: `${c.name}\n${url}\n— open in a new tab to verify`,
          }, c.name),
          el('span', { class: 'ycfp-entry-ch', title: url }, url.replace(/^https?:\/\/(www\.)?/, '')),
          note ? el('span', { class: 'ycfp-entry-pl', title: note }, note) : null);
        rows.push({ c, cb, rowEl, url });
        return rowEl;
      };
      const sections = [];
      if (fresh.length) {
        sections.push(el('div', { class: 'ycfp-group' },
          el('div', { class: 'ycfp-group-head' },
            el('span', { class: 'ycfp-grp-label' }, `Not bookmarked · ${fresh.length}`)),
          ...fresh.map((c) => rowFor(c, true, ''))));
      }
      if (viaPair.length) {
        sections.push(el('div', { class: 'ycfp-group' },
          el('div', { class: 'ycfp-group-head' },
            el('span', { class: 'ycfp-grp-label' },
              `Counterpart already bookmarked · ${viaPair.length} — tick any you want as well`)),
          ...viaPair.map((c) => rowFor(c, false, `has "${c.pairTitle}"`))));
      }
      const resultsEl = el('div', { class: 'ycfp-results' }, ...sections);

      let lastAdded = null;
      const undoBtn = el('button', { class: 'ycfp-btn ycfp-secondary', style: 'display:none' }, '↩ Undo');
      undoBtn.addEventListener('click', async () => {
        if (undoBtn.disabled || !lastAdded) return;
        undoBtn.disabled = true;
        try {
          const { removed, failed } = await bmxRemoveBookmarks(lastAdded.map((a) => a.bmId));
          const okIds = new Set(removed.map((n) => n.id));
          for (const a of lastAdded) {
            if (!okIds.has(a.bmId)) continue;
            a.row.rowEl.classList.remove('ycfp-entry-gone');
            a.row.done = false;
          }
          ui.log(`↩ Removed ${removed.length} new bookmark(s) again${failed.length ? `, ${failed.length} failed` : ''}.`);
          lastAdded = null;
          undoBtn.style.display = 'none';
        } catch (e) {
          ui.log(`❌ ${e.message || e}`);
        } finally {
          undoBtn.disabled = false;
        }
      });

      const addBtn = el('button', { class: 'ycfp-btn' }, 'Bookmark the checked channels');
      addBtn.addEventListener('click', async () => {
        if (addBtn.disabled) return;
        const todo = rows.filter((r) => r.cb.checked && !r.done);
        if (!todo.length) { ui.log('Nothing checked.'); return; }
        addBtn.disabled = true;
        try {
          ui.log(`Bookmarking ${todo.length} channel(s) into "${plan.targetPath}"…`);
          const { created, failed } = await bmxAddBookmarks(
            todo.map((r) => ({ title: `${r.c.name} - YouTube`, url: r.url })), plan.targetPath);
          const byIdx = new Map(created.map((n) => [n.i, n.id]));
          const ns2 = loadNs();
          lastAdded = [];
          for (const [i, r] of todo.entries()) {
            const bmId = byIdx.get(i);
            if (!bmId) continue;
            r.done = true;
            r.cb.checked = false;
            r.rowEl.classList.add('ycfp-entry-gone');
            ns2.urlToId[r.url] = r.c.id; // nobody has to resolve this one again
            lastAdded.push({ bmId, row: r });
          }
          saveNs(ns2);
          for (const f of failed) ui.log(`⚠ Could not bookmark ${f.url}: ${f.error}`);
          undoBtn.style.display = lastAdded.length ? '' : 'none';
          ui.log(`✅ Bookmarked ${lastAdded.length}/${todo.length} channel(s)${failed.length ? `, ${failed.length} failed` : ''}.`
            + (lastAdded.length ? ' ↩ Undo removes them again.' : ''));
        } catch (e) {
          ui.log(`❌ ${e.message || e}`);
        } finally {
          addBtn.disabled = false;
        }
      });
      const toggleBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Check / uncheck all');
      toggleBtn.addEventListener('click', () => {
        const live = rows.filter((r) => !r.done);
        const on = live.some((r) => !r.cb.checked);
        live.forEach((r) => { r.cb.checked = on; });
      });

      ui.body.append(resultsEl, el('div', { class: 'ycfp-row' }, addBtn, toggleBtn, undoBtn));
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  // Quietly (console only) baseline channels newly added to the folder, so
  // "just finished binging" positions are captured close to when you
  // bookmarked them — runs at most every 30 min while YouTube is open.
  async function nsAutoScan() {
    const ns = loadNs();
    if (Date.now() - ns.lastAutoScan < NS_AUTOSCAN_MS) return;
    ns.lastAutoScan = Date.now();
    saveNs(ns);
    try {
      const quiet = () => {};
      const links = await nsGetBookmarkLinks(ns);
      const chans = await nsResolveChannels(ns, links, quiet, null);
      saveNs(ns);
      // Counterparts already paired (by a pull or an earlier run, or by name)
      // are baselined here too; searching for new pairs is left to the
      // manual run, so browsing never triggers a burst of searches.
      const watch = new Map(chans);
      if (ns.watchPairs !== false) {
        for (const [id, name] of await nsCounterparts(ns, chans, quiet, null, false)) watch.set(id, name);
        saveNs(ns);
      }
      let added = 0;
      for (const [id, name] of watch) {
        if (ns.channels[id]) continue;
        const r = await nsFetchUploads(id, [], quiet, null, name);
        if (r.error) continue;
        ns.channels[id] = { name, recentIds: r.top, baselinedAt: Date.now(), checkedAt: Date.now() };
        saveNs(ns);
        added++;
        console.info(`[YCFP] New Songs: baselined newly watched channel "${name}" at its latest video.`);
      }
      if (added) console.info(`[YCFP] New Songs: ${added} new channel(s) from the bookmarks folder.`);
    } catch (e) {
      // Bridge missing / folder renamed / API not ready — never disturb browsing.
      console.warn('[YCFP] New Songs auto-scan skipped:', e.message || e);
    }
  }

  // ------------------------------------------------------------------
  // Flows
  // ------------------------------------------------------------------
  let running = false;

  // Per-run collect options, seeded from ⚙ settings; changes apply to this
  // run only (the local cfg copy) and are not persisted.
  function collectOptionRows(cfg) {
    const exact = el('input', { type: 'checkbox', checked: cfg.dedupeByTitleDuration });
    const fuzzy = el('input', { type: 'checkbox', checked: cfg.fuzzyCollect });
    const shorts = el('input', { type: 'checkbox', checked: cfg.excludeShorts });
    const live = el('input', { type: 'checkbox', checked: cfg.excludeLive });
    const upcoming = el('input', { type: 'checkbox', checked: cfg.excludeUpcoming });
    const deleted = el('input', { type: 'checkbox', checked: cfg.skipDeleted });
    const nGone = goneCount();
    const rows = [
      el('div', { class: 'ycfp-check' }, exact,
        el('span', {}, 'Skip duplicates — same title + same length')),
      el('div', { class: 'ycfp-check' }, fuzzy,
        el('span', {}, 'Fuzzy matching — also skip similar versions (official / lyric / audio)')),
      el('div', { class: 'ycfp-check' }, shorts, el('span', {}, 'Skip Shorts')),
      el('div', { class: 'ycfp-check' }, live, el('span', {}, 'Skip live streams')),
      el('div', { class: 'ycfp-check' }, upcoming,
        el('span', {}, 'Skip scheduled / premieres — and anything with no duration (unreleased, private, deleted)')),
      el('div', { class: 'ycfp-check' }, deleted,
        el('span', {}, `Skip videos I deleted from a playlist before${nGone ? ` (${nGone} recorded)` : ''}`)),
    ];
    const apply = () => {
      cfg.dedupeByTitleDuration = exact.checked;
      cfg.fuzzyCollect = fuzzy.checked;
      cfg.excludeShorts = shorts.checked;
      cfg.excludeLive = live.checked;
      cfg.excludeUpcoming = upcoming.checked;
      cfg.skipDeleted = deleted.checked;
    };
    return { rows, apply };
  }

  // One channel's block in the companion review: its found main/Topic
  // counterpart(s), each a checkbox + a link you can open to verify it really
  // is the same artist, shown before anything is fetched from them.
  //
  // When several channels carry the exact same name — which happens
  // constantly with auto-generated Topic channels — ALL of them are listed
  // with what little distinguishes them (handle, subscriber and video counts,
  // and how much of their catalog overlaps this channel's), best guess
  // pre-ticked. Tick more than one if the artist genuinely has two channels.
  //
  // Sets `p.companionChoices = [{entry, cb}]`; read it back with
  // chosenCompanions(p).
  function companionReviewBlock(p, verb) {
    const c = p.companion || {};
    const cands = c.candidates || (c.id ? [{ id: c.id }] : []);
    const head = el('div', { class: 'ycfp-group-head' },
      el('span', { class: 'ycfp-grp-label' }, p.channelTitle),
      el('span', { class: 'ycfp-entry-pl' }, `${p.main.length} uploads`));
    const rows = [];
    if (cands.length) {
      p.companionChoices = [];
      if (cands.length > 1) {
        rows.push(el('div', { class: 'ycfp-entry' },
          el('span', { class: 'ycfp-entry-ch' },
            `⚠ ${cands.length} channels are named "${c.name}" — tick the right one`
            + ' (open each to check; more than one is allowed).')));
      }
      cands.forEach((cand, i) => {
        // Several same-named channels and none shares a single song: leave
        // them all unticked rather than guess a stranger's channel.
        const cb = el('input', {
          type: 'checkbox', checked: i === 0 && !(cands.length > 1 && !((cand.score || 0) > 0)),
        });
        // A run of small facts, so two identically-named channels can be
        // told apart without opening both.
        const facts = [
          cand.handle || '',
          cand.subs || '',
          cand.videoCount || '',
          typeof cand.score === 'number' && cand.score >= 0
            ? `${Math.round(cand.score * 100)}% of its latest uploads match this channel`
            : '',
        ].filter(Boolean).join(' · ');
        rows.push(el('label', {
          class: 'ycfp-check',
          title: `Include this ${(c.label || 'companion').toLowerCase()} in the ${verb}`,
        }, cb,
          el('span', {}, `${c.label}:`),
          el('a', {
            class: 'ycfp-entry-title', href: `${ORIGIN}/channel/${cand.id}`,
            target: '_blank', rel: 'noreferrer',
            title: 'Open in a new tab to check it really is the same artist',
          }, cand.title || c.name),
          el('span', { class: 'ycfp-entry-ch ycfp-entry-facts', title: facts }, facts),
          el('span', { class: 'ycfp-entry-pl' }, 'verify →')));
        p.companionChoices.push({
          cb,
          entry: { id: cand.id, name: cand.title || c.name, label: c.label, handle: cand.handle || '' },
        });
      });
    } else if (c.off) {
      rows.push(el('div', { class: 'ycfp-entry' },
        el('span', { class: 'ycfp-entry-ch' }, 'Topic-channel matching is off in ⚙ settings.')));
    } else {
      rows.push(el('div', { class: 'ycfp-entry' },
        el('span', { class: 'ycfp-entry-ch' },
          `⚠ No ${c.label ? c.label.toLowerCase() : 'companion'} found for "${c.name || p.channelTitle}"`
          + `${c.error ? ` (${c.error})` : ''} — this channel ${verb}s its own uploads only.`)));
    }
    return el('div', {
      class: cands.length === 1 ? 'ycfp-group' : 'ycfp-group ycfp-group-xch',
    }, head, ...rows);
  }

  // Reviewable list of every channel's found main/Topic counterpart(s),
  // shown before any companion is fetched. Shared by single-channel Collect
  // and Collect Multiple channels (Pull batch folds the same block into its
  // own bookmark review). Shows nothing and returns immediately if there's
  // nothing to decide.
  async function reviewCompanions(ui, prepped, actionLabel) {
    const missing = prepped.filter((p) => p.companion && !p.companion.id && !p.companion.off);
    const found = prepped.filter((p) => p.companion && p.companion.id);
    if (!found.length && !missing.length) return;

    const reviewRows = el('div', { class: 'ycfp-results' },
      ...prepped.map((p) => companionReviewBlock(p, 'collect')));

    const tickBtn = el('button', { class: 'ycfp-mini-btn' }, 'Untick all counterparts');
    tickBtn.addEventListener('click', () => {
      const on = tickBtn.textContent === 'Tick all counterparts';
      for (const p of found) for (const ch of (p.companionChoices || [])) ch.cb.checked = on;
      tickBtn.textContent = on ? 'Untick all counterparts' : 'Tick all counterparts';
    });
    const goBtn = el('button', { class: 'ycfp-btn' }, actionLabel || 'Continue');
    const ambiguous = found.filter((p) => (p.companion.candidates || []).length > 1);
    const notes = [
      found.length ? `${found.length} main/Topic counterpart(s) found — untick any that isn't the same artist.` : '',
      ambiguous.length ? `⚠ ${ambiguous.length} name(s) matched several channels — pick the right one: ${ambiguous.map((p) => p.channelTitle).join(', ')}.` : '',
      missing.length ? `⚠ No counterpart found for: ${missing.map((p) => p.channelTitle).join(', ')}.` : '',
    ].filter(Boolean);
    for (const n of notes) ui.log(n);

    const review = el('div', {},
      notes.length ? el('label', {}, notes.join(' ')) : null,
      reviewRows,
      el('div', { class: 'ycfp-row' }, goBtn, found.length ? tickBtn : null));
    ui.body.append(review);
    await new Promise((res) => {
      goBtn.addEventListener('click', res, { once: true });
      ui.dlg.addEventListener('close', res);
    });
    ui.guard();
    const dropped = [];
    for (const p of found) {
      for (const ch of (p.companionChoices || [])) if (!ch.cb.checked) dropped.push(ch.entry.name);
    }
    if (dropped.length) {
      ui.log(`Skipping ${dropped.length} counterpart(s) you unticked: ${dropped.join(', ')}.`);
    }
    review.remove();
  }

  async function runChannelFlow(ignoreExclusions = false) {
    if (running) return;
    running = true;
    const cfg = loadCfg();
    if (ignoreExclusions) cfg.excludePlaylists = []; // local copy only, not persisted
    const ui = openDialog(ignoreExclusions
      ? 'Collect channel into playlist (exclusions OFF)'
      : 'Collect channel into playlist');
    try {
      if (ignoreExclusions) ui.log('Exclusion playlists are ignored for this run.');

      // Options step: tweak this run before it starts.
      const opts = collectOptionRows(cfg);
      const startBtn = el('button', { class: 'ycfp-btn' }, 'Start collecting');
      const form = el('div', {}, ...opts.rows, el('div', { class: 'ycfp-row' }, startBtn));
      ui.body.append(form);
      await new Promise((res) => {
        startBtn.addEventListener('click', res, { once: true });
        ui.dlg.addEventListener('close', res);
      });
      ui.guard();
      opts.apply();
      form.remove();

      ui.log('Resolving channel…');
      const channelId = await resolveChannelId();
      const { channelTitle, main } = await fetchMainUploads(channelId, cfg, ui.log, ui.guard);
      const companion = await resolveCompanion(channelId, channelTitle, main, cfg, ui.log, ui.guard);

      // Review step: show the found main/Topic counterpart (if any) with a
      // verify link + checkbox before it's fetched — same pattern Pull
      // batch uses for its whole channel list.
      const prepped = [{ channelTitle, main, companion }];
      await reviewCompanions(ui, prepped, 'Continue collecting');

      const excl = await buildExclusionSets(cfg, ui.log, ui.guard);
      const companionVids = await fetchChosenCompanions(prepped[0], cfg, ui.log, ui.guard, ui.link);
      const videos = main.concat(companionVids);
      const { kept, nExcluded, nDupes, nDeleted } = await applyExclusions(videos, excl, cfg);
      ui.log(`Combined ${videos.length} → ${kept.length} kept (${nExcluded} in excluded playlists, ${nDupes} duplicates`
        + `${nDeleted ? `, ${nDeleted} you deleted before` : ''}).`);

      if (kept.length === 0) { ui.log('Nothing new to add — done.'); return; }
      await pickAndAdd(ui, cfg, kept, channelTitle);
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  // Shared tail: pick a target playlist and add the kept videos to it.
  async function pickAndAdd(ui, cfg, kept, sourceLabel) {
    ui.log('Loading your playlists…');
    const playlists = await getUserPlaylists(kept[0].id);
    const target = await pickTarget(ui, playlists, cfg, null);
    if (!target) { ui.log('Cancelled.'); return; }

    if (target.type === 'existing') {
      const toAdd = await filterAgainstTarget(kept, target.id, cfg, ui.log, ui.guard);
      if (toAdd.length === 0) { ui.log('Everything is already in the target — done.'); return; }
      await addToPlaylist(target.id, toAdd.map((v) => v.id), cfg, ui.log, ui.guard);
      ui.log(`✅ Done: added ${toAdd.length} videos${sourceLabel ? ` from ${sourceLabel}` : ''}.`);
      ui.link(`${ORIGIN}/playlist?list=${target.id}`, 'target playlist');
    } else {
      const ids = kept.slice(0, PLAYLIST_CAP).map((v) => v.id);
      if (kept.length > PLAYLIST_CAP) ui.log(`⚠ Truncated to the 5000-video playlist cap.`);
      const pid = await createPlaylist(target.title, ids, cfg, ui.log, ui.guard);
      ui.log(`✅ Done: ${ids.length} videos in new playlist.`);
      ui.link(`${ORIGIN}/playlist?list=${pid}`, target.title);
    }
  }

  // Collect several channels in one go into a single target playlist.
  async function runMultiChannelFlow() {
    if (running) return;
    running = true;
    const cfg = loadCfg();
    const ui = openDialog('Collect multiple channels', true);
    try {
      const input = el('textarea', {
        placeholder: '@artist1\nhttps://www.youtube.com/@artist2\nUCxxxxxxxxxxxxxxxxxxxxxx\nExact Channel Name',
      });
      const noExclCb = el('input', { type: 'checkbox' });
      const opts = collectOptionRows(cfg);
      const startBtn = el('button', { class: 'ycfp-btn' }, 'Collect');
      const form = el('div', {},
        el('label', {}, 'Channels to collect (one per line — @handle, channel URL, UC-id, or exact channel name):'),
        input,
        el('div', { class: 'ycfp-check' }, noExclCb,
          el('span', {}, 'Ignore excluded playlists for this run')),
        ...opts.rows,
        el('div', { class: 'ycfp-row' }, startBtn));
      ui.body.append(form);
      await new Promise((res) => {
        startBtn.addEventListener('click', res, { once: true });
        ui.dlg.addEventListener('close', res);
      });
      ui.guard();
      const lines = input.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) { ui.log('No channels given.'); return; }
      if (noExclCb.checked) {
        cfg.excludePlaylists = []; // local copy only, not persisted
        ui.log('Exclusion playlists are ignored for this run.');
      }
      opts.apply();
      form.remove();

      const channelIds = [];
      for (const line of lines) {
        ui.guard();
        ui.log(`Resolving "${line}"…`);
        const id = await resolveChannelInput(line);
        if (!id) { ui.log(`⚠ Could not resolve "${line}" — skipped.`); continue; }
        if (!channelIds.includes(id)) channelIds.push(id);
      }
      if (!channelIds.length) { ui.log('❌ No channels could be resolved.'); return; }
      ui.log(`${channelIds.length} channel(s) to collect.`);

      // --- scan phase: main uploads + companion for every channel first,
      // so the whole batch can be reviewed before anything is fetched or
      // added (same two-phase approach Pull batch uses). ---
      const prepped = [];
      for (const chId of channelIds) {
        ui.guard();
        let channelTitle, main;
        try {
          ({ channelTitle, main } = await fetchMainUploads(chId, cfg, ui.log, ui.guard));
        } catch (e) {
          ui.guard(); // re-throws on user cancel; otherwise skip this channel
          ui.log(`⚠ Skipped channel ${chId}: ${e.message || e}`);
          continue;
        }
        let companion = null;
        try {
          companion = await resolveCompanion(chId, channelTitle, main, cfg, ui.log, ui.guard);
        } catch (e) {
          ui.guard();
          companion = { id: null, name: channelTitle, label: 'Companion channel', error: e.message || String(e) };
          ui.log(`⚠ ${channelTitle}: companion search failed (${companion.error}) — main channel only.`);
        }
        prepped.push({ chId, channelTitle, main, companion });
      }
      if (!prepped.length) { ui.log('❌ Nothing could be resolved — nothing collected.'); return; }

      // --- review phase: the found main/Topic counterparts, each one
      // opt-out-able, before any of them are fetched. ---
      await reviewCompanions(ui, prepped, `Collect these ${prepped.length} channel(s)`);

      const excl = await buildExclusionSets(cfg, ui.log, ui.guard);

      // Pick the target FIRST so each channel is gathered → filtered → added
      // one by one, in the order given — no merging at the end.
      ui.log('Loading your playlists…');
      const playlists = await getUserPlaylists('dQw4w9WgXcQ');
      const target = await pickTarget(ui, playlists, cfg, null);
      if (!target) { ui.log('Cancelled.'); return; }

      let targetId = target.type === 'existing' ? target.id : null;
      let have;
      if (targetId) {
        const existing = await fetchPlaylistVideos(targetId, 'Target playlist', ui.log, ui.guard);
        have = makeHaveSets(existing, cfg);
      } else {
        have = makeHaveSets([], cfg);
      }

      let totalAdded = 0;
      const names = [];
      for (const p of prepped) {
        ui.guard();
        // openTab=false: one tab per channel would be spam — links go to the log
        // A single channel failing (404, deleted, region-locked …) must not
        // abort the whole batch — log it and move on to the next one.
        const channelTitle = p.channelTitle;
        let videos;
        try {
          const companionVids = await fetchChosenCompanions(p, cfg, ui.log, ui.guard, ui.link, false);
          videos = p.main.concat(companionVids);
        } catch (e) {
          ui.guard(); // re-throws on user cancel; otherwise skip this channel
          ui.log(`⚠ Skipped channel ${channelTitle}: ${e.message || e}`);
          continue;
        }
        names.push(channelTitle);

        // Exclusions + dedupe against the target's contents, including
        // everything added for the previous channels of this run.
        const kept = [];
        let nEx = 0, nDup = 0, nGone = 0, n = 0;
        for (const v of videos) {
          if (++n % 300 === 0) await sleep(0);
          const vars = cfg.fuzzyCollect && v.seconds > 0 ? titleVariants(v.title, v.channel) : null;
          if (excl.exclIds.has(v.id)
            || (cfg.dedupeByTitleDuration && titleDurationHit(excl.exclKeys, v.title, v.seconds))
            || (vars && fuzzBucketHit(excl.exclFuzz, vars, v.seconds))) { nEx++; continue; }
          if (goneHit(excl, v, cfg)) { nGone++; continue; }
          if (have.ids.has(v.id)
            || (cfg.dedupeByTitleDuration && titleDurationHit(have.keys, v.title, v.seconds))
            || (vars && fuzzBucketHit(have.fuzz, vars, v.seconds))) { nDup++; continue; }
          have.ids.add(v.id);
          if (cfg.dedupeByTitleDuration && v.seconds > 0) have.keys.add(dupeKey(v));
          if (vars) fuzzBucketAdd(have.fuzz, v.seconds, vars);
          kept.push(v);
        }
        ui.log(`${channelTitle}: ${videos.length} → ${kept.length} new (${nEx} excluded, ${nDup} duplicates / already in target`
          + `${nGone ? `, ${nGone} you deleted before` : ''}).`);
        if (!kept.length) continue;

        let ids = kept.map((v) => v.id);
        const room = PLAYLIST_CAP - have.count;
        if (ids.length > room) {
          ui.log(`⚠ Playlist cap: room for only ${room} more — truncating.`);
          ids = ids.slice(0, Math.max(0, room));
        }
        if (!ids.length) { ui.log('Target playlist is full — stopping.'); break; }

        if (!targetId) {
          targetId = await createPlaylist(target.title, ids, cfg, ui.log, ui.guard);
        } else {
          await addToPlaylist(targetId, ids, cfg, ui.log, ui.guard);
        }
        have.count += ids.length;
        totalAdded += ids.length;
        ui.log(`${channelTitle}: added ${ids.length} (running total ${totalAdded}).`);
      }

      if (!totalAdded) { ui.log('Nothing new to add — done.'); return; }
      ui.log(`✅ Done: ${totalAdded} videos from ${names.length} channel(s): ${names.join(', ')}.`);
      if (targetId) ui.link(`${ORIGIN}/playlist?list=${targetId}`, 'target playlist');
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  async function runPlaylistFlow() {
    if (running) return;
    running = true;
    const cfg = loadCfg();
    const ui = openDialog('Copy playlist into another');
    try {
      const sourceId = new URLSearchParams(location.search).get('list');
      if (!sourceId) throw new Error('No ?list= in the URL.');
      let source = await fetchPlaylistVideos(sourceId, 'Source', ui.log, ui.guard);
      ui.log(`Source playlist: ${source.length} videos.`);
      if (cfg.excludeShorts) {
        const before = source.length;
        source = source.filter((v) => !v.isShort);
        if (before !== source.length) ui.log(`Excluded ${before - source.length} Shorts.`);
      }
      if (cfg.excludeUpcoming) source = stripUpcoming(source, 'Source', ui.log);
      if (source.length === 0) return;

      ui.log('Loading your playlists…');
      const playlists = await getUserPlaylists(source[0].id);
      const target = await pickTarget(ui, playlists, cfg, sourceId);
      if (!target) { ui.log('Cancelled.'); return; }

      if (target.type === 'existing') {
        const toAdd = await filterAgainstTarget(source, target.id, cfg, ui.log, ui.guard);
        if (toAdd.length === 0) { ui.log('Everything is already in the target — done.'); return; }
        await addToPlaylist(target.id, toAdd.map((v) => v.id), cfg, ui.log, ui.guard);
        ui.log(`✅ Done: added ${toAdd.length} videos.`);
        ui.link(`${ORIGIN}/playlist?list=${target.id}`, 'target playlist');
      } else {
        const ids = [...new Set(source.map((v) => v.id))].slice(0, PLAYLIST_CAP);
        const pid = await createPlaylist(target.title, ids, cfg, ui.log, ui.guard);
        ui.log(`✅ Done: ${ids.length} videos in new playlist.`);
        ui.link(`${ORIGIN}/playlist?list=${pid}`, target.title);
      }
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  // ------------------------------------------------------------------
  // Dedupe session: the in-progress scan (entries, groups, which boxes are
  // checked, which entries are already removed) persisted to localStorage
  // so an accidental dialog close or page reload doesn't force a rescan.
  // Saved on every checkbox edit, so resuming picks up exactly where you
  // left off — including edits made right before the reload.
  // ------------------------------------------------------------------
  // Load only the requested pair, rather than a player for every scan row.
  function buildDedupeComparison(groupEntries) {
    const videos = [...new Map(groupEntries.map((e) => [e.id, e])).values()];
    const panel = el('div', { class: 'ycfp-comparison' });
    const players = el('div', { class: 'ycfp-comparison-players' });
    const close = el('button', { class: 'ycfp-mini-btn', onclick: () => panel.remove() }, 'Close players');
    panel.append(el('div', { class: 'ycfp-row' }, el('strong', {}, 'Compare videos'), close), players);
    for (let side = 0; side < Math.min(2, videos.length); side++) {
      const picker = el('select', { 'aria-label': `Comparison video ${side + 1}` },
        ...videos.map((v) => el('option', { value: v.id }, `${v.title || v.id}${v.channel ? ` · ${v.channel}` : ''}`)));
      picker.value = videos[side].id;
      const slot = el('div', { class: 'ycfp-comparison-slot' });
      const load = () => {
        const v = videos.find((e) => e.id === picker.value);
        // Embedded players never work here: YouTube answers every embed on
        // youtube.com itself with error 152-4 (any video, any referrer
        // policy, nocookie too). So each side is a thumbnail + facts, and
        // plays in its own small popup window — left and right, reused.
        const play = el('button', { class: 'ycfp-mini-btn' }, '▶ Play in mini window');
        play.addEventListener('click', () => {
          const w = Math.min(640, Math.floor(screen.availWidth / 2) - 10);
          const h = Math.round(w * 9 / 16) + 140;
          window.open(`${ORIGIN}/watch?v=${encodeURIComponent(v.id)}`, `ycfp-compare-${side}`,
            `popup=yes,width=${w},height=${h},left=${side ? w + 20 : 0},top=80`);
        });
        slot.replaceChildren(
          el('img', { src: `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`, alt: v.title || v.id }),
          el('div', { class: 'ycfp-comparison-meta' },
            `${fmtDur(v.seconds)}${v.channel ? ` · ${v.channel}` : ''}${v.playlistTitle ? ` · ${v.playlistTitle}` : ''}`),
          play,
          el('a', { href: `${ORIGIN}/watch?v=${encodeURIComponent(v.id)}`, target: '_blank', rel: 'noreferrer' }, 'Open in a new tab'));
      };
      picker.addEventListener('change', load);
      players.append(el('div', {}, picker, slot));
      load();
    }
    return panel;
  }

  const DEDUPE_SESSION_KEY = 'ycfp-dedupe-session-v1';
  // Past this age a saved scan is too far out of date to be worth carrying
  // forward, and is dropped instead of offered.
  const DEDUPE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const loadDedupeSession = () => {
    flushDedupeSession();
    try { return JSON.parse(kvGet(DEDUPE_SESSION_KEY)) || null; } catch (e) { return null; }
  };
  // A 15,000-entry scan serializes to ~11 MB, so writing it on every tick
  // made each checkbox click stall. Edits are batched instead: the latest
  // state is written 1.5 s after the last one, and at once when the tab is
  // hidden or closed, or when the scan is read back.
  let dedupeSavePending = null;
  let dedupeSaveTimer = 0;
  const flushDedupeSession = () => {
    clearTimeout(dedupeSaveTimer);
    dedupeSaveTimer = 0;
    if (!dedupeSavePending) return;
    const s = dedupeSavePending;
    dedupeSavePending = null;
    kvSet(DEDUPE_SESSION_KEY, JSON.stringify(s));
  };
  const saveDedupeSession = (s) => {
    dedupeSavePending = s;
    clearTimeout(dedupeSaveTimer);
    dedupeSaveTimer = setTimeout(flushDedupeSession, 1500);
  };
  const clearDedupeSession = () => {
    clearTimeout(dedupeSaveTimer);
    dedupeSaveTimer = 0;
    dedupeSavePending = null;
    kvRemove(DEDUPE_SESSION_KEY);
  };
  // The disk store's own pagehide flush was registered earlier and has
  // already run by now, so flush it again after handing it the scan.
  const flushDedupeNow = () => { if (dedupeSavePending) { flushDedupeSession(); kvSchedule(true); } };
  window.addEventListener('pagehide', flushDedupeNow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushDedupeNow(); });

  // The fetched entries are shared by every matching mode; each mode keeps
  // its own grouping, its own ticks and its own ✕-unlinked groups, so
  // switching modes never overwrites what you already decided in the other
  // one. `goneIdx` (entries actually removed) is session-wide — a removal is
  // a removal in every mode.
  //   { ts, mode, entries, goneIdx, modes: { <mode>: {groups, checkedIdx,
  //     unlinkedGroups, seeded} } }
  // Sessions saved by older versions carried a single grouping at the top
  // level plus a `fuzzy` boolean; they're folded into the new shape.
  function migrateDedupeSession(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.entries) || !s.entries.length) return null;
    if (s.modes && typeof s.modes === 'object') return s;
    if (!Array.isArray(s.groups) || !s.groups.length) return null;
    const key = s.fuzzy ? 'fuzzy' : 'simple';
    return {
      ts: s.ts || Date.now(),
      mode: key,
      entries: s.entries,
      goneIdx: s.goneIdx || [],
      modes: {
        [key]: {
          groups: s.groups,
          checkedIdx: s.checkedIdx || [],
          unlinkedGroups: s.unlinkedGroups || [],
          seeded: true,
        },
      },
    };
  }
  // Total groups still outstanding across every analyzed mode — what the
  // resume banner counts.
  const sessionGroupCount = (s) =>
    Object.values(s.modes || {}).reduce((n, m) => n + (m.groups || []).length, 0);
  const fmtAgo = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  };

  // A saved scan is a snapshot. Playlists get edited, renamed and deleted
  // between sessions, and per-entry handles go stale — so resuming one
  // verbatim listed entries that no longer exist anywhere (and whose dead
  // handles then failed over into remove-by-video-id, taking good copies with
  // them). Re-read the playlists it covers, keep only what is still really
  // there, refresh the handles, and carry the user's ticks across by
  // remapping the indices the groups are built from.
  async function revalidateDedupeSession(saved, log, guard) {
    const plIds = [...new Set(saved.entries.map((e) => e.playlistId))];
    const fresh = new Map();
    for (const pid of plIds) {
      const known = saved.entries.find((e) => e.playlistId === pid) || {};
      const title = known.playlistTitle || pid;
      let vids = null;
      try {
        vids = await fetchPlaylistVideos(pid, title, log, guard, { keepDupes: true, quiet: true });
      } catch (err) {
        // A closed dialog must abort the whole thing, not quietly drop
        // playlists from the scan — guard() re-throws when that happened.
        if (guard) guard();
        log(`⚠ "${title}" could not be read (${err.message || err}) — dropped from the resumed scan.`);
        continue;
      }
      if (!vids.length) {
        log(`⚠ "${title}" is empty or no longer exists — dropped from the resumed scan.`);
        continue;
      }
      const byKey = new Map();
      for (const v of vids) byKey.set(v.setVideoId ? 'S' + v.setVideoId : 'V' + v.id, v);
      fresh.set(pid, {
        byKey, title,
        editable: vids.editable === undefined ? !!known.editable : !!vids.editable,
      });
    }

    const entries = [];
    const oldToNew = new Map();
    const matched = new Set(); // `${pid}|${key}` of fresh entries the saved scan already had
    saved.entries.forEach((e, i) => {
      const f = fresh.get(e.playlistId);
      if (!f) return;
      const key = e.setVideoId ? 'S' + e.setVideoId : 'V' + e.id;
      const v = f.byKey.get(key);
      if (!v) return; // that entry is no longer in the playlist
      matched.add(e.playlistId + '|' + key);
      oldToNew.set(i, entries.length);
      entries.push(Object.assign({}, e, {
        title: v.title || e.title,
        seconds: v.seconds || e.seconds,
        channel: v.channel || e.channel,
        setVideoId: v.setVideoId,
        copies: v.copies || 1,
        editable: f.editable === undefined ? e.editable : !!f.editable,
      }));
    });

    // Videos added to these playlists since the scan was saved — moved in from
    // another playlist, say. Resuming used to leave them out entirely.
    let addedEntries = 0;
    for (const [pid, f] of fresh) {
      for (const [key, v] of f.byKey) {
        if (matched.has(pid + '|' + key)) continue;
        entries.push(Object.assign({}, v, { playlistId: pid, playlistTitle: f.title, editable: f.editable }));
        addedEntries++;
      }
    }

    const remap = (list) => (list || []).map((i) => oldToNew.get(i)).filter((i) => i !== undefined);
    // Every analyzed mode is carried across, each with its own ticks.
    const modes = {};
    let droppedGroups = 0;
    if (addedEntries) {
      // New entries can join existing groups or form new ones, so the saved
      // grouping can't just be remapped — re-analyze each mode, keeping ticks
      // (per entry) and ✕-unlinks (a new group touching an unlinked one).
      log(`${addedEntries} entries were added since that scan — re-grouping to include them…`);
      for (const [key, m] of Object.entries(saved.modes || {})) {
        const groups = await analyzeDuplicates(entries, key, log);
        const unlinkedEntries = new Set();
        for (const gi of m.unlinkedGroups || []) {
          for (const i of (m.groups || [])[gi] || []) {
            const n = oldToNew.get(i);
            if (n !== undefined) unlinkedEntries.add(n);
          }
        }
        modes[key] = {
          groups,
          checkedIdx: remap(m.checkedIdx),
          unlinkedGroups: groups.map((g, gi) => (g.some((i) => unlinkedEntries.has(i)) ? gi : -1))
            .filter((gi) => gi >= 0),
          seeded: !!m.seeded,
        };
      }
    }
    for (const [key, m] of addedEntries ? [] : Object.entries(saved.modes || {})) {
      const groups = [];
      const groupMap = new Map(); // old group index → new group index
      (m.groups || []).forEach((g, gi) => {
        const ng = g.map((i) => oldToNew.get(i)).filter((i) => i !== undefined);
        if (ng.length > 1 || (ng.length === 1 && (entries[ng[0]].copies || 1) > 1)) {
          groupMap.set(gi, groups.length);
          groups.push(ng);
        }
      });
      droppedGroups += (m.groups || []).length - groups.length;
      modes[key] = {
        groups,
        checkedIdx: remap(m.checkedIdx),
        unlinkedGroups: (m.unlinkedGroups || [])
          .map((gi) => groupMap.get(gi)).filter((gi) => gi !== undefined),
        seeded: !!m.seeded,
      };
    }
    return {
      entries,
      modes,
      goneIdx: remap(saved.goneIdx),
      droppedEntries: saved.entries.length - (entries.length - addedEntries),
      addedEntries,
      droppedGroups,
    };
  }

  // `opts` (from Pull batch / New songs): { focus: {id, title}, mode,
  // carry: [log lines] } — opens a NEW scan with that playlist and your
  // default playlists ticked, and pre-checks the focus playlist's entries in
  // every group that also has a copy elsewhere (the older copy is kept).
  async function runDedupeFlow(opts) {
    if (running) return;
    if (!opts || !opts.focus) opts = null; // a click passes an Event
    running = true;
    const cfg = loadCfg();
    const ui = openDialog('Playlist deduplicator', true);
    try {
      let entries, selected, session;
      let mode = (opts && opts.mode) || 'simple';
      let resumed = false;
      if (opts) {
        for (const line of opts.carry || []) ui.log(line);
        ui.log(`Duplicates of what "${opts.focus.title}" just got are reviewed here — its copies come pre-checked; `
          + 'press Scan for duplicates.');
      }

      // --- offer to resume a saved scan ---
      let saved = opts ? null : migrateDedupeSession(loadDedupeSession());
      if (saved && Date.now() - (saved.ts || 0) > DEDUPE_SESSION_MAX_AGE_MS) {
        clearDedupeSession();
        saved = null;
      }
      if (saved && !sessionGroupCount(saved)) {
        // Nothing outstanding in it, so it is never offered — and it is by
        // far the biggest thing the script stores. Drop it now instead of
        // letting it hold megabytes until it ages out.
        clearDedupeSession();
        saved = null;
      }
      if (saved) {
        const resumeBtn = el('button', { class: 'ycfp-btn' },
          `▶ Resume last scan (${fmtAgo(Date.now() - saved.ts)} — ${sessionGroupCount(saved)} groups, ${saved.entries.length} entries)`);
        const newBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'New scan instead');
        const discardBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, '🗑 Discard saved scan');
        const banner = el('div', { class: 'ycfp-row' }, resumeBtn, newBtn, discardBtn);
        ui.body.append(banner);
        const choice = await new Promise((res) => {
          resumeBtn.addEventListener('click', () => res('resume'), { once: true });
          newBtn.addEventListener('click', () => res('new'), { once: true });
          discardBtn.addEventListener('click', () => { clearDedupeSession(); res('new'); }, { once: true });
          ui.dlg.addEventListener('close', () => res('new'));
        });
        banner.remove();
        if (choice === 'resume') {
          ui.log('Re-checking the saved scan against your playlists…');
          const v = await revalidateDedupeSession(saved, ui.log, ui.guard);
          ui.guard();
          const live = Object.entries(v.modes).filter(([, m]) => (m.groups || []).length);
          if (!live.length) {
            ui.log('Nothing from that scan is still outstanding — starting a new scan.');
            clearDedupeSession();
          } else {
            entries = v.entries;
            resumed = true;
            Object.assign(saved, { entries, modes: v.modes, goneIdx: v.goneIdx });
            // Come back to the mode you were last looking at, unless it's the
            // one that has nothing left.
            if (!saved.modes[saved.mode] || !saved.modes[saved.mode].groups.length) {
              saved.mode = live[0][0];
            }
            mode = saved.mode;
            session = saved;
            saveDedupeSession(session);
            const byPlaylist = new Map();
            for (const e of entries) {
              if (!byPlaylist.has(e.playlistId)) byPlaylist.set(e.playlistId, { id: e.playlistId, title: e.playlistTitle });
            }
            selected = [...byPlaylist.values()];
            ui.log(`Resumed saved scan from ${fmtAgo(Date.now() - saved.ts)} — ${entries.length} entries, `
              + `${live.map(([k, m]) => `${m.groups.length} in ${k}`).join(', ')}.`
              + (v.droppedEntries || v.droppedGroups
                ? ` Dropped ${v.droppedEntries} entries and ${v.droppedGroups} groups that no longer exist.`
                : '')
              + (v.addedEntries ? ` Included ${v.addedEntries} entries added since.` : ''));
          }
        }
      }

      if (!resumed) {
        ui.log('Loading your playlists…');
        const pls = await getOwnPlaylists(ui.log);
        ui.guard();
        if (opts && !pls.some((p) => p.id === opts.focus.id)) pls.unshift(opts.focus);
        if (!pls.length) { ui.log('❌ Could not load your playlists.'); return; }
        ui.log(`${pls.length} playlists found.`);

        // --- selection UI --- (last scan's selection is restored)
        const remembered = opts ? new Set([opts.focus.id, ...defaultPlaylistIds(cfg)])
          : new Set(cfg.dedupeSelection || []);
        const boxes = pls.map((p) => ({
          p,
          cb: el('input', { type: 'checkbox', checked: remembered.has(p.id) }),
        }));
        // Simple is the default; the looser modes have to be picked
        // deliberately. Whichever you start with, the others are one click
        // away in the results — the fetch is shared.
        const modeRadios = MATCH_MODES.map((m, i) => ({
          key: m.key, label: m.label,
          rb: el('input', { type: 'radio', name: 'ycfp-scan-mode', checked: opts ? m.key === mode : i === 0 }),
        }));
        const scanBtn = el('button', { class: 'ycfp-btn' }, 'Scan for duplicates');
        const allBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Select all');
        allBtn.addEventListener('click', () => {
          const on = boxes.some((b) => !b.cb.checked);
          boxes.forEach((b) => { b.cb.checked = on; });
        });
        const pickerEl = el('div', {},
          el('label', {}, 'Select the playlists to scan:'),
          el('div', { class: 'ycfp-pl-list' },
            ...boxes.map(({ p, cb }) => el('label', { class: 'ycfp-check' }, cb, el('span', {}, p.title)))),
          el('label', {}, 'Matching mode (switchable afterwards without re-scanning):'),
          ...modeRadios.map((m) => el('div', { class: 'ycfp-check' }, m.rb, el('span', {}, m.label))),
          el('div', { class: 'ycfp-row' }, scanBtn, allBtn, defaultSelBtn(boxes)));
        ui.body.append(pickerEl);
        await new Promise((res) => {
          scanBtn.addEventListener('click', res, { once: true });
          ui.dlg.addEventListener('close', res);
        });
        ui.guard();
        selected = boxes.filter((b) => b.cb.checked).map((b) => b.p);
        if (!selected.length) { ui.log('No playlists selected.'); return; }
        // Remember the selection for next time (persisted field only).
        const stored = loadCfg();
        stored.dedupeSelection = selected.map((p) => p.id);
        saveCfg(stored);
        mode = (modeRadios.find((m) => m.rb.checked) || modeRadios[0]).key;
        ui.log(`Matching mode: ${MODE_LABEL(mode)}.`);
        pickerEl.remove();

        // --- fetch entries ---
        entries = [];
        for (const p of selected) {
          const vids = await fetchPlaylistVideos(p.id, p.title, ui.log, ui.guard, { keepDupes: true });
          let editable = vids.editable;
          if (editable === undefined) editable = await isPlaylistEditable(p.id, vids[0] && vids[0].id);
          if (!editable) ui.log(`⚠ "${p.title}" is read-only — its entries are shown but can't be removed.`);
          if (vids.length && !vids[0].setVideoId) {
            ui.log(`⚠ "${p.title}": no per-entry handles in the data — same-video copies are collapsed there.`);
          }
          for (const v of vids) entries.push(Object.assign({}, v, {
            playlistId: p.id, playlistTitle: p.title, editable: !!editable,
          }));
          ui.log(`${p.title}: ${vids.length} entries.`);
        }

        if (!entries.length) { ui.log('❌ Nothing was read from those playlists.'); return; }
        // Persist the scan so it survives an accidental dialog close or page
        // reload. Resuming keeps the original timestamp; every later checkbox
        // edit or removal updates this same record (see persistSession below).
        session = { ts: Date.now(), mode, entries, goneIdx: [], modes: {}, focusPid: opts ? opts.focus.id : null };
      }

      // Group the (already fetched) entries under one matching mode. Each
      // mode is analyzed at most once per scan and keeps its own result and
      // its own ticks, so switching back and forth costs nothing and loses
      // nothing.
      const ensureMode = async (m) => {
        if (session.modes[m]) return session.modes[m];
        ui.log(`Analyzing ${entries.length} entries — ${MODE_LABEL(m)}…`);
        const g = await analyzeDuplicates(entries, m, ui.log);
        session.modes[m] = { groups: g, checkedIdx: [], unlinkedGroups: [], seeded: false };
        ui.log(g.length ? `Found ${g.length} duplicate groups in this mode.` : 'No duplicates in this mode.');
        saveDedupeSession(session);
        return session.modes[m];
      };
      await ensureMode(mode);
      saveDedupeSession(session);

      // --- results UI --- (checkbox semantics: CHECKED = remove)
      // Rebuilt from scratch whenever the matching mode changes; everything
      // it touches lives in session.modes[mode], so the other modes' ticks
      // are untouched.
      const modeBar = el('div', { class: 'ycfp-row' });
      const resultsHost = el('div', {});
      ui.body.append(modeBar, resultsHost);
      ui.dlg.addEventListener('close', () => resultsHost.querySelectorAll('.ycfp-comparison').forEach((p) => p.remove()));

      const renderResults = () => {
        const modeState = session.modes[mode];
        const groups = modeState.groups;
        const rows = []; // {i, gi, cb, rowEl}
        const cbByIndex = new Map(); // entry index → its checkbox
        // Group indices marked "not actually duplicates" (✕). Restored from the
        // saved session; toggling one writes/removes the underlying
        // video-ID pairs from the unlinked-pairs database (see analyzeDuplicates).
        const unlinkedGroupSet = new Set(modeState.unlinkedGroups || []);
        const applyUnlinkedVisual = (groupDiv, groupCbs, unlinkBtn, checkAll, uncheckAll, on) => {
          groupDiv.classList.toggle('ycfp-group-unlinked', on);
          groupCbs.forEach((cb) => { cb.disabled = on; if (on) cb.checked = false; });
          checkAll.disabled = on;
          uncheckAll.disabled = on;
          unlinkBtn.textContent = on ? '↺' : '✕';
          unlinkBtn.title = on
            ? 'Re-link — allow this match again in future scans'
            : "Unlink — not a real duplicate; future scans won't group these together";
        };
        const groupEls = groups.map((g, gi) => {
          const groupCbs = []; // this group's checkboxes, for its check/uncheck buttons
          const groupRows = g.map((i) => {
            const e = entries[i];
            const cb = el('input', {
              type: 'checkbox', title: 'Check to REMOVE this entry',
              checked: (modeState.checkedIdx || []).includes(i),
            });
            groupCbs.push(cb);
            // Rows standing for several indistinguishable copies say so; ticking
            // one trims the extras rather than deleting the video (see buildPlan).
            const copyEl = el('span', {
              class: 'ycfp-entry-dur',
              title: 'This playlist gives no per-entry handles, so its copies of '
                + 'this video are one row. Ticking it leaves a single copy.',
            }, (e.copies || 1) > 1 ? `×${e.copies}` : '');
            const rowEl = el('div', { class: 'ycfp-entry' },
              cb,
              el('span', { class: 'ycfp-entry-dur' }, fmtDur(e.seconds)),
              copyEl,
              el('a', {
                class: 'ycfp-entry-title',
                href: `${ORIGIN}/watch?v=${e.id}&list=${e.playlistId}`,
                target: '_blank',
                rel: 'noreferrer',
                title: `${e.title}${e.channel ? ` · ${e.channel}` : ''} — open in new tab to verify`,
              }, e.title || e.id),
              el('span', { class: 'ycfp-entry-ch', title: e.channel }, e.channel),
              el('span', { class: 'ycfp-entry-pl' }, e.playlistTitle + (e.editable ? '' : ' 🔒')));
            rows.push({ i, gi, cb, rowEl, copyEl });
            cbByIndex.set(i, cb);
            return rowEl;
          });
          const crossCh = groupCrossChannel(g, entries);
          const compare = el('button', { class: 'ycfp-mini-btn', title: 'Compare this group side by side (thumbnails; each plays in a mini window)' }, '▶ Compare');
          compare.addEventListener('click', () => {
            resultsHost.querySelectorAll('.ycfp-comparison').forEach((p) => p.remove());
            const panel = buildDedupeComparison(g.map((i) => entries[i]));
            groupDiv.append(panel);
            panel.scrollIntoView({ block: 'nearest' });
          });
          const checkAll = el('button', { class: 'ycfp-mini-btn', title: 'Check every entry in this group' }, 'Check all');
          checkAll.addEventListener('click', () => { groupCbs.forEach((cb) => { cb.checked = true; }); persistSession(); });
          const uncheckAll = el('button', { class: 'ycfp-mini-btn', title: 'Uncheck every entry in this group' }, 'Uncheck all');
          uncheckAll.addEventListener('click', () => { groupCbs.forEach((cb) => { cb.checked = false; }); persistSession(); });
          const unlinkBtn = el('button', {
            class: 'ycfp-unlink-btn',
            title: "Unlink — not a real duplicate; future scans won't group these together",
          }, '✕');
          const groupDiv = el('div', { class: 'ycfp-group' + (crossCh ? ' ycfp-group-xch' : '') },
            el('div', { class: 'ycfp-group-head' },
              unlinkBtn,
              crossCh ? el('span', {
                class: 'ycfp-xch-star',
                title: 'Entries from different channels — check before removing',
              }, '*') : null,
              el('span', { class: 'ycfp-grp-label' },
                `#${gi + 1} · ${groupLabel(g, entries)} · ${g.length} entries`
                + (groupCopies(g, entries) !== g.length ? ` (${groupCopies(g, entries)} copies)` : '')),
              compare, checkAll, uncheckAll),
            ...groupRows);
          unlinkBtn.addEventListener('click', () => {
            const on = !groupDiv.classList.contains('ycfp-group-unlinked');
            applyUnlinkedVisual(groupDiv, groupCbs, unlinkBtn, checkAll, uncheckAll, on);
            const ids = [...new Set(g.map((idx) => entries[idx].id))];
            const pairs = loadUnlinkedPairs();
            for (let x = 0; x < ids.length; x++) {
              for (let y = x + 1; y < ids.length; y++) {
                const k = pairKey(ids[x], ids[y]);
                if (on) pairs.add(k); else pairs.delete(k);
              }
            }
            saveUnlinkedPairs(pairs);
            if (on) unlinkedGroupSet.add(gi); else unlinkedGroupSet.delete(gi);
            persistSession();
            if (hideUnsel) applyHide();
            if (hideUnlinked) applyHideUnlinked();
          });
          if (unlinkedGroupSet.has(gi)) applyUnlinkedVisual(groupDiv, groupCbs, unlinkBtn, checkAll, uncheckAll, true);
          return groupDiv;
        });
        const resultsEl = el('div', { class: 'ycfp-results' }, ...groupEls);

        // The exact same video listed more than once is unambiguously
        // redundant: pre-check every copy but one. A copy in a read-only
        // playlist can't be removed, so it's kept as the survivor when present.
        // Done once per mode — after that the saved checked state reflects it
        // plus whatever the user edited afterwards.
        if (!modeState.seeded) {
          modeState.seeded = true;
          let autoChecked = 0;
          for (const g of groups) {
            const byVid = new Map();
            for (const i of g) {
              const arr = byVid.get(entries[i].id);
              if (arr) arr.push(i); else byVid.set(entries[i].id, [i]);
            }
            for (const list of byVid.values()) {
              if (list.length < 2) continue;
              const locked = list.find((i) => !entries[i].editable);
              const keep = locked !== undefined ? locked : list[0];
              for (const i of list) {
                if (i === keep || !entries[i].editable) continue;
                const cb = cbByIndex.get(i);
                if (cb && !cb.checked) { cb.checked = true; autoChecked++; }
              }
            }
          }
          if (autoChecked) {
            ui.log(`Pre-checked ${autoChecked} redundant copy(ies) of videos listed more than once — one copy of each is always kept.`);
          }
          // Opened from a pull / new-songs run: that playlist's entries are
          // the new arrivals, so in every group that also holds a copy in
          // another playlist they are the ones pre-checked for removal.
          if (session.focusPid) {
            let nFocus = 0;
            for (const g of groups) {
              const others = g.filter((i) => entries[i].playlistId !== session.focusPid);
              if (!others.length) continue;
              for (const i of g) {
                if (entries[i].playlistId !== session.focusPid || !entries[i].editable) continue;
                const cb = cbByIndex.get(i);
                if (cb && !cb.checked) { cb.checked = true; nFocus++; }
              }
            }
            ui.log(nFocus ? `Pre-checked ${nFocus} entr${nFocus === 1 ? 'y' : 'ies'} of the new playlist that duplicate songs you already have — review, then remove.`
              : 'Nothing in the new playlist duplicates your other picked playlists.');
          }
        }
        // Entries already removed — in this mode or in another one, since a
        // removal is a removal everywhere.
        if (session.goneIdx && session.goneIdx.length) {
          const goneSet = new Set(session.goneIdx);
          for (const r of rows) {
            if (goneSet.has(r.i)) { r.rowEl.classList.add('ycfp-entry-gone'); r.cb.checked = false; }
          }
        }

        // Live-persist checkbox/unlink edits so a reload resumes with them intact.
        const persistSession = () => {
          modeState.checkedIdx = rows.filter((r) => r.cb.checked && !r.rowEl.classList.contains('ycfp-entry-gone')).map((r) => r.i);
          modeState.unlinkedGroups = [...unlinkedGroupSet];
          session.mode = mode;
          saveDedupeSession(session);
        };
        resultsEl.addEventListener('change', persistSession);
        persistSession();

        // Hide-unselected toggle: collapses the view to just what's checked.
        let hideUnsel = false;
        const hideBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Hide unselected');
        const applyHide = () => {
          for (const r of rows) {
            r.rowEl.classList.toggle('ycfp-row-hidden', hideUnsel && !r.cb.checked);
          }
          groupEls.forEach((gEl, gi) => {
            const any = groups[gi].some((i) => {
              const cb = cbByIndex.get(i);
              return cb && cb.checked;
            });
            gEl.classList.toggle('ycfp-group-hidden', hideUnsel && !any);
          });
        };
        hideBtn.addEventListener('click', () => {
          hideUnsel = !hideUnsel;
          hideBtn.textContent = hideUnsel ? 'Show all' : 'Hide unselected';
          hideBtn.classList.toggle('ycfp-on', hideUnsel);
          applyHide();
        });
        // Keep the filtered view honest as boxes are ticked/unticked.
        resultsEl.addEventListener('change', () => { if (hideUnsel) applyHide(); });

        // Hide-unlinked toggle: collapses away groups marked ✕ (not duplicates).
        let hideUnlinked = false;
        const hideUnlinkedBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Hide unlinked');
        const applyHideUnlinked = () => {
          groupEls.forEach((gEl) => {
            gEl.classList.toggle('ycfp-group-hidden-unlinked',
              hideUnlinked && gEl.classList.contains('ycfp-group-unlinked'));
          });
        };
        hideUnlinkedBtn.addEventListener('click', () => {
          hideUnlinked = !hideUnlinked;
          hideUnlinkedBtn.textContent = hideUnlinked ? 'Show unlinked' : 'Hide unlinked';
          hideUnlinkedBtn.classList.toggle('ycfp-on', hideUnlinked);
          applyHideUnlinked();
        });

        // Hide-cross-channel toggle: collapses away the starred (*) groups
        // whose entries come from different channels.
        let hideXch = false;
        const hideXchBtn = el('button', {
          class: 'ycfp-btn ycfp-secondary',
          title: 'Hide the starred (*) groups whose entries come from different channels',
        }, 'Hide cross-channel');
        hideXchBtn.addEventListener('click', () => {
          hideXch = !hideXch;
          hideXchBtn.textContent = hideXch ? 'Show cross-channel' : 'Hide cross-channel';
          hideXchBtn.classList.toggle('ycfp-on', hideXch);
          groupEls.forEach((gEl) => {
            gEl.classList.toggle('ycfp-group-hidden-xch', hideXch && gEl.classList.contains('ycfp-group-xch'));
          });
        });

        // Hide-resolved toggle: collapses away groups that removals have
        // already brought down to one entry (or none) — nothing left to decide
        // there. Re-applied after every removal and undo.
        let hideResolved = false;
        const hideResolvedBtn = el('button', {
          class: 'ycfp-btn ycfp-secondary',
          title: 'Hide groups where removals have left only one entry (or none)',
        }, 'Hide resolved');
        const applyHideResolved = () => {
          groupEls.forEach((gEl, gi) => {
            const live = groups[gi].filter((i) => !gone(rows.find((r) => r.i === i)));
            // A lone survivor still standing for several copies isn't resolved.
            const resolved = live.length === 0
              || (live.length === 1 && (entries[live[0]].copies || 1) <= 1);
            gEl.classList.toggle('ycfp-group-hidden-resolved', hideResolved && resolved);
          });
        };
        hideResolvedBtn.addEventListener('click', () => {
          hideResolved = !hideResolved;
          hideResolvedBtn.textContent = hideResolved ? 'Show resolved' : 'Hide resolved';
          hideResolvedBtn.classList.toggle('ycfp-on', hideResolved);
          applyHideResolved();
        });

        const gone =(r) => r.rowEl.classList.contains('ycfp-entry-gone');
        const markGone = (removedSet) => {
          for (const r of rows) {
            if (removedSet.has(r.i)) { r.rowEl.classList.add('ycfp-entry-gone'); r.cb.checked = false; }
          }
          const goneSet = new Set([...(session.goneIdx || []), ...removedSet]);
          session.goneIdx = [...goneSet];
          modeState.checkedIdx = rows.filter((r) => r.cb.checked && !gone(r)).map((r) => r.i);
          // Every group of EVERY analyzed mode down to at most one surviving
          // copy (or unlinked, i.e. deliberately left alone): nothing left to
          // resume, so drop the saved scan instead of leaving stale clutter.
          // Other modes are judged on removals alone — their own ✕ marks live
          // in their own state.
          const resolvedIn = (gs, unlinked) => gs.every((g, gi) => {
            if (unlinked.has(gi)) return true;
            const live = g.filter((i) => !goneSet.has(i));
            // A lone survivor still standing for several copies isn't resolved.
            return live.length === 0
              || (live.length === 1 && (entries[live[0]].copies || 1) <= 1);
          });
          const allResolved = Object.entries(session.modes).every(([k, m]) =>
            resolvedIn(m.groups || [], k === mode ? unlinkedGroupSet : new Set(m.unlinkedGroups || [])));
          if (allResolved) clearDedupeSession();
          else saveDedupeSession(session);
        };

        // Undo the last removal batch (re-adds to the source playlists).
        let lastRemoved = null;
        const undoBtn = el('button', { class: 'ycfp-btn ycfp-secondary', style: 'display:none' }, '↩ Undo last removal');
        undoBtn.addEventListener('click', async () => {
          if (undoBtn.disabled || !lastRemoved) return;
          undoBtn.disabled = true;
          try {
            const n = await undoRemovals(lastRemoved, cfg, ui.log, ui.guard);
            const restored = new Set(lastRemoved);
            const restoredIdx = new Set();
            for (const r of rows) {
              if (restored.has(entries[r.i])) { r.rowEl.classList.remove('ycfp-entry-gone'); restoredIdx.add(r.i); }
            }
            session.goneIdx = (session.goneIdx || []).filter((i) => !restoredIdx.has(i));
            saveDedupeSession(session);
            ui.log(`↩ Restored ${n} entries.`);
            lastRemoved = null;
            undoBtn.style.display = 'none';
            if (hideResolved) applyHideResolved();
          } catch (e) {
            ui.log(`❌ ${e.message || e}`);
          } finally {
            undoBtn.disabled = false;
          }
        });

        const doRemove = async (plan) => {
          ui.log(`Removing ${plan.toRemove.length} entries…`);
          const { failed, removedCopies } = await executeRemovals(
            plan.toRemove, plan.kept, cfg, ui.log, ui.guard, 'dedupe');
          const okIdx = new Set([...plan.removedIdx].filter((i) => !failed.has(entries[i])));
          markGone(okIdx);
          // Trimmed rows keep one copy, so they stay — just with a new count.
          for (const i of plan.trimIdx) {
            if (failed.has(entries[i])) continue;
            entries[i].copies = 1;
            const r = rows.find((row) => row.i === i);
            if (r) { r.cb.checked = false; if (r.copyEl) r.copyEl.textContent = ''; }
            ui.log(`"${entries[i].title || entries[i].id}" in "${entries[i].playlistTitle}": trimmed to a single copy.`);
          }
          if (plan.trimIdx.size) { persistSession(); saveDedupeSession(session); }
          if (hideResolved) applyHideResolved();
          lastRemoved = removedCopies;
          undoBtn.style.display = lastRemoved.length ? '' : 'none';
          ui.log(`✅ Done: ${removedCopies.length} cop${removedCopies.length === 1 ? 'y' : 'ies'} removed${failed.size ? `, ${failed.size} failed (see above)` : ''}.`);
        };

        // Checked = remove. Groups whose every (removable) entry is checked
        // would lose all copies — that needs explicit Force continue.
        const buildPlan = () => {
          const toRemove = [], kept = [], removedIdx = new Set(), trimIdx = new Set();
          let emptiedGroups = 0;
          for (const [gi, g] of groups.entries()) {
            if (unlinkedGroupSet.has(gi)) continue; // not a real duplicate — never touch
            const gRows = rows.filter((r) => g.includes(r.i) && !gone(r));
            if (!gRows.length) continue;
            const willRemove = (r) => r.cb.checked && entries[r.i].editable;
            if (!gRows.some(willRemove)) continue;
            // Nothing would survive this group. That is a wipe, and needs the
            // Force-continue warning — except for a group that IS a single row
            // standing for several indistinguishable copies, where "remove" can
            // only sensibly mean "drop the extras": one copy is kept back.
            let trimRow = null;
            if (gRows.every(willRemove)) {
              if (gRows.length === 1 && (entries[gRows[0].i].copies || 1) > 1) trimRow = gRows[0];
              else emptiedGroups++;
            }
            for (const r of gRows) {
              if (willRemove(r)) { toRemove.push(entries[r.i]); removedIdx.add(r.i); }
              else kept.push(entries[r.i]);
            }
            if (trimRow) {
              // Asks executeRemovals to put exactly one copy back.
              kept.push(Object.assign({}, entries[trimRow.i], { copies: 1 }));
              trimIdx.add(trimRow.i);
              removedIdx.delete(trimRow.i); // the row survives, with one copy
            }
          }
          return { toRemove, kept, removedIdx, trimIdx, emptiedGroups };
        };

        let warnEl = null;
        const manualBtn = el('button', { class: 'ycfp-btn' }, 'Remove checked entries');
        manualBtn.addEventListener('click', async () => {
          if (manualBtn.disabled) return;
          if (warnEl) { warnEl.remove(); warnEl = null; }
          const plan = buildPlan();
          if (!plan.toRemove.length) { ui.log('Nothing checked — tick the entries you want removed.'); return; }
          if (plan.emptiedGroups > 0) {
            const forceBtn = el('button', { class: 'ycfp-btn' }, 'Force continue');
            const reviseBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Revise');
            warnEl = el('div', { class: 'ycfp-warn' },
              el('div', {}, `⚠ ${plan.emptiedGroups} group(s) have EVERY entry checked — removing them leaves no copy in any playlist.`),
              el('div', { class: 'ycfp-row' }, reviseBtn, forceBtn));
            reviseBtn.addEventListener('click', () => { warnEl.remove(); warnEl = null; });
            forceBtn.addEventListener('click', async () => {
              warnEl.remove(); warnEl = null;
              manualBtn.disabled = true;
              try { await doRemove(buildPlan()); }
              catch (e) { ui.log(`❌ ${e.message || e}`); }
              finally { manualBtn.disabled = false; }
            });
            manualBtn.parentElement.insertAdjacentElement('beforebegin', warnEl);
            return;
          }
          manualBtn.disabled = true;
          try { await doRemove(plan); }
          catch (e) { ui.log(`❌ ${e.message || e}`); }
          finally { manualBtn.disabled = false; }
        });

        const uncheckBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Uncheck all');
        uncheckBtn.addEventListener('click', () => {
          rows.forEach((r) => { if (!gone(r)) r.cb.checked = false; });
          persistSession();
        });

        // Bulk selection: CHECKS one playlist's duplicate entries for removal.
        // It never checks a whole group — one copy always survives; wiping
        // every copy requires checking manually (guarded by Force continue).
        const editablePls = selected.filter((p) => entries.some((e) => e.playlistId === p.id && e.editable));
        const bulkSel = el('select', {},
          ...editablePls.map((p) => el('option', { value: p.id }, p.title)));
        const bulkBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Select its duplicate entries');
        bulkBtn.addEventListener('click', () => {
          if (!bulkSel.value) return;
          const pid = bulkSel.value;
          let marked = 0, skippedXch = 0;
          for (const [gi, g] of groups.entries()) {
            if (unlinkedGroupSet.has(gi)) continue; // not a real duplicate — never touch
            const live = g.filter((i) => !gone(rows.find((r) => r.i === i)));
            // Cross-channel groups (starred): different artists could be a false
            // match, so never auto-check them — leave both for manual review.
            if (groupCrossChannel(live, entries)) { skippedXch++; continue; }
            const inP = live.filter((i) => entries[i].playlistId === pid && entries[i].editable);
            if (!inP.length) continue;
            const outside = live.filter((i) => entries[i].playlistId !== pid);
            const removeIdx = outside.length ? inP : inP.slice(1); // always leaves one copy
            for (const i of live) {
              rows.find((r) => r.i === i).cb.checked = removeIdx.includes(i);
            }
            marked += removeIdx.length;
          }
          if (marked) persistSession();
          ui.log((marked
            ? `Checked ${marked} duplicate entries for removal — review, then press "Remove checked entries".`
            : 'That playlist has no removable duplicate entries.')
            + (skippedXch ? ` Left ${skippedXch} cross-channel group(s) (★) unchecked — review those by hand.` : ''));
        });

        resultsHost.textContent = '';
        resultsHost.append(
          resultsEl,
          el('div', { class: 'ycfp-row' }, manualBtn, uncheckBtn, hideBtn, hideUnlinkedBtn, hideXchBtn, hideResolvedBtn, undoBtn),
          el('div', { class: 'ycfp-row' }, bulkSel, bulkBtn));
      };

      // --- mode switcher ---
      // The scan is the expensive part and it's already done, so every mode
      // is one click away. Each remembers its own ticks; a mode not yet
      // analyzed is grouped on the spot from the same entries.
      let switching = false;
      const modeBtns = MATCH_MODES.map((m) => {
        const b = el('button', {
          class: 'ycfp-btn ycfp-secondary' + (m.key === mode ? ' ycfp-on' : ''),
          title: m.label,
        }, m.label.split(' — ')[0]);
        b.addEventListener('click', async () => {
          if (switching || m.key === mode) return;
          switching = true;
          modeBtns.forEach((x) => { x.disabled = true; });
          try {
            await ensureMode(m.key);
            ui.guard();
            mode = m.key;
            session.mode = mode;
            saveDedupeSession(session);
            modeBtns.forEach((x, i) => x.classList.toggle('ycfp-on', MATCH_MODES[i].key === mode));
            renderResults();
            const n = session.modes[mode].groups.length;
            ui.log(`Showing ${MODE_LABEL(mode)} — ${n} group(s). Your ticks in the other modes are kept.`);
          } catch (e) {
            ui.log(`❌ ${e.message || e}`);
          } finally {
            switching = false;
            modeBtns.forEach((x) => { x.disabled = false; });
          }
        });
        return b;
      });
      modeBar.append(el('span', { class: 'ycfp-entry-pl' }, 'Matching mode:'), ...modeBtns);

      renderResults();
      if (!session.modes[mode].groups.length) {
        ui.log('✅ No duplicates in this mode — try a looser one above; the playlists do not have to be read again.');
      }
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  // Remove Shorts (and sub-minute videos) from the playlist being viewed.
  // Paste video links (or bare ids, one per line or space-separated) and add
  // them to the playlist being viewed, or take them out of it. For staging
  // lists like Available replacements / Unavailable videos, filled from a
  // list worked out elsewhere. Adding skips videos already there; removing
  // takes out every copy of each video.
  async function runLinksFlow() {
    if (running) return;
    running = true;
    const cfg = loadCfg();
    const ui = openDialog('Add / remove video links', true);
    try {
      const listId = new URLSearchParams(location.search).get('list');
      if (!listId) throw new Error('No ?list= in the URL.');
      const box = el('textarea', { rows: '10', placeholder: 'https://www.youtube.com/watch?v=…\none link or id per line' });
      const addBtn = el('button', { class: 'ycfp-btn' }, '➕ Add to this playlist');
      const rmBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, '➖ Remove from this playlist');
      ui.body.append(box, el('div', { class: 'ycfp-row' }, addBtn, rmBtn));
      const action = await new Promise((res) => {
        addBtn.addEventListener('click', () => res('add'), { once: true });
        rmBtn.addEventListener('click', () => res('remove'), { once: true });
        ui.dlg.addEventListener('close', () => res(null), { once: true });
      });
      if (!action) return;
      addBtn.disabled = true; rmBtn.disabled = true; box.disabled = true;
      const ids = [...new Set(box.value.split(/\s+/).filter(Boolean)
        .map((s) => (/^[\w-]{11}$/.test(s) ? s : videoIdOfUrl(s))).filter(Boolean))];
      if (!ids.length) { ui.log('No video links found.'); return; }
      // Hidden unavailable videos included: a list like Unavailable videos
      // reads as empty otherwise, and nothing in it could be removed.
      const vids = await readWithUnavailable({ id: listId, title: 'Playlist' }, ui.log, ui.guard);
      let editable = vids.editable;
      if (editable === undefined) editable = await isPlaylistEditable(listId, vids[0] && vids[0].id);
      if (!editable) { ui.log('❌ You cannot edit this playlist.'); return; }
      const have = new Set(vids.map((v) => v.id));
      if (action === 'add') {
        const todo = ids.filter((id) => !have.has(id));
        ui.log(`${ids.length} link(s): ${ids.length - todo.length} already in the playlist, adding ${todo.length}.`);
        if (todo.length) await addToPlaylist(listId, todo, cfg, ui.log, ui.guard);
        ui.log(`✅ Added ${todo.length}.`);
      } else {
        const todo = ids.filter((id) => have.has(id));
        ui.log(`${ids.length} link(s): ${ids.length - todo.length} not in the playlist, removing ${todo.length}.`);
        if (todo.length) await removeManyFromPlaylist(listId, todo.map((id) => ({ id })), cfg, ui.log);
        ui.log(`✅ Removed ${todo.length}.`);
      }
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  async function runRemoveShortsFlow() {
    if (running) return;
    running = true;
    const cfg = loadCfg();
    const ui = openDialog('Remove Shorts from this playlist', true);
    try {
      const listId = new URLSearchParams(location.search).get('list');
      if (!listId) throw new Error('No ?list= in the URL.');
      const vids = await fetchPlaylistVideos(listId, 'Playlist', ui.log, ui.guard, { keepDupes: true });
      ui.log(`Playlist: ${vids.length} entries.`);
      let editable = vids.editable;
      if (editable === undefined) editable = await isPlaylistEditable(listId, vids[0] && vids[0].id);
      if (!editable) { ui.log('❌ You cannot edit this playlist.'); return; }

      // Shorts by data tag, plus anything with a known duration under 60s.
      const candidates = vids.filter((v) => v.isShort || (v.seconds > 0 && v.seconds < 60));
      if (!candidates.length) { ui.log('✅ No Shorts or sub-minute videos found.'); return; }
      ui.log(`${candidates.length} Shorts / sub-minute videos found — review, then remove.`);

      const rows = candidates.map((v) => {
        const cb = el('input', { type: 'checkbox', checked: true, title: 'Remove this entry' });
        const rowEl = el('div', { class: 'ycfp-entry' },
          cb,
          el('span', { class: 'ycfp-entry-dur' }, fmtDur(v.seconds)),
          el('a', {
            class: 'ycfp-entry-title',
            href: `${ORIGIN}/watch?v=${v.id}`,
            target: '_blank', rel: 'noreferrer',
            title: `${v.title} — open in new tab to verify`,
          }, v.title || v.id),
          el('span', { class: 'ycfp-entry-pl' }, v.isShort ? 'Short' : '< 1 min'));
        return { v, cb, rowEl };
      });

      let lastRemoved = null, lastRows = null;
      const undoBtn = el('button', { class: 'ycfp-btn ycfp-secondary', style: 'display:none' }, '↩ Undo last removal');
      undoBtn.addEventListener('click', async () => {
        if (undoBtn.disabled || !lastRemoved) return;
        undoBtn.disabled = true;
        try {
          const n = await undoRemovals(lastRemoved, cfg, ui.log, ui.guard);
          if (lastRows) for (const r of lastRows) r.rowEl.classList.remove('ycfp-entry-gone');
          ui.log(`↩ Restored ${n} entries.`);
          lastRemoved = null; lastRows = null;
          undoBtn.style.display = 'none';
        } catch (e) {
          ui.log(`❌ ${e.message || e}`);
        } finally {
          undoBtn.disabled = false;
        }
      });

      const removeBtn = el('button', { class: 'ycfp-btn' }, 'Remove checked entries');
      removeBtn.addEventListener('click', async () => {
        if (removeBtn.disabled) return;
        removeBtn.disabled = true;
        try {
          const live = rows.filter((r) => r.cb.checked && !r.rowEl.classList.contains('ycfp-entry-gone'));
          if (!live.length) { ui.log('Nothing checked.'); return; }
          const toRemove = live.map((r) => Object.assign({}, r.v,
            { playlistId: listId, playlistTitle: 'this playlist' }));
          const removeKeys = new Set(toRemove.map((t) => t.setVideoId || t.id));
          const kept = vids
            .filter((v) => !removeKeys.has(v.setVideoId || v.id))
            .map((v) => Object.assign({}, v, { playlistId: listId }));
          ui.log(`Removing ${toRemove.length} entries…`);
          const { failed, removedCopies } = await executeRemovals(toRemove, kept, cfg, ui.log, ui.guard, 'shorts');
          live.forEach((r, j) => {
            if (!failed.has(toRemove[j])) { r.rowEl.classList.add('ycfp-entry-gone'); r.cb.checked = false; }
          });
          lastRemoved = removedCopies;
          lastRows = live.filter((r, j) => !failed.has(toRemove[j]));
          undoBtn.style.display = lastRemoved.length ? '' : 'none';
          ui.log(`✅ Done: ${lastRemoved.length} entries removed${failed.size ? `, ${failed.size} failed` : ''}.`);
        } catch (e) {
          ui.log(`❌ ${e.message || e}`);
        } finally {
          removeBtn.disabled = false;
        }
      });

      ui.body.append(
        el('div', { class: 'ycfp-results' }, ...rows.map((r) => r.rowEl)),
        el('div', { class: 'ycfp-row' }, removeBtn, undoBtn));
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  // Remove every video of one (or more) channels from the playlist being
  // viewed. The playlist's own entries carry the uploader's name (byline), so
  // the channel list is built from the playlist itself — no search, no API
  // key, and no way to pick a channel that isn't actually in there.
  async function runRemoveChannelFlow() {
    if (running) return;
    running = true;
    const cfg = loadCfg();
    const ui = openDialog('Remove a channel’s videos from this playlist', true);
    try {
      const listId = new URLSearchParams(location.search).get('list');
      if (!listId) throw new Error('No ?list= in the URL.');
      const vids = await fetchPlaylistVideos(listId, 'Playlist', ui.log, ui.guard, { keepDupes: true });
      ui.log(`Playlist: ${vids.length} entries.`);
      let editable = vids.editable;
      if (editable === undefined) editable = await isPlaylistEditable(listId, vids[0] && vids[0].id);
      if (!editable) { ui.log('❌ You cannot edit this playlist.'); return; }
      if (!vids.length) { ui.log('Nothing in this playlist.'); return; }

      const UNKNOWN = '(unknown channel)';
      const keyOf = (v) => (v.setVideoId ? 'S' + v.setVideoId : 'V' + v.id);
      const gone = new Set(); // entries already removed in this session

      // Group the live entries by uploader. With `mergeTopic` on, "<X> - Topic"
      // and "<X>" count as the same artist (that pair is one channel for
      // music playlists in practice).
      const buildGroups = (mergeTopic) => {
        const map = new Map();
        for (const v of vids) {
          if (gone.has(keyOf(v))) continue;
          const name = (v.channel || '').trim();
          const label = (mergeTopic ? name.replace(TOPIC_SUFFIX, '').trim() : name) || name;
          const key = label.toLowerCase() || '~none~';
          let g = map.get(key);
          if (!g) { g = { key, label: label || UNKNOWN, names: new Set(), videos: [] }; map.set(key, g); }
          if (name && name !== g.label) g.names.add(name);
          g.videos.push(v);
        }
        return [...map.values()].sort((a, b) =>
          b.videos.length - a.videos.length || a.label.localeCompare(b.label));
      };

      const topicBox = el('input', { type: 'checkbox', checked: true });
      const filterInput = el('input', { type: 'text', placeholder: 'Filter channels…' });
      const listEl = el('div', { class: 'ycfp-pl-list' });
      const countEl = el('label', {}, '');
      const resultsEl = el('div', {});
      // Ticks survive filtering and the Topic-merge toggle (they're keyed by
      // channel, not by the row element, which gets rebuilt).
      const ticked = new Set();
      let groups = [];

      const renderChannels = () => {
        groups = buildGroups(topicBox.checked);
        const q = filterInput.value.trim().toLowerCase();
        listEl.replaceChildren();
        let shown = 0;
        for (const g of groups) {
          const hay = [g.label, ...g.names].join(' ').toLowerCase();
          if (q && !hay.includes(q)) continue;
          shown++;
          const cb = el('input', { type: 'checkbox', checked: ticked.has(g.key) });
          cb.addEventListener('change', () => {
            if (cb.checked) ticked.add(g.key); else ticked.delete(g.key);
          });
          const extra = g.names.size ? ` (+ ${[...g.names].join(', ')})` : '';
          const rowEl = el('label', { class: 'ycfp-check', title: g.label + extra },
            cb,
            el('span', { class: 'ycfp-entry-title' }, g.label + extra),
            el('span', { class: 'ycfp-entry-pl' }, `${g.videos.length} video${g.videos.length === 1 ? '' : 's'}`));
          listEl.append(rowEl);
        }
        countEl.textContent = `${groups.length} channel(s) in this playlist`
          + (q ? ` — ${shown} shown` : '') + '. Tick the ones to clear out.';
      };

      const showBtn = el('button', { class: 'ycfp-btn' }, 'Show their videos →');
      showBtn.addEventListener('click', () => {
        const picked = groups.filter((g) => ticked.has(g.key));
        if (!picked.length) { ui.log('⚠ Tick at least one channel first.'); return; }
        renderVideos(picked);
      });

      topicBox.addEventListener('change', renderChannels);
      filterInput.addEventListener('input', renderChannels);

      // --- step 2: reviewable checklist of that channel's entries ---
      function renderVideos(groups) {
        const picks = groups.flatMap((g) => g.videos).filter((v) => !gone.has(keyOf(v)));
        const names = groups.map((g) => g.label).join(', ');
        ui.log(`${names}: ${picks.length} entr${picks.length === 1 ? 'y' : 'ies'} — review, then remove.`);

        const rows = picks.map((v) => {
          const cb = el('input', { type: 'checkbox', checked: true, title: 'Remove this entry' });
          const rowEl = el('div', { class: 'ycfp-entry' },
            cb,
            el('span', { class: 'ycfp-entry-dur' }, fmtDur(v.seconds)),
            el('a', {
              class: 'ycfp-entry-title',
              href: `${ORIGIN}/watch?v=${v.id}`,
              target: '_blank', rel: 'noreferrer',
              title: `${v.title} — open in new tab to verify`,
            }, v.title || v.id),
            el('span', { class: 'ycfp-entry-ch' }, v.channel || ''));
          return { v, cb, rowEl };
        });

        const allBtn = el('button', { class: 'ycfp-mini-btn' }, 'Uncheck all');
        allBtn.addEventListener('click', () => {
          const on = allBtn.textContent === 'Check all';
          rows.forEach((r) => { if (!r.rowEl.classList.contains('ycfp-entry-gone')) r.cb.checked = on; });
          allBtn.textContent = on ? 'Uncheck all' : 'Check all';
        });
        const backBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, '← Pick another channel');
        backBtn.addEventListener('click', () => {
          resultsEl.replaceChildren();
          pickEl.style.display = '';
          renderChannels();
        });

        let lastRemoved = null, lastRows = null;
        const undoBtn = el('button', { class: 'ycfp-btn ycfp-secondary', style: 'display:none' }, '↩ Undo last removal');
        undoBtn.addEventListener('click', async () => {
          if (undoBtn.disabled || !lastRemoved) return;
          undoBtn.disabled = true;
          try {
            const n = await undoRemovals(lastRemoved, cfg, ui.log, ui.guard);
            for (const e of lastRemoved) gone.delete(keyOf(e));
            if (lastRows) for (const r of lastRows) r.rowEl.classList.remove('ycfp-entry-gone');
            ui.log(`↩ Restored ${n} entries.`);
            lastRemoved = null; lastRows = null;
            undoBtn.style.display = 'none';
          } catch (e) {
            ui.log(`❌ ${e.message || e}`);
          } finally {
            undoBtn.disabled = false;
          }
        });

        const removeBtn = el('button', { class: 'ycfp-btn' }, 'Remove checked entries');
        removeBtn.addEventListener('click', async () => {
          if (removeBtn.disabled) return;
          removeBtn.disabled = true;
          try {
            const live = rows.filter((r) => r.cb.checked && !r.rowEl.classList.contains('ycfp-entry-gone'));
            if (!live.length) { ui.log('Nothing checked.'); return; }
            const toRemove = live.map((r) => Object.assign({}, r.v,
              { playlistId: listId, playlistTitle: 'this playlist' }));
            const removeKeys = new Set(toRemove.map((t) => t.setVideoId || t.id));
            const kept = vids
              .filter((v) => !gone.has(keyOf(v)) && !removeKeys.has(v.setVideoId || v.id))
              .map((v) => Object.assign({}, v, { playlistId: listId }));
            ui.log(`Removing ${toRemove.length} entries…`);
            const { failed, removedCopies } = await executeRemovals(toRemove, kept, cfg, ui.log, ui.guard, 'channel');
            live.forEach((r, j) => {
              if (!failed.has(toRemove[j])) {
                r.rowEl.classList.add('ycfp-entry-gone');
                r.cb.checked = false;
                gone.add(keyOf(r.v));
              }
            });
            lastRemoved = removedCopies;
            lastRows = live.filter((r, j) => !failed.has(toRemove[j]));
            undoBtn.style.display = lastRemoved.length ? '' : 'none';
            ui.log(`✅ Done: ${lastRemoved.length} entries removed${failed.size ? `, ${failed.size} failed` : ''}.`);
          } catch (e) {
            ui.log(`❌ ${e.message || e}`);
          } finally {
            removeBtn.disabled = false;
          }
        });

        resultsEl.replaceChildren(
          el('label', {}, `${names} — ${picks.length} entr${picks.length === 1 ? 'y' : 'ies'} (checked = remove):`),
          el('div', { class: 'ycfp-results' }, ...rows.map((r) => r.rowEl)),
          el('div', { class: 'ycfp-row' }, removeBtn, allBtn, backBtn, undoBtn));
        pickEl.style.display = 'none';
      }

      const pickEl = el('div', {},
        countEl,
        el('label', { class: 'ycfp-check' }, topicBox,
          el('span', {}, 'Treat "X - Topic" as the same channel as "X"')),
        filterInput,
        listEl,
        el('div', { class: 'ycfp-row' }, showBtn));

      renderChannels();
      ui.body.append(pickEl, resultsEl);
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  // 📜 Removed & moved videos — every video that left one of your
  // playlists, reviewable any time from the 📜 button: filter by time,
  // playlist, channel, what happened and how, then undo, allow re-collecting,
  // or have the script check whether a "removed" one was really moved.
  //
  // This is also the old deleted-video ledger view: "Skipped by collects"
  // = on the ledger. (openDeletedLedger opens it pre-filtered that way.)
  const REVIEW_SRC = {
    quick: '✕ button',
    move: 'Quick-move button',
    dedupe: '🧹 Dedupe',
    channel: '🚫 Remove a channel',
    shorts: '✂ Remove Shorts',
    dead: '🪦 Dead-video cleanup',
    unavail: '⊘ Move unavailable',
    detected: 'In YouTube (noticed later)',
  };
  const REVIEW_WHEN = [
    ['any', 'Any time', 0], ['1d', 'Last 24 hours', 1], ['7d', 'Last 7 days', 7],
    ['30d', 'Last 30 days', 30], ['90d', 'Last 90 days', 90], ['365d', 'Last year', 365],
    ['custom', 'Between dates…', 0],
  ];
  const REVIEW_PAGE = 400;

  const openDeletedLedger = () => openHistory({ skipped: 'yes' });

  async function openHistory(preset = {}) {
    if (running) return; // never replace a running flow's dialog
    const cfg = loadCfg();
    const ui = openDialog('📜 Removed & moved videos', true);
    ui.dlg.classList.add('ycfp-dialog-review');
    const loading = el('div', {}, 'Loading the history…');
    ui.body.append(loading);

    const idx = await archIndex(60 * 1000);
    let rows = await evAll();
    const gone = loadGone();

    // Ledger rows nothing in the history explains (possible only if
    // IndexedDB was unavailable when they were recorded) still belong here.
    const seen = new Set(rows.map((r) => r.id));
    for (const [id, g] of Object.entries(gone)) {
      if (seen.has(id)) continue;
      rows.push({ k: null, t: g.ts || 0, src: 'detected', kind: 'removed', id, title: g.t || '',
        channel: g.c || '', seconds: g.s || 0, playlistId: g.pid || '', playlistTitle: g.p || '', to: [] });
    }

    // Correct the record from what the archive knows now, without asking
    // YouTube anything: a "removed" video that is in another of your
    // playlists was moved; one back in the playlist it left was restored.
    const fixed = [];
    let nMovedFix = 0;
    for (const r of rows) {
      const meta = archMeta(idx, r.id);
      if (!r.title) r.title = meta[0];
      if (!r.seconds) r.seconds = meta[1];
      if (!r.channel) r.channel = meta[2];
      if (!r.playlistId && r.playlistTitle) {
        for (const [pid, t] of idx.titles) if (t === r.playlistTitle) { r.playlistId = pid; break; }
      }
      // A duplicate the deduper took out is SUPPOSED to still be in your
      // library — that's the copy it kept. Shown as such, never re-labelled.
      if (r.src === 'dedupe') { r.keptIn = archWhereElse(idx, r.id, '').map((x) => x.title); continue; }
      if (r.kind !== 'removed' || r.restored) continue;
      const inPl = idx.byVid.get(r.id);
      if (!inPl) continue;
      if (r.playlistId && inPl.has(r.playlistId)) { r.restored = true; fixed.push(r); continue; }
      const where = archWhereElse(idx, r.id, r.playlistId);
      if (where.length) {
        r.kind = 'moved';
        r.to = where;
        r.reclassified = true;
        fixed.push(r);
        nMovedFix++;
      }
    }
    if (fixed.length) {
      await evPut(fixed.filter((r) => r.k !== null && r.k !== undefined));
      const ids = fixed.filter((r) => r.kind === 'moved').map((r) => r.id);
      if (ids.length) forgetDeleted(ids);
    }
    loading.remove();

    if (!rows.length) {
      ui.log('Nothing recorded yet. From now on, every video that leaves one of your playlists — removed with '
        + 'the script\'s buttons, removed or moved by you in YouTube (noticed the next time that playlist is read) — '
        + 'is listed here.');
      return;
    }
    if (nMovedFix) {
      ui.log(`✔ ${nMovedFix} video(s) listed as removed are in another of your playlists — corrected to "moved", `
        + 'and collects no longer skip them.');
    }

    // ---- filters ----
    const opt = (v, label) => el('option', { value: v }, label);
    const countBy = (key) => {
      const m = new Map();
      for (const r of rows) {
        const k = key(r);
        if (k) m.set(k, (m.get(k) || 0) + 1);
      }
      return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    };
    const plName = (r) => r.playlistTitle || r.playlistId || '';
    const qIn = el('input', { type: 'text', placeholder: 'Search title, channel or playlist…' });
    const kindSel = el('select', {}, opt('all', 'Removed or moved'), opt('removed', 'Removed'),
      opt('moved', 'Moved to another playlist'), opt('dupe', 'Duplicates the deduper removed'),
      opt('restored', 'Restored (undone)'));
    const srcSel = el('select', {}, opt('', 'Any way'),
      ...Object.entries(REVIEW_SRC).filter(([k]) => rows.some((r) => r.src === k)).map(([k, v]) => opt(k, v)));
    const whenSel = el('select', {}, ...REVIEW_WHEN.map(([v, label]) => opt(v, label)));
    const fromIn = el('input', { type: 'date' });
    const toIn = el('input', { type: 'date' });
    const dateRow = el('span', { class: 'ycfp-daterange', style: 'display:none' }, fromIn, ' – ', toIn);
    const plSel = el('select', {}, opt('', 'All playlists'),
      ...countBy(plName).map(([p, n]) => opt(p, `${p} (${n})`)));
    const chSel = el('select', {}, opt('', 'All channels'),
      ...countBy((r) => r.channel).map(([c, n]) => opt(c, `${c} (${n})`)));
    const skipSel = el('select', {}, opt('', 'Skipped by collects or not'),
      opt('yes', 'Still skipped by collects'), opt('no', 'Collectable again'));
    const sortSel = el('select', {}, opt('new', 'Newest first'), opt('old', 'Oldest first'),
      opt('title', 'Title A–Z'), opt('channel', 'Channel A–Z'), opt('playlist', 'Playlist A–Z'));
    const resetBtn = el('button', { class: 'ycfp-mini-btn' }, 'Reset filters');
    if (preset.skipped) skipSel.value = preset.skipped;
    if (preset.kind) kindSel.value = preset.kind;

    const summary = el('div', { class: 'ycfp-review-summary' });
    const listEl = el('div', { class: 'ycfp-results' });
    const moreBtn = el('button', { class: 'ycfp-btn ycfp-secondary', style: 'display:none' }, '');
    let shown = REVIEW_PAGE;
    let matches = [];
    const boxes = new Map(); // row → checkbox

    const dayStart = (s) => (s ? new Date(s + 'T00:00:00').getTime() : null);
    function filtered() {
      const q = normTitle(qIn.value);
      const now = Date.now();
      const w = REVIEW_WHEN.find((x) => x[0] === whenSel.value);
      let from = null, to = null;
      if (whenSel.value === 'custom') {
        from = dayStart(fromIn.value);
        to = dayStart(toIn.value);
        if (to !== null) to += 24 * 60 * 60 * 1000; // inclusive of the end day
      } else if (w && w[2]) from = now - w[2] * 24 * 60 * 60 * 1000;
      const g = loadGone();
      const out = rows.filter((r) => {
        if (kindSel.value === 'restored' ? !r.restored
          : kindSel.value === 'dupe' ? (r.src !== 'dedupe' || r.kind === 'moved' || r.restored)
            : (kindSel.value !== 'all' && (r.kind !== kindSel.value || r.restored))) return false;
        if (srcSel.value && r.src !== srcSel.value) return false;
        if (from !== null && (r.t || 0) < from) return false;
        if (to !== null && (r.t || 0) >= to) return false;
        if (plSel.value && plName(r) !== plSel.value
          && !(r.to || []).some((x) => x.title === plSel.value)) return false;
        if (chSel.value && r.channel !== chSel.value) return false;
        if (skipSel.value === 'yes' && !g[r.id]) return false;
        if (skipSel.value === 'no' && g[r.id]) return false;
        if (q) {
          const hay = normTitle([r.title, r.channel, plName(r), ...(r.to || []).map((x) => x.title), r.id].join(' '));
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      const by = {
        new: (a, b) => (b.t || 0) - (a.t || 0),
        old: (a, b) => (a.t || 0) - (b.t || 0),
        title: (a, b) => (a.title || a.id).localeCompare(b.title || b.id),
        channel: (a, b) => (a.channel || '~').localeCompare(b.channel || '~') || (b.t || 0) - (a.t || 0),
        playlist: (a, b) => plName(a).localeCompare(plName(b)) || (b.t || 0) - (a.t || 0),
      }[sortSel.value];
      return out.sort(by);
    }

    const fmtWhen = (t) => {
      if (!t) return '—';
      const d = new Date(t);
      return d.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' });
    };

    function rowEl(r, g) {
      const cb = el('input', { type: 'checkbox' });
      boxes.set(r, cb);
      const badge = r.restored ? ['↩ Restored', 'ycfp-bdg-restored']
        : r.kind === 'moved' ? ['→ Moved', 'ycfp-bdg-moved']
          : r.src === 'dedupe' ? ['⧉ Duplicate', 'ycfp-bdg-dupe']
            : ['✕ Removed', 'ycfp-bdg-removed'];
      const where = r.kind === 'moved' && r.to && r.to.length
        ? `${plName(r) || '?'} → ${r.to.map((x) => x.title || x.id).join(', ')}`
        : r.keptIn && r.keptIn.length ? `${plName(r)} (kept in ${r.keptIn.join(', ')})` : plName(r);
      const undo = el('button', {
        class: 'ycfp-btn ycfp-secondary',
        title: r.playlistId ? (r.kind === 'moved' ? `Move it back to "${plName(r)}" (at the end) and out of ${(r.to || []).map((x) => x.title || x.id).join(', ') || 'where it went'}` : `Put it back in "${plName(r)}" (at the end)`) : 'The playlist it left is not known',
      }, '↩');
      if (!r.playlistId || r.restored) undo.disabled = true;
      undo.addEventListener('click', async () => {
        if (undo.disabled) return;
        undo.disabled = true;
        undo.textContent = '…';
        try {
          await restoreRows([r]);
          undo.textContent = '✓';
        } catch (err) {
          undo.textContent = '✗';
          undo.title = `Failed: ${err.message || err}`;
          undo.disabled = false;
        }
      });
      const skipped = !!g[r.id];
      return el('div', { class: 'ycfp-entry' + (r.restored ? ' ycfp-entry-gone' : '') },
        cb,
        el('span', { class: 'ycfp-entry-when', title: r.t ? new Date(r.t).toLocaleString() : 'date unknown' }, fmtWhen(r.t)),
        el('span', {
          class: `ycfp-bdg ${badge[1]}`,
          title: `${REVIEW_SRC[r.src] || r.src || ''}${r.unverified ? ' · not yet checked for a move' : ''}`
            + `${r.reclassified ? ' · corrected from "removed"' : ''}`,
        }, badge[0] + (r.unverified ? ' ?' : '')),
        el('span', { class: 'ycfp-entry-dur' }, fmtDur(r.seconds)),
        el('a', {
          class: 'ycfp-entry-title', href: `${ORIGIN}/watch?v=${r.id}`, target: '_blank', rel: 'noreferrer',
          title: `${r.title || r.id}${skipped ? ' · skipped by collects' : ''}`,
        }, (skipped ? '⛔ ' : '') + (r.title || r.id)),
        el('span', { class: 'ycfp-entry-ch', title: r.channel || '' }, r.channel || ''),
        el('span', { class: 'ycfp-entry-pl', title: where }, where),
        undo);
    }

    function render(keepPage = false) {
      if (!keepPage) shown = REVIEW_PAGE;
      matches = filtered();
      const g = loadGone();
      listEl.textContent = '';
      boxes.clear();
      for (const r of matches.slice(0, shown)) listEl.append(rowEl(r, g));
      const nRem = matches.filter((r) => r.kind === 'removed' && !r.restored).length;
      const nMov = matches.filter((r) => r.kind === 'moved').length;
      summary.textContent = `${matches.length} of ${rows.length} shown — ${nRem} removed, ${nMov} moved`
        + `${matches.length > shown ? ` (listing the first ${shown})` : ''}. ⛔ = skipped by collects.`;
      moreBtn.style.display = matches.length > shown ? '' : 'none';
      moreBtn.textContent = `Show ${Math.min(REVIEW_PAGE, matches.length - shown)} more`;
    }
    moreBtn.addEventListener('click', () => { shown += REVIEW_PAGE; render(true); });

    let qTimer = 0;
    qIn.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => render(), 150); });
    for (const s of [kindSel, srcSel, plSel, chSel, skipSel, sortSel, fromIn, toIn]) {
      s.addEventListener('change', () => render());
    }
    whenSel.addEventListener('change', () => {
      dateRow.style.display = whenSel.value === 'custom' ? '' : 'none';
      render();
    });
    resetBtn.addEventListener('click', () => {
      qIn.value = '';
      for (const s of [kindSel, srcSel, whenSel, plSel, chSel, skipSel, sortSel]) s.selectedIndex = 0;
      fromIn.value = ''; toIn.value = '';
      dateRow.style.display = 'none';
      render();
    });

    // ---- bulk actions (checked rows) ----
    const checkedRows = () => [...boxes].filter(([, cb]) => cb.checked).map(([r]) => r);
    const allBtn = el('button', { class: 'ycfp-mini-btn' }, 'Check all listed');
    allBtn.addEventListener('click', () => {
      const on = allBtn.textContent === 'Check all listed';
      for (const cb of boxes.values()) cb.checked = on;
      allBtn.textContent = on ? 'Uncheck all' : 'Check all listed';
    });

    async function restoreRows(list) {
      const byPl = new Map();
      for (const r of list) {
        if (!r.playlistId || r.restored) continue;
        (byPl.get(r.playlistId) || byPl.set(r.playlistId, []).get(r.playlistId)).push(r);
      }
      const done = [];
      try {
        for (const [pid, rs] of byPl) {
          for (const r of rs) {
            ui.guard();
            await addOneToPlaylist(pid, r.id);
            await setMembership(r.id, pid, true);
            // Undoing a move: take it back out of where it went.
            if (r.kind === 'moved') {
              for (const t of r.to || []) {
                if (!t.id || t.id === pid) continue;
                await removeFromPlaylist(t.id, r.id);
                await setMembership(r.id, t.id, false);
              }
            }
            r.restored = true;
            done.push(r);
            await sleep(cfg.batchDelayMs);
          }
        }
      } finally {
        // Whatever made it back is recorded, even if the rest failed.
        forgetDeleted(done.map((r) => r.id));
        await evPut(done.filter((r) => r.k !== null && r.k !== undefined));
      }
      return done.length;
    }

    const restoreBtn = el('button', { class: 'ycfp-btn' }, '↩ Put checked back');
    restoreBtn.addEventListener('click', async () => {
      const pick = checkedRows();
      if (!pick.length) { ui.log('Nothing checked.'); return; }
      restoreBtn.disabled = true;
      try {
        const n = await restoreRows(pick);
        ui.log(`↩ Put ${n} video(s) back in the playlists they left (at the end).`);
      } catch (e) { ui.log(`❌ ${e.message || e}`); }
      restoreBtn.disabled = false;
      render(true);
    });

    const allowBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Allow re-collecting');
    allowBtn.title = 'Take the checked videos off the deleted-video ledger — collects may add them again';
    allowBtn.addEventListener('click', () => {
      const pick = checkedRows();
      if (!pick.length) { ui.log('Nothing checked.'); return; }
      const n = forgetDeleted(pick.map((r) => r.id));
      ui.log(`${n} video(s) can be collected again.`);
      render(true);
    });

    const blockBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Keep skipping');
    blockBtn.title = 'Put the checked videos (back) on the deleted-video ledger — collects skip them';
    blockBtn.addEventListener('click', () => {
      const pick = checkedRows();
      if (!pick.length) { ui.log('Nothing checked.'); return; }
      const g = loadGone();
      for (const r of pick) {
        if (!g[r.id]) g[r.id] = { t: r.title || '', s: r.seconds || 0, c: r.channel || '', p: plName(r), pid: r.playlistId || '', ts: Date.now() };
      }
      saveGone(g);
      ui.log(`${pick.length} video(s) will be skipped by collects.`);
      render(true);
    });

    // Ask YouTube where each one is now — one "Save to playlist" lookup per
    // video, so it knows every playlist of yours, read or not.
    const checkBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, '🔎 Check for moves');
    checkBtn.title = 'Ask YouTube whether the checked "removed" videos (or, with nothing checked, all listed ones) '
      + 'are in another of your playlists — up to 300 per click';
    checkBtn.addEventListener('click', async () => {
      if (checkBtn.disabled) return;
      let pick = checkedRows();
      if (!pick.length) pick = matches;
      pick = pick.filter((r) => r.kind === 'removed' && !r.restored).slice(0, 300);
      if (!pick.length) { ui.log('No removed videos among those to check.'); return; }
      checkBtn.disabled = true;
      const changed = [];
      let nMoved = 0, nBack = 0, nFail = 0, i = 0;
      try {
        for (const r of pick) {
          ui.guard();
          ui.log(`Checking ${++i}/${pick.length}… (${nMoved} moved so far)`, true);
          const mem = await fetchMembership(r.id);
          if (!mem.ok) { nFail++; continue; }
          if (r.playlistId && mem.map.get(r.playlistId) === true) {
            r.restored = true; nBack++;
          } else {
            const where = [...mem.map].filter(([p, inIt]) => inIt && p !== r.playlistId)
              .map(([p]) => ({ id: p, title: playlistTitleOf(p) }));
            if (where.length) {
              r.kind = 'moved'; r.to = where; r.reclassified = true; nMoved++;
            }
          }
          delete r.unverified;
          changed.push(r);
          await sleep(120);
        }
      } catch (e) {
        ui.log(`Stopped: ${e.message || e}`);
      }
      forgetDeleted(changed.filter((r) => r.kind === 'moved' || r.restored).map((r) => r.id));
      await evPut(changed.filter((r) => r.k !== null && r.k !== undefined));
      ui.log(`🔎 Checked ${changed.length}: ${nMoved} were moved (no longer skipped by collects), `
        + `${nBack} are back where they were, ${changed.length - nMoved - nBack} really are gone from your playlists`
        + `${nFail ? `; ${nFail} lookup(s) failed — try again later` : ''}.`);
      checkBtn.disabled = false;
      render(true);
    });

    // Everything the filters match (not just the rows on screen) as a txt —
    // pick "Removed" above for the list of videos you deleted.
    const exportBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, '💾 Save listed as txt');
    exportBtn.title = 'Save every row the current filters match (not only the ones shown) to a text file in Downloads';
    exportBtn.addEventListener('click', () => {
      if (!matches.length) { ui.log('Nothing matches the filters.'); return; }
      const what = (r) => (r.restored ? 'Restored' : r.kind === 'moved' ? 'Moved'
        : r.src === 'dedupe' ? 'Duplicate removed' : 'Removed');
      const cell = (s) => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ');
      const lines = [
        `# ${kindSel.options[kindSel.selectedIndex].text} — ${matches.length} video(s) from 📜 history, saved ${new Date().toLocaleString()}`,
        '# date\twhat\tlink\ttitle\tchannel\tlength\tplaylist\tmoved to\thow',
        ...matches.map((r) => [
          r.t ? new Date(r.t).toLocaleString() : 'unknown',
          what(r),
          `${ORIGIN}/watch?v=${r.id}`,
          r.title || '(name never recorded)',
          r.channel || '',
          r.seconds ? fmtDur(r.seconds) : '',
          plName(r),
          (r.to || []).map((x) => x.title || x.id).join(', '),
          REVIEW_SRC[r.src] || r.src || '',
        ].map(cell).join('\t')),
      ];
      const tag = kindSel.value === 'all' ? 'removed-and-moved' : kindSel.value;
      downloadTxt(`youtube-history-${tag}_${fileStamp()}.txt`, lines, ui.log, `${matches.length} video(s)`);
    });

    const delBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Delete from history');
    delBtn.title = 'Remove the checked rows from this list (the ledger — what collects skip — is not touched)';
    delBtn.addEventListener('click', async () => {
      const pick = checkedRows();
      if (!pick.length) { ui.log('Nothing checked.'); return; }
      await evDelete(pick.map((r) => r.k).filter((k) => k !== null && k !== undefined));
      const drop = new Set(pick);
      rows = rows.filter((r) => !drop.has(r));
      ui.log(`Deleted ${pick.length} row(s) from the history.`);
      render(true);
    });

    ui.body.append(
      el('div', { class: 'ycfp-review-filters' },
        qIn,
        el('div', { class: 'ycfp-row ycfp-review-row' }, kindSel, srcSel, whenSel, dateRow),
        el('div', { class: 'ycfp-row ycfp-review-row' }, plSel, chSel),
        el('div', { class: 'ycfp-row ycfp-review-row' }, skipSel, sortSel, resetBtn, allBtn)),
      summary,
      listEl,
      moreBtn,
      el('div', { class: 'ycfp-row' }, restoreBtn, allowBtn, blockBtn, checkBtn, delBtn, exportBtn));
    render();
  }

  // Save text to the browser's Downloads folder (a userscript can't write
  // anywhere else). Tab-separated lines open cleanly in Notepad and Excel;
  // the BOM keeps non-English titles readable in both. If the download is
  // blocked, the text goes to the console so it's never lost.
  function downloadTxt(name, lines, log, what = 'the list') {
    try {
      const url = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/plain;charset=utf-8' }));
      const a = el('a', { href: url, download: name, style: 'display:none' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      log(`💾 Saved ${what} to your Downloads folder as ${name}.`);
    } catch (err) {
      console.warn('[YCFP] Could not save', name, err, '\n' + lines.join('\n'));
      log(`⚠ Could not save the txt (${err.message || err}) — it was written to the browser console (F12).`);
    }
  }

  const fileStamp = (d = new Date()) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  };

  // Every clean-out of unavailable videos is written to a text file first-
  // class: the browser's Downloads folder (a userscript can't write anywhere
  // else), one tab-separated line per entry, so the links survive after the
  // entries are gone from your playlists. Opens straight in Excel.
  function saveUnavailableList(entries, heading, log, prefix = 'youtube-unavailable-removed') {
    if (!entries.length) return;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const cols = ['link', 'title', 'channel', 'playlist', 'status', 'removed from playlist', 'added to'];
    const lines = [
      `# ${heading} — ${d.toLocaleString()}`,
      `# ${cols.join('\t')}`,
      ...entries.map((e) => [
        `${ORIGIN}/watch?v=${e.id}`,
        e.title && !DEAD_TITLE_RE.test(String(e.title).trim()) ? e.title : '(name never recorded)',
        e.channel || '',
        e.playlistTitle || e.playlistId || '',
        e.kind || 'unavailable',
        e.outcome || '',
        e.addedTo || '',
      ].map((s) => String(s).replace(/[\t\r\n]+/g, ' ')).join('\t')),
    ];
    downloadTxt(`${prefix}_${stamp}.txt`, lines, log, `${entries.length} link(s)`);
  }


  // "N unavailable videos are hidden" — the banner YouTube puts on a playlist
  // that has any. Only used to report what's going on; the text is localized,
  // so the digit is taken from any alert that mentions unavailable/hidden.
  function hiddenUnavailableCount(resp) {
    for (const key of ['alertWithButtonRenderer', 'alertRenderer']) {
      for (const a of deepCollect(resp, key)) {
        const t = textOf(a && a.text);
        if (/unavailable|hidden/i.test(t)) { const m = t.match(/\d[\d,.]*/); return m ? parseInt(m[0].replace(/[,.]/g, ''), 10) : -1; }
      }
    }
    return 0;
  }

  // One playlist read that includes the hidden unavailable videos. The
  // normal read runs first (it feeds the archive and the 🪦 death report);
  // the second, "show unavailable" read is quiet — it must not become the
  // archive's "before", or the next ordinary read would book every hidden
  // video as removed by you.
  //
  // The second read is ALWAYS made. YouTube doesn't reliably say it is hiding
  // anything: on a 4998-entry playlist it hid 169 entries with neither the
  // "Unavailable videos are hidden" banner nor the "Show unavailable videos"
  // menu item in the response — and the request works regardless. The
  // playlist's own switch value is used when offered, yt-dlp's otherwise
  // (they were identical wherever the switch was present).
  const SHOW_UNAVAILABLE_PARAMS = 'wgYCCAA%3D';
  async function readWithUnavailable(p, log, guard, quietFirst = false) {
    const first = await fetchPlaylistVideos(p.id, p.title, log, guard, { keepDupes: true, quiet: quietFirst });
    const hidden = first.hiddenCount || 0;
    const tries = [...new Set([first.unavailParams, SHOW_UNAVAILABLE_PARAMS].filter(Boolean))];
    let vids = first;
    for (const params of tries) {
      try {
        const full = await fetchPlaylistVideos(p.id, `${p.title} (incl. hidden)`, log, guard,
          { keepDupes: true, params, quiet: true });
        // A read with the switch on can only show MORE; one that shows fewer
        // didn't work (or the playlist changed mid-read) — try the next.
        if (full.length >= first.length) {
          full.editable = full.editable === undefined ? first.editable : full.editable;
          vids = full;
          break;
        }
      } catch (err) { guard(); /* try the next way, or keep the normal read */ }
    }
    vids.hiddenCount = hidden;
    vids.shownHidden = vids !== first;
    if (!vids.shownHidden) {
      log(`⚠ ${p.title}: could not read it with unavailable videos shown — only the ones YouTube marks as `
        + 'deleted/private can be found in this run.');
    }
    // What only the "show unavailable" read has IS what YouTube hides as
    // unavailable. Those rows look perfectly normal in the data (playable,
    // titled, timed — typically blocked in your country), so this difference
    // is the only reliable signal. Counted per entry handle, or per video id
    // when there are no handles, so duplicates are matched copy for copy.
    vids.hiddenEntries = new Set();
    if (vids.shownHidden && !first.partial && !vids.partial) {
      const left = new Map();
      for (const v of first) {
        const k = v.setVideoId || 'V' + v.id;
        left.set(k, (left.get(k) || 0) + (v.setVideoId ? 1 : (v.copies || 1)));
      }
      for (const v of vids) {
        const k = v.setVideoId || 'V' + v.id;
        const n = left.get(k) || 0;
        if (n > 0) left.set(k, n - (v.setVideoId ? 1 : (v.copies || 1)));
        else vids.hiddenEntries.add(v);
      }
    }
    return vids;
  }

  // Take every unavailable entry (deleted, private, blocked in your country —
  // including the ones YouTube hides behind "Show unavailable videos") out of
  // the chosen playlists. Optionally also collects them into one playlist
  // first — YouTube accepts that for blocked videos but usually refuses for
  // deleted/private ones, so the removal never depends on it. Every run saves
  // a txt of the links, and every step is checked by reading back.
  async function runUnavailableFlow() {
    if (running) return;
    running = true;
    const cfg = loadCfg();
    const ui = openDialog('Remove unavailable videos', true);
    try {
      ui.log('Loading your playlists…');
      const pls = await getOwnPlaylists(ui.log);
      ui.guard();
      if (!pls.length) { ui.log('❌ Could not load your playlists.'); return; }

      const remembered = new Set(cfg.unavailSelection || []);
      const boxes = pls.map((p) => ({ p, cb: el('input', { type: 'checkbox', checked: remembered.has(p.id) }) }));
      const collectCb = el('input', { type: 'checkbox', checked: cfg.unavailCollect !== false });
      const nameIn = el('input', { type: 'text', value: cfg.unavailTarget || 'Unavailable videos' });
      const scanBtn = el('button', { class: 'ycfp-btn' }, 'Find unavailable videos');
      const allBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Select all');
      allBtn.addEventListener('click', () => {
        const on = boxes.some((b) => !b.cb.checked);
        boxes.forEach((b) => { b.cb.checked = on; });
      });
      const pickerEl = el('div', {},
        el('label', {}, 'Playlists to take unavailable videos out of:'),
        el('div', { class: 'ycfp-pl-list' },
          ...boxes.map(({ p, cb }) => el('label', { class: 'ycfp-check' }, cb, el('span', {}, p.title)))),
        el('label', { class: 'ycfp-check' }, collectCb,
          el('span', {}, 'Also try to add them to this playlist first (reused if it exists, created private if not — '
            + 'YouTube usually refuses deleted/private videos; they are removed either way):')),
        nameIn,
        el('div', { class: 'ycfp-row' }, scanBtn, allBtn, defaultSelBtn(boxes)));
      ui.body.append(pickerEl);
      await new Promise((res) => {
        scanBtn.addEventListener('click', res, { once: true });
        ui.dlg.addEventListener('close', res);
      });
      ui.guard();
      const collect = collectCb.checked;
      const targetTitle = nameIn.value.trim() || 'Unavailable videos';
      const existing = collect ? pls.find((p) => p.title === targetTitle) : null;
      const selected = boxes.filter((b) => b.cb.checked && (!existing || b.p.id !== existing.id)).map((b) => b.p);
      if (!selected.length) { ui.log('No playlists selected.'); return; }
      const stored = loadCfg();
      stored.unavailSelection = selected.map((p) => p.id);
      stored.unavailTarget = targetTitle;
      stored.unavailCollect = collect;
      saveCfg(stored);
      pickerEl.remove();

      // --- read ---
      const found = [];   // entries to remove, with playlistId/playlistTitle
      const allRead = []; // everything read, for executeRemovals' "kept"
      const plById = new Map(selected.map((p) => [p.id, p]));
      for (const p of selected) {
        ui.guard();
        const vids = await readWithUnavailable(p, ui.log, ui.guard);
        let editable = vids.editable;
        if (editable === undefined) editable = await isPlaylistEditable(p.id, vids[0] && vids[0].id);
        if (!editable) { ui.log(`⚠ "${p.title}" is not yours to edit — skipped.`); continue; }
        const arch = await archiveGet(p.id).catch(() => null);
        const named = new Map();
        if (arch && Array.isArray(arch.v)) for (const r of arch.v) if (r[1]) named.set(r[0], r);
        let n = 0;
        for (const v of vids) {
          const e = Object.assign({}, v, { playlistId: p.id, playlistTitle: p.title });
          allRead.push(e);
          const kind = deadKind(v) || (vids.hiddenEntries.has(v) ? 'hidden by YouTube' : null);
          if (!kind) continue;
          const old = named.get(v.id);
          e.kind = kind;
          if (old && !DEAD_TITLE_RE.test(String(old[1]).trim())) {
            e.title = old[1]; e.seconds = e.seconds || old[2] || 0; e.channel = e.channel || old[3] || '';
          }
          found.push(e);
          n++;
        }
        ui.log(`${p.title}: ${vids.length} entries, ${n} unavailable`
          + (vids.shownHidden ? ` — ${vids.hiddenEntries.size} of them hidden by YouTube (shown only with "Show unavailable videos")` : '') + '.');
      }
      if (!found.length) { ui.log('✅ No unavailable videos in those playlists.'); return; }

      // --- review ---
      const rows = [];
      const listEl = el('div', { class: 'ycfp-results' });
      let lastPl = null;
      for (const e of found) {
        if (e.playlistId !== lastPl) {
          lastPl = e.playlistId;
          listEl.append(el('div', { class: 'ycfp-group-head' }, e.playlistTitle));
        }
        const cb = el('input', { type: 'checkbox', checked: true, title: 'Remove this entry' });
        const stat = el('span', { class: 'ycfp-entry-pl' }, e.kind);
        const rowEl = el('div', { class: 'ycfp-entry' },
          cb,
          el('span', { class: 'ycfp-entry-dur' }, e.seconds ? fmtDur(e.seconds) : '—'),
          el('a', {
            class: 'ycfp-entry-title', href: `${ORIGIN}/watch?v=${e.id}`, target: '_blank', rel: 'noreferrer',
            title: e.title || e.id,
          }, DEAD_TITLE_RE.test(String(e.title || '').trim()) || !e.title ? `${e.id} — name never recorded` : e.title),
          el('span', { class: 'ycfp-entry-ch' }, e.channel || ''),
          stat);
        rows.push({ e, cb, rowEl, stat });
        listEl.append(rowEl);
      }
      let targetId = existing ? existing.id : null;
      let preHave = new Set(); // already in the target before this run — Undo leaves those
      let lastRemoved = null, lastRows = null, lastAdded = null;

      const undoBtn = el('button', { class: 'ycfp-btn ycfp-secondary', style: 'display:none' }, '↩ Undo last removal');
      undoBtn.addEventListener('click', async () => {
        if (undoBtn.disabled || !lastRemoved) return;
        undoBtn.disabled = true;
        try {
          const n = await undoRemovals(lastRemoved, cfg, ui.log, ui.guard);
          for (const id of lastAdded || []) {
            if (preHave.has(id)) continue;
            await removeFromPlaylist(targetId, id);
            await sleep(cfg.batchDelayMs);
          }
          for (const r of lastRows) {
            r.rowEl.classList.remove('ycfp-entry-gone'); r.cb.disabled = false; r.stat.textContent = r.e.kind;
          }
          ui.log(`↩ Re-added ${n} entries to where they were (YouTube may refuse deleted ones)`
            + `${lastAdded && lastAdded.size ? ` and took them out of "${targetTitle}"` : ''}.`);
          lastRemoved = null; lastRows = null; lastAdded = null;
          undoBtn.style.display = 'none';
        } catch (err) {
          ui.log(`❌ ${err.message || err}`);
        } finally {
          undoBtn.disabled = false;
        }
      });

      // Add ids to the target; returns the ids that are really in it
      // afterwards — read back, not taken from the reply, because YouTube can
      // answer SUCCEEDED for a video it silently didn't add.
      async function addToTarget(ids) {
        let have = new Set();
        if (targetId) {
          const t = await fetchPlaylistVideos(targetId, targetTitle, ui.log, ui.guard, { quiet: true, keepDupes: true });
          have = new Set(t.map((v) => v.id));
        }
        preHave = have;
        const want = ids.filter((id) => !have.has(id));
        for (let i = 0; i < want.length && !targetId; i++) {
          // Create with one video: one YouTube refuses would sink a batch create.
          try {
            const data = await api('playlist/create', { title: targetTitle, videoIds: [want[i]], privacyStatus: 'PRIVATE' });
            targetId = data.playlistId || deepFind(data, 'playlistId') || null;
            if (targetId) ui.log(`Created "${targetTitle}".`);
          } catch (err) { /* this one was refused — try the next */ }
        }
        if (!targetId) {
          ui.log(`⚠ YouTube would not create "${targetTitle}" with any of these videos — they are only removed.`);
          return new Set();
        }
        for (let i = 0; i < want.length; i += cfg.batchSize) {
          ui.guard();
          const chunk = want.slice(i, i + cfg.batchSize);
          const res = await api('browse/edit_playlist', {
            playlistId: targetId,
            actions: chunk.map((id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id })),
          }).catch((err) => ({ status: String(err.message || err) }));
          if (res.status && res.status !== 'STATUS_SUCCEEDED') {
            for (const id of chunk) { // one bad id sinks a batch — one at a time
              try { await addOneToPlaylist(targetId, id); } catch (err) { /* refused */ }
              await sleep(cfg.batchDelayMs);
            }
          }
          ui.log(`Adding to "${targetTitle}": ${Math.min(i + chunk.length, want.length)}/${want.length}…`, true);
          await sleep(cfg.batchDelayMs);
        }
        const after = await fetchPlaylistVideos(targetId, targetTitle, ui.log, ui.guard, { quiet: true, keepDupes: true });
        archivePatch(targetId, targetTitle, after.map((v) => v.id), []);
        invalidateExclCache();
        const inNow = new Set(after.map((v) => v.id));
        return new Set(ids.filter((id) => inNow.has(id)));
      }

      const goBtn = el('button', { class: 'ycfp-btn' }, 'Remove checked (and save their links)');
      goBtn.addEventListener('click', async () => {
        if (goBtn.disabled) return;
        const pick = rows.filter((r) => r.cb.checked && !r.cb.disabled);
        if (!pick.length) { ui.log('Nothing checked.'); return; }
        goBtn.disabled = true;
        for (const r of pick) { r.e.outcome = 'not attempted (stopped early)'; r.e.addedTo = ''; }
        const report = pick.map((r) => r.e);
        let inTarget = new Set();
        try {
          // 1. Best effort: collect them into the target playlist.
          if (collect) {
            ui.log(`Trying to add ${pick.length} to "${targetTitle}"…`);
            inTarget = await addToTarget([...new Set(pick.map((r) => r.e.id))]);
            for (const r of pick) {
              r.e.addedTo = inTarget.has(r.e.id) ? targetTitle : 'refused by YouTube';
            }
            ui.log(`"${targetTitle}" took ${inTarget.size} of ${new Set(pick.map((r) => r.e.id)).size}; `
              + 'removing all of them from their playlists now.');
          }

          // 2. Remove every checked entry. Collected ones are journalled as
          // moves (so 📜 history's ↩ also takes them out of the target),
          // the rest as dead-video removals.
          const pickSet = new Set(pick.map((r) => r.e));
          const kept = allRead.filter((e) => !pickSet.has(e));
          const asMove = pick.filter((r) => inTarget.has(r.e.id)).map((r) => r.e);
          const asDead = pick.filter((r) => !inTarget.has(r.e.id)).map((r) => r.e);
          const removed = [];
          const failed = new Set();
          if (asMove.length) {
            const res = await executeRemovals(asMove, kept, cfg, ui.log, ui.guard, 'unavail', { id: targetId, title: targetTitle });
            for (const e of res.failed) failed.add(e);
            removed.push(...res.removedCopies);
          }
          if (asDead.length) {
            const res = await executeRemovals(asDead, kept, cfg, ui.log, ui.guard, 'dead');
            for (const e of res.failed) failed.add(e);
            removed.push(...res.removedCopies);
          }

          // 3. Read the playlists back: "removed" means it's really gone.
          ui.log('Checking the playlists…');
          const stillThere = new Set();
          for (const pid of new Set(pick.map((r) => r.e.playlistId))) {
            ui.guard();
            try {
              const now = await readWithUnavailable(plById.get(pid), ui.log, ui.guard, true);
              for (const v of now) stillThere.add(`${pid}|${v.id}`);
            } catch (err) { ui.log(`⚠ Could not re-read ${plById.get(pid).title} to check (${err.message || err}).`); }
          }
          const done = [];
          for (const r of pick) {
            const still = stillThere.has(`${r.e.playlistId}|${r.e.id}`);
            r.e.outcome = failed.has(r.e) ? 'FAILED — still in playlist'
              : still ? 'NOT removed — still in playlist (YouTube accepted the request but kept it)' : 'removed';
            r.stat.textContent = still || failed.has(r.e) ? '⚠ still there' : '✓ removed';
            if (!still && !failed.has(r.e)) {
              done.push(r);
              r.rowEl.classList.add('ycfp-entry-gone'); r.cb.checked = false; r.cb.disabled = true;
            }
          }
          if (done.length) {
            await deathsDrop(done.map((r) => `${r.e.playlistId}|${r.e.id}`)).catch(() => {});
            await refreshDeadCount();
          }
          lastRemoved = removed; lastRows = done; lastAdded = inTarget;
          undoBtn.style.display = removed.length ? '' : 'none';
          const nStill = pick.length - done.length;
          ui.log(`✅ Removed ${done.length} of ${pick.length}`
            + (collect ? `; ${inTarget.size} are also kept in "${targetTitle}"` : '')
            + (nStill ? `. ⚠ ${nStill} are still in their playlist — marked "still there" above and in the txt` : '')
            + '. 📜 history can undo this.');
        } catch (err) {
          ui.log(`❌ ${err.message || err}`);
        } finally {
          // Always — whether it finished, failed or was stopped halfway.
          saveUnavailableList(report, `Unavailable videos removed from: ${[...new Set(report.map((e) => e.playlistTitle))].join(', ')}`, ui.log);
          goBtn.disabled = false;
        }
      });

      const checkAll = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Uncheck all');
      checkAll.addEventListener('click', () => {
        const on = rows.some((r) => !r.cb.disabled && !r.cb.checked);
        for (const r of rows) if (!r.cb.disabled) r.cb.checked = on;
        checkAll.textContent = on ? 'Uncheck all' : 'Check all';
      });

      ui.body.append(
        el('label', {}, `${found.length} unavailable entr${found.length === 1 ? 'y' : 'ies'} found`
          + ' — titles come from the playlist archive where it knew them. A txt of the links is saved every time you remove.'),
        listEl,
        el('div', { class: 'ycfp-row' }, goBtn, checkAll, undoBtn));
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  // ------------------------------------------------------------------
  // 📺 Binge → Watch later
  //
  // Every video bookmarked under Binge Videos (all subfolders) goes into
  // Watch later, and each batch's bookmarks are removed as soon as that
  // batch has been added. Dead links — and the dead entries already sitting
  // in Watch later — get a replacement search, and you pick one per row (or
  // none) before anything happens to them. A dead bookmark with no
  // replacement is moved to Binge Videos/Deleted; a dead Watch later entry
  // with none is bookmarked there, under the name the archive kept, and
  // then taken out of Watch later.
  // ------------------------------------------------------------------
  const BINGE_PATH = 'Bookmarks Bar/See asap/Binge Videos';
  const BINGE_DELETED = 'Deleted';

  // Video id of a watch / youtu.be / shorts / live link, or ''.
  function videoIdOfUrl(url) {
    try {
      const u = new URL(url);
      if (/(^|\.)youtu\.be$/i.test(u.hostname)) return (u.pathname.slice(1).match(/^[\w-]{11}/) || [''])[0];
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  // "(3) Some title - YouTube" → "Some title".
  const bookmarkVideoTitle = (t) => String(t || '')
    .replace(/^\(\d+\)\s*/, '').replace(/\s*[-–]\s*YouTube\s*$/i, '').trim();

  // Is the video still watchable? oEmbed answers 200 for public and unlisted
  // videos at no innertube cost; a refusal is confirmed with the player,
  // because oEmbed also refuses live videos whose owner turned embedding
  // off. Only "deleted" (ERROR) and "private" (LOGIN_REQUIRED) count as
  // dead, and any network trouble counts as alive — a hiccup must never
  // file a working link away as dead.
  async function videoAlive(id) {
    try {
      const r = await fetch(`/oembed?format=json&url=${encodeURIComponent(`${ORIGIN}/watch?v=${id}`)}`,
        { credentials: 'omit' });
      if (r.ok || ![401, 403, 404].includes(r.status)) return true;
    } catch (e) { return true; }
    try {
      const p = await api('player', { videoId: id });
      const st = p && p.playabilityStatus && p.playabilityStatus.status;
      return !(st === 'ERROR' || st === 'LOGIN_REQUIRED');
    } catch (e) { return true; }
  }

  // Up to four search results for `title`, closest title first. `score` is
  // the share of words the two titles have in common (0–1).
  async function searchReplacements(title, excludeId) {
    const words = (s) => normTitle(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const want = new Set(words(title));
    const data = await api('search', { query: title });
    const out = [];
    for (const v of deepCollect(data, 'videoRenderer')) {
      if (!v.videoId || v.videoId === excludeId || out.some((o) => o.id === v.videoId)) continue;
      const t = textOf(v.title);
      const w = words(t);
      const hit = w.filter((x) => want.has(x)).length;
      out.push({
        id: v.videoId, title: t,
        channel: textOf(v.ownerText || v.longBylineText),
        seconds: parseDurationText(textOf(v.lengthText)),
        score: want.size ? hit / Math.max(want.size, w.length) : 0,
      });
      if (out.length >= 8) break;
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 4);
  }

  async function runBingeToWatchLaterFlow() {
    if (running) return;
    running = true;
    const cfg = loadCfg();
    const ui = openDialog('Binge Videos → Watch later', true);
    try {
      const version = await bmxPing();
      if (!verAtLeast(version, '1.3.0')) {
        throw new Error(`The YCFP Bookmarks Mover extension is v${version}; this needs v1.3.0+. `
          + 'Reload it in brave://extensions (Developer mode → the extension card → ⟳), then reload this YouTube tab.');
      }
      const pathIn = el('input', { type: 'text', value: BINGE_PATH });
      const startBtn = el('button', { class: 'ycfp-btn' }, 'Start');
      ui.body.append(el('div', {},
        el('label', {}, `Bookmarks folder — every subfolder is included, except "${BINGE_DELETED}":`),
        pathIn,
        el('label', {}, 'Every working video bookmarked there is added to Watch later, and its bookmark is removed '
          + 'batch by batch. Dead links — and dead entries already in Watch later — are searched for a '
          + 'replacement, and you choose for each before anything happens to them.'),
        el('div', { class: 'ycfp-row' }, startBtn)));
      await new Promise((res) => {
        startBtn.addEventListener('click', res, { once: true });
        ui.dlg.addEventListener('close', res, { once: true });
      });
      ui.guard();
      startBtn.disabled = true;
      const root = pathIn.value.trim() || BINGE_PATH;
      const deletedPath = `${root}/${BINGE_DELETED}`;

      // 1. The bookmarks (the Deleted folder itself is never re-read).
      const { items } = await bmxListTree(root, true);
      const marks = [];
      let other = 0;
      for (const b of items) {
        if (normTitle(b.folder.split('/')[0]) === normTitle(BINGE_DELETED)) continue;
        const vid = videoIdOfUrl(b.url);
        if (vid) marks.push(Object.assign({ vid }, b)); else other++;
      }
      ui.log(`${marks.length} video bookmark(s) under "${root}"`
        + `${other ? ` (${other} other YouTube link(s) left alone)` : ''}.`);

      // 2. Watch later as it is now. A full read also refreshes the archive,
      // which is where the dead entries' old names come from.
      const wl = await fetchPlaylistVideos('WL', 'Watch later', ui.log, ui.guard);
      const inWl = new Set(wl.map((v) => v.id));
      const arch = await archiveGet('WL');
      const names = new Map(((arch && arch.v) || []).map((r) => [r[0], r]));
      const wlDead = wl.filter((v) => deadKind(v)).map((v) => {
        const r = names.get(v.id) || [];
        return {
          id: v.id, setVideoId: v.setVideoId || null, copies: v.copies || 1,
          title: r[1] || '', seconds: r[2] || 0, channel: r[3] || '',
          playlistId: 'WL', playlistTitle: 'Watch later',
        };
      });
      const wlDeadIds = new Set(wlDead.map((e) => e.id));

      // 3. Which links still work (six at a time, folder order kept).
      const live = new Set();
      let checked = 0;
      const queue = marks.slice();
      await Promise.all([0, 1, 2, 3, 4, 5].map(async () => {
        while (queue.length) {
          ui.guard();
          const m = queue.shift();
          if ((inWl.has(m.vid) && !wlDeadIds.has(m.vid)) || await videoAlive(m.vid)) live.add(m);
          if (++checked % 10 === 0) ui.log(`Checking links… ${checked}/${marks.length}`, true);
        }
      }));
      const alive = marks.filter((m) => live.has(m));
      const dead = marks.filter((m) => !live.has(m));
      ui.log(`${alive.length} link(s) work, ${dead.length} are dead.`);

      // 4. Add to Watch later, then drop those bookmarks — one batch at a time.
      let added = 0, unmarked = 0;
      for (let i = 0; i < alive.length; i += cfg.batchSize) {
        ui.guard();
        const chunk = alive.slice(i, i + cfg.batchSize);
        const toAdd = [...new Set(chunk.map((m) => m.vid))].filter((id) => !inWl.has(id));
        if (toAdd.length) {
          await addToPlaylist('WL', toAdd, cfg, () => {}, ui.guard);
          toAdd.forEach((id) => inWl.add(id));
          added += toAdd.length;
        }
        const { removed, failed } = await bmxRemoveBookmarks(chunk.map((m) => m.id));
        unmarked += removed.length;
        if (failed.length) ui.log(`⚠ ${failed.length} bookmark(s) could not be removed: ${failed.map((f) => f.error).join('; ')}`);
        ui.log(`Watch later +${added} · bookmarks removed ${unmarked}/${alive.length}…`, true);
      }
      if (alive.length) {
        ui.log(`✅ Added ${added} video(s) to Watch later (the rest were already in it) and removed ${unmarked} bookmark(s).`);
      }

      // 5. Replacements for the dead ones.
      const rows = [
        ...dead.map((m) => ({ kind: 'bookmark', m, id: m.vid, title: bookmarkVideoTitle(m.title), where: m.folder || root })),
        ...wlDead.map((e) => ({ kind: 'wl', e, id: e.id, title: e.title, where: 'Watch later' })),
      ];
      if (!rows.length) { ui.log('No dead links — all done.'); return; }
      const listEl = el('div', { class: 'ycfp-results' });
      for (const [n, r] of rows.entries()) {
        ui.guard();
        ui.log(`Searching for replacements… ${n + 1}/${rows.length}`, true);
        r.cands = r.title ? await searchReplacements(r.title, r.id).catch(() => []) : [];
        const name = `ycfp-bw-${n}`;
        const prePick = r.cands.length && r.cands[0].score >= 0.6;
        r.radios = r.cands.map((c, k) => ({ c, rb: el('input', { type: 'radio', name, checked: prePick && k === 0 }) }));
        const none = el('input', { type: 'radio', name, checked: !prePick });
        listEl.append(
          el('div', { class: 'ycfp-group-head' }, `${r.title || `${r.id} — name was never recorded`}  ·  ${r.where}`),
          ...r.radios.map(({ c, rb }) => el('label', { class: 'ycfp-check' }, rb,
            el('span', {}, `${c.seconds ? fmtDur(c.seconds) : '—'}  `),
            el('a', { href: `${ORIGIN}/watch?v=${c.id}`, target: '_blank', rel: 'noreferrer' }, c.title),
            el('span', {}, `  — ${c.channel}`))),
          el('label', { class: 'ycfp-check' }, none, el('span', {}, r.kind === 'wl'
            ? `No replacement — bookmark it in "${BINGE_DELETED}" and remove it from Watch later`
            : `No replacement — move the bookmark to "${BINGE_DELETED}"`)));
        await sleep(150);
      }
      ui.log(`Found replacement candidates for ${rows.filter((r) => r.cands.length).length} of ${rows.length} dead link(s).`);
      const applyBtn = el('button', { class: 'ycfp-btn' }, 'Apply');
      ui.body.append(
        el('label', {}, `${rows.length} dead link(s). Pick a replacement for each — a close title match is `
          + 'pre-picked — or "No replacement". Nothing changes until you press Apply.'),
        listEl,
        el('div', { class: 'ycfp-row' }, applyBtn));
      await new Promise((res) => {
        applyBtn.addEventListener('click', res, { once: true });
        ui.dlg.addEventListener('close', res, { once: true });
      });
      ui.guard();
      applyBtn.disabled = true;
      for (const r of rows) {
        const p = r.radios.find((x) => x.rb.checked);
        r.pick = p ? p.c : null;
      }

      const repl = [...new Set(rows.filter((r) => r.pick).map((r) => r.pick.id))].filter((id) => !inWl.has(id));
      if (repl.length) {
        await addToPlaylist('WL', repl, cfg, ui.log, ui.guard);
        repl.forEach((id) => inWl.add(id));
      }
      ui.log(`Added ${repl.length} replacement(s) to Watch later.`);

      let deletedReady = false;
      const ensureDeleted = async () => {
        if (!deletedReady) { await bmxEnsureFolder(root, BINGE_DELETED); deletedReady = true; }
      };

      // Dead bookmarks: replaced → removed; not → filed in Deleted.
      const bmRows = rows.filter((r) => r.kind === 'bookmark');
      const replacedMarks = bmRows.filter((r) => r.pick).map((r) => r.m.id);
      const lostMarks = bmRows.filter((r) => !r.pick).map((r) => r.m.id);
      if (replacedMarks.length) {
        const { removed } = await bmxRemoveBookmarks(replacedMarks);
        ui.log(`Removed ${removed.length} replaced dead bookmark(s).`);
      }
      if (lostMarks.length) {
        await ensureDeleted();
        const { moved, failed } = await bmxMoveBookmarks(lostMarks, deletedPath);
        ui.log(`Moved ${moved.length} dead bookmark(s) to "${deletedPath}"${failed.length ? `, ${failed.length} failed` : ''}.`);
      }

      // Dead Watch later entries: replaced → removed; not → bookmarked in
      // Deleted first, and removed only once that bookmark exists.
      const wlRows = rows.filter((r) => r.kind === 'wl');
      const toRemove = wlRows.filter((r) => r.pick).map((r) => r.e);
      const noAlt = wlRows.filter((r) => !r.pick);
      if (noAlt.length) {
        await ensureDeleted();
        const { created } = await bmxAddBookmarks(noAlt.map((r) => ({
          title: `${r.title || r.id} - YouTube`, url: `${ORIGIN}/watch?v=${r.id}`,
        })), deletedPath);
        const ok = new Set(created.map((c) => c.i));
        noAlt.forEach((r, i) => { if (ok.has(i)) toRemove.push(r.e); });
        ui.log(`Bookmarked ${ok.size} dead Watch later entr${ok.size === 1 ? 'y' : 'ies'} in "${deletedPath}"`
          + `${ok.size < noAlt.length ? ` — ${noAlt.length - ok.size} could not be bookmarked and stay in Watch later` : ''}.`);
      }
      if (toRemove.length) {
        const { failed } = await executeRemovals(toRemove, [], cfg, ui.log, null, 'dead');
        const gone = toRemove.filter((e) => !(failed && failed.has(e)));
        await deathsDrop(gone.map((e) => `WL|${e.id}`)).catch(() => {});
        await refreshDeadCount();
      }
      ui.log('✅ All done.');
    } catch (e) {
      ui.log(`❌ ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  // Dead videos: entries YouTube has taken down (or whose owner made them
  // private) that are still sitting in your playlists as "[Deleted video]"
  // rows. Found by every full read of a playlist, named from the archive,
  // and removable from here — the removal goes through the normal journal,
  // so 📜 Removal history can undo it (the video is gone either way, but
  // the row comes back if you would rather keep the gap visible).
  async function openDeadVideos() {
    if (running) return; // never replace a running flow's dialog
    const cfg = loadCfg();
    const ui = openDialog('Videos YouTube deleted or made private', true);
    let rows = ((await deathsAll()) || []).filter((r) => deadTracked(r.pid, cfg));
    // Re-check each one with the player: entries a glitchy playlist read
    // mislabelled (they still play) are dropped from the list for good.
    if (rows.length) {
      ui.log(`Checking ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} with YouTube's player…`, true);
      const alive = await aliveAmong(rows.map((r) => r.id));
      if (alive.size) {
        const drop = rows.filter((r) => alive.has(r.id));
        await deathsDrop(drop.map((r) => r.key));
        await refreshDeadCount();
        rows = rows.filter((r) => !alive.has(r.id));
        ui.log(`${drop.length} of them still play — taken off the dead list (they were never dead).`);
      }
    }
    if (!rows.length) {
      await refreshDeadCount();
      ui.log('Nothing pending. Every full read of one of your own playlists — a dedupe scan, a batch '
        + 'pull, a collect that checks an exclusion playlist — is compared against the playlist archive, '
        + 'and anything that has turned into "[Deleted video]" or "[Private video]" since the last read '
        + 'is listed here with the title and channel it had while it still existed.');
      return;
    }
    // Newest death first, but keeping each playlist's entries together.
    rows.sort((a, b) => (a.playlistTitle || '').localeCompare(b.playlistTitle || '')
      || (b.firstSeen || 0) - (a.firstSeen || 0));

    const listEl = el('div', { class: 'ycfp-results' });
    const boxes = [];
    let lastPl = null;
    for (const r of rows) {
      if (r.playlistTitle !== lastPl) {
        lastPl = r.playlistTitle;
        listEl.append(el('div', { class: 'ycfp-group-head' }, lastPl || r.pid));
      }
      const cb = el('input', {
        type: 'checkbox',
        title: 'Check to remove this dead entry from the playlist',
      });
      const b = { r, cb, done: false };
      boxes.push(b);
      const rowEl = el('div', { class: 'ycfp-entry' },
        cb,
        el('span', { class: 'ycfp-entry-dur', title: `${r.kind} on YouTube` },
          r.seconds ? fmtDur(r.seconds) : '—'),
        el('a', {
          class: 'ycfp-entry-title',
          href: `${ORIGIN}/watch?v=${r.id}`,
          target: '_blank',
          rel: 'noreferrer',
          title: `${r.title || r.id} · ${r.kind} · first seen gone ${new Date(r.firstSeen || 0).toLocaleString()}`,
        }, r.title || `${r.id} — name was never recorded`),
        el('span', { class: 'ycfp-entry-ch' }, r.channel || ''),
        el('span', { class: 'ycfp-entry-pl', title: r.pid }, r.kind));
      b.rowEl = rowEl;
      listEl.append(rowEl);
    }

    const allBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Check all');
    allBtn.addEventListener('click', () => {
      const on = boxes.some((b) => !b.done && !b.cb.checked);
      for (const b of boxes) if (!b.done) b.cb.checked = on;
      allBtn.textContent = on ? 'Uncheck all' : 'Check all';
    });

    const rmBtn = el('button', { class: 'ycfp-btn' }, 'Remove checked from their playlists');
    rmBtn.addEventListener('click', async () => {
      if (rmBtn.disabled) return;
      const pick = boxes.filter((b) => b.cb.checked && !b.done);
      if (!pick.length) { ui.log('Nothing checked.'); return; }
      rmBtn.disabled = true;
      const label = rmBtn.textContent;
      rmBtn.textContent = 'Removing…';
      // One entry object per checked row, kept alongside its row: the
      // failure set executeRemovals hands back holds these objects, not ids.
      const entries = pick.map((b) => ({
        id: b.r.id,
        setVideoId: b.r.setVideoId || null,
        copies: b.r.copies || 1,
        title: b.r.title || b.r.id,
        seconds: b.r.seconds || 0,
        channel: b.r.channel || '',
        playlistId: b.r.pid,
        playlistTitle: b.r.playlistTitle || b.r.pid,
        kind: b.r.kind,
      }));
      try {
        // kept = [] — nothing survives, so no copy is ever re-added.
        for (const e of entries) e.outcome = 'not attempted (stopped early)';
        const { failed } = await executeRemovals(entries, [], cfg, ui.log, null, 'dead');
        const okKeys = [];
        pick.forEach((b, i) => {
          entries[i].outcome = failed && failed.has(entries[i]) ? 'FAILED — still in playlist' : 'removed';
          if (failed && failed.has(entries[i])) return;
          b.done = true;
          b.cb.checked = false;
          b.cb.disabled = true;
          b.rowEl.classList.add('ycfp-entry-gone');
          okKeys.push(b.r.key);
        });
        if (okKeys.length) await deathsDrop(okKeys);
        await refreshDeadCount();
        ui.log(`Removed ${okKeys.length} dead entr${okKeys.length === 1 ? 'y' : 'ies'}`
          + `${okKeys.length < pick.length ? `, ${pick.length - okKeys.length} could not be removed` : ''}. `
          + '📜 Removal history can undo this.');
      } catch (e) {
        ui.log(`❌ ${e.message || e}`);
      } finally {
        saveUnavailableList(entries, 'Dead videos removed (🪦)', ui.log);
        rmBtn.textContent = label;
        rmBtn.disabled = false;
      }
    });

    const dismissBtn = el('button', {
      class: 'ycfp-btn ycfp-secondary',
      title: 'Stop listing these — they stay in the playlist, and are only reported again if they are re-found as newly dead',
    }, 'Dismiss checked');
    dismissBtn.addEventListener('click', async () => {
      const pick = boxes.filter((b) => b.cb.checked && !b.done);
      if (!pick.length) { ui.log('Nothing checked.'); return; }
      await deathsDrop(pick.map((b) => b.r.key));
      await refreshDeadCount();
      for (const b of pick) {
        b.done = true;
        b.cb.checked = false;
        b.cb.disabled = true;
        b.rowEl.classList.add('ycfp-entry-gone');
      }
      ui.log(`Dismissed ${pick.length} — they stay in their playlists.`);
    });

    const clearBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, 'Dismiss all');
    clearBtn.addEventListener('click', async () => {
      await deathsClear();
      await refreshDeadCount();
      ui.dlg.close();
    });

    const filterIn = el('input', { type: 'text', placeholder: 'Filter by title / channel / playlist…' });
    filterIn.addEventListener('input', () => {
      const q = normTitle(filterIn.value);
      for (const b of boxes) {
        b.rowEl.classList.toggle('ycfp-row-hidden', !!q && !normTitle(b.rowEl.textContent).includes(q));
      }
    });

    const named = rows.filter((r) => r.title).length;
    ui.body.append(
      el('label', {}, `${rows.length} entr${rows.length === 1 ? 'y is' : 'ies are'} dead on YouTube but still `
        + `in your playlists — ${named} recovered from the archive with the title and channel they had `
        + 'while they existed'
        + (named < rows.length
          ? `, ${rows.length - named} without (already gone the first time that playlist was archived)`
          : '')
        + '. Check the ones to strip out and press Remove; Dismiss leaves them where they are.'),
      filterIn,
      listEl,
      el('div', { class: 'ycfp-row' }, allBtn, rmBtn, dismissBtn, clearBtn));
  }

  async function openSettings() {
    if (running) return; // never replace a running flow's dialog
    const cfg = loadCfg();
    const ui = openDialog('Collector settings');
    // Exclusions as a checkbox list of your playlists (populated async below)
    const exclList = el('div', { class: 'ycfp-pl-list' },
      el('div', {}, 'Loading your playlists…'));
    let exclBoxes = null; // stays null if loading fails → keep stored value
    const topic = el('input', { type: 'checkbox', checked: cfg.includeTopicChannel });
    const dedupe = el('input', { type: 'checkbox', checked: cfg.dedupeByTitleDuration });
    const shorts = el('input', { type: 'checkbox', checked: cfg.excludeShorts });
    const live = el('input', { type: 'checkbox', checked: cfg.excludeLive });
    const upcoming = el('input', { type: 'checkbox', checked: cfg.excludeUpcoming });
    const skipDel = el('input', { type: 'checkbox', checked: cfg.skipDeleted });
    const ledgerBtn = el('button', { class: 'ycfp-btn ycfp-secondary' },
      `📜 Removed videos (${goneCount()} skipped by collects)`);
    ledgerBtn.addEventListener('click', () => { ui.dlg.close(); openDeletedLedger(); });
    // Deaths YouTube caused, as opposed to the ledger above, which is
    // deletions you caused. Count comes from the cached total first so the
    // button has a label immediately, then is corrected from the database.
    const deadBtn = el('button', { class: 'ycfp-btn ycfp-secondary' },
      `🪦 Videos YouTube deleted (${deadPending})`);
    deadBtn.addEventListener('click', () => { ui.dlg.close(); openDeadVideos(); });
    // 🧹 dedupe "not duplicates" links, from a file. One line per set: "idA idB"
    // unlinks that pair (every pair, for more ids); "a b | c d | e" keeps each
    // side together and unlinks across the "|"s. Merged in; nothing removed.
    const unlinkIn = el('input', { type: 'file', accept: '.txt,.json,text/plain,application/json', style: 'display:none' });
    const unlinkBtn = el('button', { class: 'ycfp-btn ycfp-secondary' },
      `📥 Import dedupe unlinks (${loadUnlinkedPairs().size} saved)`);
    unlinkBtn.title = 'Load a file of video-id pairs that 🧹 dedupe should never group together';
    unlinkBtn.addEventListener('click', () => unlinkIn.click());
    unlinkIn.addEventListener('change', async () => {
      const f = unlinkIn.files && unlinkIn.files[0];
      if (!f) return;
      const text = await f.text();
      const pairs = loadUnlinkedPairs();
      const before = pairs.size;
      let lines = 0;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim();
        if (!line) continue;
        // "a b | c d" = two different songs: unlink every a/b against every
        // c/d, but leave a↔b (and c↔d) linked. Without "|", every pair goes.
        const sides = line.split('|').map((s) => [...new Set(s.match(/[\w-]{11}/g) || [])]).filter((s) => s.length);
        const groups = sides.length > 1 ? sides : sides[0] && sides[0].length > 1 ? sides[0].map((id) => [id]) : [];
        if (groups.length < 2) continue;
        lines++;
        for (let x = 0; x < groups.length; x++) {
          for (let y = x + 1; y < groups.length; y++) {
            for (const a of groups[x]) for (const b of groups[y]) if (a !== b) pairs.add(pairKey(a, b));
          }
        }
      }
      saveUnlinkedPairs(pairs);
      unlinkIn.value = '';
      unlinkBtn.textContent = `📥 Import dedupe unlinks (${pairs.size} saved)`;
      ui.log(`📥 Read ${lines} line(s): ${pairs.size - before} new unlinked pair(s), ${pairs.size} in total. `
        + 'A saved 🧹 scan still shows its old groups — start a new scan to see them split.');
    });
    refreshDeadCount().then((n) => { deadBtn.textContent = `🪦 Videos YouTube deleted (${n})`; });
    const fuzzyC = el('input', { type: 'checkbox', checked: cfg.fuzzyCollect });
    const homeNty = el('input', { type: 'checkbox', checked: cfg.homeNewToYou });
    const marks = el('input', { type: 'checkbox', checked: cfg.feedMarks });
    const markVars = el('input', { type: 'checkbox', checked: cfg.feedMarkVariants });
    const marksBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, '✓ Read all my playlists now');
    const marksLabel = () => archIndex().then((idx) => {
      marksBtn.textContent = `✓ Read all my playlists now (${idx.byVid.size} videos from ${idx.byPid.size} playlist(s) known)`;
    });
    marksLabel();
    marksBtn.addEventListener('click', async () => {
      if (marksBtn.disabled) return;
      marksBtn.disabled = true;
      marksBtn.textContent = 'Reading your playlists… (close this dialog to stop)';
      try { await readAllOwnPlaylists(ui); } catch (e) { ui.log(`❌ ${e.message || e}`); }
      marksLabel();
      marksBtn.disabled = false;
    });
    const dropW = el('textarea', {
      value: cfg.fuzzyDropWords || '',
      placeholder: 'free type beat\nprod\nvisualizer',
    });
    const durTolIn = el('input', {
      type: 'number', min: '0', max: '120',
      value: String(cfg.fuzzyDurationTolerance),
    });
    const target = el('input', { type: 'text', value: cfg.defaultTargetPlaylist, placeholder: 'Empty = ask every time' });
    const qa = el('textarea', {
      value: cfg.quickActions
        .map((a) => `${a.label} | ${a.target}${a.name ? ` | ${a.name}` : ''}`)
        .join('\n'),
      placeholder: 'S | PLxxxxxxxx | Secondary\nR | PLyyyyyyyy | Relax\n1 | PLzzzzzzzz | Songs',
    });
    const storageBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, '');
    const storageLabel = () => `🧹 Clear cached data (${fmtBytes(lsUsage())} in the browser's ~10 MB store`
      + `${kvDb ? `, ${fmtBytes(kvUsage())} in the disk store` : ''})`;
    storageBtn.textContent = storageLabel();
    storageBtn.addEventListener('click', () => {
      let freed = 0;
      for (const [key] of LS_CACHES) freed += lsDropCache(key);
      storageBtn.textContent = storageLabel();
      ui.log(freed
        ? `Freed ${fmtBytes(freed)}. Your settings, exclusions, quick actions and the deleted-video ledger are untouched.`
        : 'Nothing cached to clear.');
    });

    // The playlist archive lives in IndexedDB, not in the 5 MB localStorage
    // quota above, so it is reported and cleared separately — and behind a
    // two-step confirm, because it is the only place the titles of videos
    // YouTube has already deleted still exist.
    const archiveBtn = el('button', { class: 'ycfp-btn ycfp-secondary' }, '🗄 Playlist archive — reading…');
    let archArmed = false;
    const archLabel = (s) => (s
      ? `🗄 Erase the playlist archive (${s.playlists} playlist(s), ${s.videos} videos, ${fmtBytes(s.bytes)})`
      : '🗄 Playlist archive unavailable — IndexedDB is off in this browser profile');
    const archRefresh = () => archiveStats().then((s) => { archiveBtn.textContent = archLabel(s); });
    archRefresh();
    archiveBtn.addEventListener('click', async () => {
      if (!archArmed) {
        archArmed = true;
        archiveBtn.textContent = '⚠ Click again to erase it';
        ui.log('Erasing the archive throws away every title it recorded — a video that dies afterwards can '
          + 'never be named again, and the pending dead-video list goes with it. Your playlists are untouched.');
        setTimeout(() => { if (archArmed) { archArmed = false; archRefresh(); } }, 6000);
        return;
      }
      archArmed = false;
      await archiveClear();
      await deathsClear();
      await refreshDeadCount();
      archRefresh();
      ui.log('Archive erased. It rebuilds from the next full read of each playlist — but only with what '
        + 'is still readable then.');
    });

    const save = el('button', { class: 'ycfp-btn' }, 'Save');
    save.addEventListener('click', () => {
      if (exclBoxes) {
        cfg.excludePlaylists = exclBoxes.filter((b) => b.cb.checked).map((b) => b.p.id);
        invalidateExclCache();
      }
      cfg.includeTopicChannel = topic.checked;
      cfg.dedupeByTitleDuration = dedupe.checked;
      cfg.excludeShorts = shorts.checked;
      cfg.excludeLive = live.checked;
      cfg.excludeUpcoming = upcoming.checked;
      cfg.skipDeleted = skipDel.checked;
      cfg.fuzzyCollect = fuzzyC.checked;
      cfg.homeNewToYou = homeNty.checked;
      cfg.feedMarks = marks.checked;
      cfg.feedMarkVariants = markVars.checked;
      cfg.fuzzyDropWords = dropW.value;
      {
        const v = parseInt(durTolIn.value, 10);
        cfg.fuzzyDurationTolerance = Math.max(0, Math.min(Number.isFinite(v) ? v : 15, 120));
      }
      cfg.defaultTargetPlaylist = parsePlaylistId(target.value) || '';
      cfg.quickActions = qa.value.split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => {
          const parts = l.split('|').map((s) => s.trim());
          return { label: parts[0] || '', target: parts[1] || '', name: parts[2] || '' };
        })
        .filter((a) => a.label && parsePlaylistId(a.target));
      saveCfg(cfg);
      refreshDeadCount(); // the 🪦 count follows the default playlists
      const stale = document.getElementById('ycfp-qa');
      if (stale) stale.remove(); // rebuild with the new buttons
      ui.dlg.close();
    });
    ui.body.append(
      el('label', {}, 'Excluded / default playlists — their videos are skipped when collecting; dead videos (🪦) are '
        + 'only tracked in these (none ticked = all of yours); "Select default" in the dedupe / unavailable / '
        + 'bookmark pickers ticks exactly these:'),
      exclList,
      el('div', { class: 'ycfp-check' }, topic, el('span', {}, 'Include "- Topic" channel releases')),
      el('div', { class: 'ycfp-check' }, dedupe, el('span', {}, 'Skip duplicates (same title + same duration)')),
      el('div', { class: 'ycfp-check' }, shorts, el('span', {}, 'Exclude Shorts when collecting / copying')),
      el('div', { class: 'ycfp-check' }, live, el('span', {}, 'Exclude live streams when collecting')),
      el('div', { class: 'ycfp-check' }, upcoming,
        el('span', {}, 'Exclude scheduled streams / premieres, and anything with no duration (unreleased, private, deleted)')),
      el('div', { class: 'ycfp-check' }, skipDel,
        el('span', {}, 'Never re-collect a video I removed from a playlist (deleted-video ledger)')),
      el('div', { class: 'ycfp-row' }, ledgerBtn, deadBtn, unlinkBtn, unlinkIn),
      el('div', { class: 'ycfp-check' }, fuzzyC, el('span', {}, 'Fuzzy matching when collecting (deduper logic: cleaned titles, within the duration tolerance below) for exclusions & duplicate skipping')),
      el('div', { class: 'ycfp-check' }, homeNty, el('span', {}, 'Home feed: auto-select the "New to you" chip')),
      el('div', { class: 'ycfp-check' }, marks,
        el('span', {}, 'On playlists that aren\'t mine (someone else\'s playlist, an album, a mix, a channel\'s uploads), '
          + 'mark songs I already have with a green ✓')),
      el('div', { class: 'ycfp-check' }, markVars,
        el('span', {}, 'Also mark other uploads of the same song with an amber ✓ (the ones a collect skips as duplicates)')),
      el('label', {}, 'The marks — and telling a moved song from a deleted one — use what the script knows of your '
        + 'playlists, which grows with every collect, pull and dedupe scan. Reading them all once fills in the rest:'),
      el('div', { class: 'ycfp-row' }, marksBtn),
      el('label', {}, 'Words to ignore when fuzzy-matching titles — separated by spaces and/or new lines (case-insensitive, whole words only):'),
      dropW,
      el('label', {}, 'Fuzzy matching: how many seconds two durations may differ (0 = must match exactly; higher = looser, more matches):'),
      durTolIn,
      el('label', {}, 'Default target playlist (ID or URL):'),
      target,
      el('label', {}, 'Quick "move to" buttons while watching a playlist — one per line, format: LABEL | playlist ID or URL | optional name:'),
      qa,
      el('label', {}, 'Storage — only the settings stay in the browser\'s small (~10 MB, shared with YouTube) store; '
        + 'the ledger, dedupe unlinks, saved scan and the new-songs / batch-pull state live in a disk-backed '
        + 'IndexedDB store with room for gigabytes. Clearing throws away only what can be read again: any saved '
        + 'dedupe scan, playlist snapshots and moved-video notes. '
        + '(The removal history lives in the playlist archive below.)'),
      el('div', { class: 'ycfp-row' }, storageBtn),
      el('label', {}, 'Playlist archive — what every one of your playlists held the last time the script '
        + 'read it, kept in IndexedDB (its own disk-backed store, so it costs the 5 MB quota above nothing). '
        + 'It is what lets a "[Deleted video]" row be reported by the name it used to have.'),
      el('div', { class: 'ycfp-row' }, archiveBtn),
      el('div', { class: 'ycfp-row' }, save));

    // Populate the exclusion checkboxes from the user's playlist library.
    try {
      const pls = await getOwnPlaylists(ui.log);
      const configured = cfg.excludePlaylists.map(parsePlaylistId).filter(Boolean);
      const known = new Set(pls.map((p) => p.id));
      const items = pls.slice();
      // Preserve configured exclusions that aren't in the library listing.
      for (const id of configured) {
        if (!known.has(id)) items.push({ id, title: `${id} (not in your library)` });
      }
      exclList.textContent = '';
      exclBoxes = items.map((p) => {
        const cb = el('input', { type: 'checkbox', checked: configured.includes(p.id) });
        exclList.append(el('label', { class: 'ycfp-check' }, cb, el('span', { title: p.id }, p.title)));
        return { p, cb };
      });
    } catch (e) {
      exclList.textContent = '⚠ Could not load your playlists — current exclusions are kept as they are.';
    }
  }

  // ------------------------------------------------------------------
  // ✓ marks — songs you already have, on playlists that aren't yours
  //
  // Open someone else's playlist, an album, a mix or a channel's uploads
  // list, and every song in it that you already own gets a mark:
  //   ✓  green  — this exact video is in one of your playlists;
  //   ✓  amber  — ANOTHER upload of the same song is (the main↔Topic pair a
  //               collect would skip as a duplicate).
  // Hovering says which playlist. Your own playlists are never marked —
  // everything in them is, by definition, something you have.
  //
  // Rebuilt in v3.37.0. The first version marked every feed, search page and
  // sidebar on the site, which is where it spent its effort, yet it almost
  // never showed: YouTube renamed the classes of its new "lockup" rows
  // (yt-lockup-metadata-view-model__title → ytLockupMetadataViewModelTitle),
  // so most rows no longer matched at all, and a doubled duration label in
  // the watch panel ("4:39 4:39") failed to parse. It also kept its own
  // index in localStorage — 1.3 MB of the 5 MB quota, rewritten after every
  // collect. Now:
  //   • it runs only on /playlist and /watch?list= pages for a list you
  //     don't own (one ownership check per list, cached), and does nothing
  //     anywhere else;
  //   • the index is the playlist archive (IndexedDB), which every full read
  //     of your playlists already maintains — no second copy, no quota;
  //   • each row is decided once (stamped), and the amber check computes
  //     title variants lazily, for nearby durations only, a batch per tick.
  // ------------------------------------------------------------------
  const HAVE_KEY = 'ycfp-have-index-v2';
  const HAVE_KEY_V1 = 'ycfp-have-index-v1';
  // The old localStorage index is dead weight now — hand its quota back.
  try { localStorage.removeItem(HAVE_KEY); localStorage.removeItem(HAVE_KEY_V1); } catch (e) { /* ignore */ }

  const MARK_ROWS_PER_TICK = 60;
  let markState = { list: null, foreign: null };
  let markBuckets = null;           // { ver, map: Map(seconds → [videoId]) }
  const markVarCache = new Map();   // videoId → titleVariants (regex-heavy, so cached)

  const markListId = () => {
    if (location.pathname !== '/playlist' && location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('list');
  };

  // Is this list one of yours? Yours if the archive holds a full read of it,
  // or YouTube says you can edit it. Albums, mixes and uploads lists never are.
  async function markIsForeign(listId) {
    if (/^(LL|WL|LM)$/.test(listId)) return false;
    const idx = await archIndex();
    if (idx.byPid.has(listId)) return false;
    return !(await isPlaylistEditable(listId));
  }

  function clearMarks() {
    document.querySelectorAll('.ycfp-mark').forEach((e) => e.remove());
    document.querySelectorAll('[data-ycfp-mark]').forEach((e) => e.removeAttribute('data-ycfp-mark'));
  }

  // One row's facts, from whichever of YouTube's three row layouts it is.
  function markRowInfo(row) {
    const a = row.querySelector('a[href*="v="]');
    const m = a && (a.getAttribute('href') || '').match(/[?&]v=([\w-]{11})/);
    if (!m) return null;
    let host, title, chEl;
    if (row.tagName === 'YT-LOCKUP-VIEW-MODEL') {
      host = row.querySelector('h3') || row.querySelector('.ytLockupMetadataViewModelTitle');
      title = host ? host.textContent : '';
      chEl = row.querySelector('.ytContentMetadataViewModelMetadataText');
    } else {
      host = row.querySelector('#video-title');
      title = host ? (host.getAttribute('title') || host.textContent) : '';
      chEl = row.querySelector('#byline, ytd-channel-name #text, #channel-name #text');
    }
    if (!host) return null;
    const durEl = row.querySelector('badge-shape, ytd-thumbnail-overlay-time-status-renderer #text, '
      + 'ytd-thumbnail-overlay-time-status-renderer');
    // The watch panel repeats the label ("4:39\n 4:39"): first token only.
    const seconds = parseDurationText(((durEl && durEl.textContent) || '').trim().split(/\s+/)[0]);
    return { id: m[1], host, title: (title || '').trim(), seconds, channel: ((chEl && chEl.textContent) || '').trim() };
  }

  const markWhere = (idx, pids) => [...pids].map((p) => idx.titles.get(p) || p).join(', ');

  function markVerdict(idx, info, cfg) {
    const exact = idx.byVid.get(info.id);
    if (exact && exact.size) return { kind: 'have', where: markWhere(idx, exact) };
    if (!cfg.feedMarkVariants || !(info.seconds > 0) || !info.title) return null;
    if (!markBuckets || markBuckets.ver !== idx.ver) {
      const map = new Map();
      for (const [id, meta] of idx.meta) {
        if (!(meta[1] > 0) || !idx.byVid.has(id)) continue;
        const arr = map.get(meta[1]);
        if (arr) arr.push(id); else map.set(meta[1], [id]);
      }
      markBuckets = { ver: idx.ver, map };
    }
    const vars = titleVariants(info.title, info.channel);
    const vmask = versionMask(info.title);
    const tol = getDurTol();
    for (let s = info.seconds - tol; s <= info.seconds + tol; s++) {
      for (const otherId of markBuckets.map.get(s) || []) {
        const meta = idx.meta.get(otherId);
        // An instrumental is not "the same song you already have".
        if (!meta || versionMask(meta[0]) !== vmask) continue;
        let ov = markVarCache.get(otherId);
        if (!ov) { ov = titleVariants(meta[0], meta[2]); markVarCache.set(otherId, ov); }
        if (similarScore(vars, ov) < FUZZY_CUTOFF) continue;
        const where = idx.byVid.get(otherId);
        if (where && where.size) return { kind: 'variant', where: markWhere(idx, where) };
      }
    }
    return null;
  }

  function ensureMarks() {
    const cfg = loadCfg();
    const listId = cfg.feedMarks ? markListId() : null;
    if (listId !== markState.list) {
      clearMarks();
      markState = { list: listId, foreign: null };
      if (listId) {
        const st = markState;
        markIsForeign(listId).then((f) => { st.foreign = f; }).catch(() => { st.foreign = false; });
      }
    }
    if (!listId || !markState.foreign) return;
    const idx = archIdx;
    if (!idx || !idx.byVid.size) return;

    const rows = location.pathname === '/watch'
      ? document.querySelectorAll('ytd-playlist-panel-renderer ytd-playlist-panel-video-renderer')
      : document.querySelectorAll('ytd-browse:not([hidden]) ytd-playlist-video-renderer, '
        + 'ytd-browse:not([hidden]) #primary yt-lockup-view-model');
    let work = 0;
    for (const row of rows) {
      // Rows are recycled as you scroll, so the stamp records WHICH video
      // this row showed and what was decided — and the archive version, so
      // a playlist read elsewhere re-checks the page.
      const a = row.querySelector('a[href*="v="]');
      const hm = a && (a.getAttribute('href') || '').match(/[?&]v=([\w-]{11})/);
      if (!hm) continue;
      const stamp = row.dataset.ycfpMark || '';
      const hasMark = !!row.querySelector('.ycfp-mark');
      if (stamp === `${hm[1]}:${idx.ver}:0` && !hasMark) continue;
      if (stamp.startsWith(`${hm[1]}:${idx.ver}:`) && hasMark) continue;
      if (++work > MARK_ROWS_PER_TICK) break; // the rest next tick
      row.querySelectorAll('.ycfp-mark').forEach((e) => e.remove());
      const info = markRowInfo(row);
      if (!info) continue;
      let verdict = null;
      try { verdict = markVerdict(idx, info, cfg); } catch (e) { verdict = null; }
      row.dataset.ycfpMark = `${info.id}:${idx.ver}:${verdict ? verdict.kind : '0'}`;
      if (!verdict) continue;
      info.host.prepend(el('span', {
        class: `ycfp-mark ycfp-mark-${verdict.kind}`,
        title: verdict.kind === 'have'
          ? `Already in your playlist${verdict.where.includes(',') ? 's' : ''}: ${verdict.where}`
          : `You already have another upload of this song — in ${verdict.where}. A collect would skip this one as a duplicate.`,
      }, '✓'));
    }
  }

  // Read every playlist of yours, so the archive (and with it the marks,
  // and the move-vs-delete check) knows your whole library, not just the
  // playlists some collect or dedupe happened to read. On demand only.
  async function readAllOwnPlaylists(ui) {
    const pls = await getOwnPlaylists(ui.log);
    let total = 0, n = 0;
    for (const p of pls) {
      ui.guard();
      n++;
      try {
        const vids = await fetchPlaylistVideos(p.id, `(${n}/${pls.length}) ${p.title}`, ui.log, ui.guard,
          { ownOnly: true });
        total += vids.length;
      } catch (e) {
        ui.guard();
        ui.log(`⚠ ${p.title} could not be read (${e.message || e}).`);
      }
    }
    await archIndex(0);
    ui.log(`✅ Read ${pls.length} playlist(s), ${total} videos — marks and move detection are up to date.`);
  }

  // ------------------------------------------------------------------
  // Keep a video paused that you paused while it was still loading.
  // YouTube's player calls play() again once loading finishes (especially
  // in a freshly opened tab), overriding your pause; and before it's ready
  // it may ignore your click / k / space altogether. Either way the pause
  // is remembered, and any play of the same video in the next 60s that
  // doesn't come from a NEW click or key press is undone. Limited to that
  // window so media keys etc. keep working later.
  // ------------------------------------------------------------------
  const currentVideoId = () => new URLSearchParams(location.search).get('v');
  const mainVideo = () => document.querySelector('#movie_player video.html5-main-video');
  let lastGesture = 0;
  let gestureOnSeekbar = false;
  let userPause = null; // { id, at, gesture }
  for (const t of ['pointerdown', 'keydown']) {
    window.addEventListener(t, (e) => {
      lastGesture = Date.now();
      // Scrubbing the progress bar pauses the video and plays it again on
      // release; that pause isn't yours, so it mustn't be kept.
      gestureOnSeekbar = t === 'pointerdown' && e.target instanceof Element
        && !!e.target.closest('#movie_player .ytp-progress-bar-container, #movie_player .ytp-progress-bar');
    }, true);
  }
  const fromGesture = () => Date.now() - lastGesture < 1000;
  const rememberPause = () => {
    userPause = { id: currentVideoId(), at: Date.now(), gesture: lastGesture };
  };
  document.addEventListener('pause', (e) => {
    if (!(e.target instanceof HTMLVideoElement) || !fromGesture()) return;
    if (gestureOnSeekbar || e.target.seeking) return;
    rememberPause();
  }, true);
  document.addEventListener('play', (e) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !userPause) return;
    if ((fromGesture() && lastGesture > userPause.gesture)
        || userPause.id !== currentVideoId()
        || Date.now() - userPause.at > 60000) { userPause = null; return; }
    v.pause();
  }, true);
  // A click on the video / play button, or k / space, that the still-loading
  // player didn't act on: pause it ourselves, or, if it hasn't started yet,
  // stop it from autoplaying once it does.
  function onToggleIntent() {
    if (location.pathname !== '/watch') return;
    const gesture = lastGesture;
    const before = mainVideo();
    const wasPlaying = !!before && !before.paused;
    setTimeout(() => {
      if (userPause && userPause.gesture === gesture) return; // player handled it
      const v = mainVideo();
      if (wasPlaying) {
        if (v && !v.paused) { rememberPause(); v.pause(); }
      } else if (!v || (v.paused && !v.played.length)) {
        rememberPause();
      }
    }, 300);
  }
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || !t.closest('#movie_player')) return;
    if (!t.closest('.ytp-play-button')
        && t.closest('.ytp-chrome-bottom, .ytp-chrome-top, .ytp-popup, .ytp-ad-module, .ytp-ce-element, .ytp-cards-teaser, .ytp-paid-content-overlay')) return;
    onToggleIntent();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || (e.key !== 'k' && e.key !== ' ')) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    onToggleIntent();
  }, true);

  // ------------------------------------------------------------------
  // Button injection (YTPA-style: chip bar + interval re-adding,
  // plus an always-visible floating fallback so it can never vanish)
  // ------------------------------------------------------------------
  const isChannelPage = () =>
    /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(location.pathname);
  const isPlaylistPage = () =>
    location.pathname === '/playlist' && new URLSearchParams(location.search).has('list');

  // Auto-select the "New to you" chip on the home feed. One attempt per
  // visit to home: once it's clicked (or found already selected), we stop,
  // so switching back to "All" by hand isn't fought. Handles both the
  // classic chip renderer and the new chip-shape view model.
  let homeChip = { done: false, tries: 0 };
  window.addEventListener('yt-navigate-finish', () => { homeChip = { done: false, tries: 0 }; });

  function ensureHomeChip() {
    if (homeChip.done || homeChip.tries > 20 || location.pathname !== '/') return;
    if (!loadCfg().homeNewToYou) { homeChip.done = true; return; }
    const browse = document.querySelector('ytd-browse:not([hidden])');
    if (!browse) { homeChip.tries++; return; }
    homeChip.tries++;
    // Selected-state check on the chip itself / its immediate wrapper ONLY.
    // Never on arbitrary ancestors: the chips sit inside
    // <iron-selector id="chips" selected="0">, whose own [selected]
    // attribute made every chip look already-selected (v3.13.0 bug).
    const isSel = (n) => !!n && n.nodeType === 1 && n.tagName !== 'IRON-SELECTOR'
      && (n.getAttribute('aria-selected') === 'true'
        || n.hasAttribute('selected')
        || /(^|\s)(iron-selected|ytChipShapeActive|chip-selected)(\s|$)/.test(n.className || ''));
    for (const c of browse.querySelectorAll(
      'yt-chip-cloud-chip-renderer, .ytChipShapeChip, chip-view-model')) {
      if (normTitle(c.textContent) !== 'new to you') continue;
      homeChip.done = true;
      if (isSel(c) || isSel(c.parentElement) || isSel(c.querySelector('button'))) return;
      // Click the innermost real target — YouTube's handler may sit on an
      // inner container rather than the custom element itself.
      const target = c.matches('button') ? c
        : (c.querySelector('button, #chip-container, yt-formatted-string') || c);
      target.click();
      console.info('[YCFP] Home feed: clicked the "New to you" chip.');
      return;
    }
    // Chip not rendered yet (or this account's feed has no "New to you") —
    // the 2s ensure interval retries until the attempt cap.
  }

  function ensureButtons() {
    if (!document.body || location.host === 'm.youtube.com') return;
    injectStyles();

    ensureBpReviewBar();  // Pull batch review tab overlay
    ensureQuickActions(); // watch-page playlist panel buttons
    ensureHomeChip();     // auto-select "New to you" on the home feed
    ensureMarks();        // ✓ on songs you already have (playlists that aren't yours)

    const chan = isChannelPage();
    const pl = isPlaylistPage();
    const watch = location.pathname === '/watch' && new URLSearchParams(location.search).has('list');
    const feed = location.pathname === '/feed/playlists';
    const home = location.pathname === '/';
    let float = document.getElementById('ycfp-float');

    if (!chan && !pl && !watch && !feed && !home) {
      if (float) float.remove();
      document.querySelectorAll('.ycfp-chip').forEach((e) => e.remove());
      return;
    }

    // Chip-bar buttons on channel content tabs (Videos / Shorts / Live)
    if (chan) {
      const bar = document.querySelector(
        'ytd-browse:not([hidden]) chip-bar-view-model.ytChipBarViewModelHost, ' +
        'ytd-browse:not([hidden]) ytd-feed-filter-chip-bar-renderer iron-selector#chips');
      if (bar && !bar.querySelector('.ycfp-chip')) {
        const chip = el('span', { class: 'ycfp-chip ycfp-chip-excl', role: 'button' }, '⊕ Collect All');
        chip.addEventListener('click', () => runChannelFlow(false));
        const chipNo = el('span', {
          class: 'ycfp-chip ycfp-chip-noexcl', role: 'button',
          title: 'Collect everything, ignoring the excluded playlists',
        }, '⊕ Collect All (no excl.)');
        chipNo.addEventListener('click', () => runChannelFlow(true));
        bar.append(chip, chipNo);
      }
    }

    // Floating buttons (guaranteed visible on channel, playlist, watch,
    // library & home pages)
    const mode = chan ? 'channel' : (pl ? 'playlist' : (watch ? 'watch' : (feed ? 'feed' : 'home')));
    if (float && float.dataset.mode !== mode) { float.remove(); float = null; }
    if (!float) {
      float = el('div', { id: 'ycfp-float' });
      float.dataset.mode = mode;
      if (chan) {
        const main = el('button', { class: 'ycfp-float-btn' }, '⊕ Collect channel → playlist');
        main.addEventListener('click', () => runChannelFlow(false));
        const noExcl = el('button', {
          class: 'ycfp-float-btn ycfp-float-alt',
          title: 'Collect everything, ignoring the excluded playlists',
        }, '⊕ Collect (ignore exclusions)');
        noExcl.addEventListener('click', () => runChannelFlow(true));
        float.append(main, noExcl);
      } else if (pl) {
        const main = el('button', { class: 'ycfp-float-btn' }, '⧉ Copy playlist → another');
        main.addEventListener('click', runPlaylistFlow);
        const shortsBtn = el('button', {
          class: 'ycfp-float-btn ycfp-float-shorts',
          title: 'Remove Shorts and videos under a minute from this playlist',
        }, '✂ Remove Shorts');
        shortsBtn.addEventListener('click', runRemoveShortsFlow);
        const chanBtn = el('button', {
          class: 'ycfp-float-btn ycfp-float-rmch',
          title: 'Remove every video by one channel from this playlist',
        }, '🚫 Remove a channel');
        chanBtn.addEventListener('click', runRemoveChannelFlow);
        const linksBtn = el('button', {
          class: 'ycfp-float-btn ycfp-float-links',
          title: 'Paste video links and add them to this playlist, or remove them from it',
        }, '🔗 Add / remove links');
        linksBtn.addEventListener('click', runLinksFlow);
        const bulkBtn = el('button', {
          class: 'ycfp-float-btn ycfp-float-bulk',
          title: 'Select several videos in this playlist (click rows, shift-click a range), then move, copy or remove them together',
        }, '☑ Select & move');
        bulkBtn.addEventListener('click', toggleBulkPage);
        float.append(bulkBtn, main, shortsBtn, chanBtn, linksBtn);
      }
      if (chan || pl || feed) {
        const multi = el('button', {
          class: 'ycfp-float-btn ycfp-float-multi',
          title: 'Collect the uploads of several channels at once into one playlist',
        }, '⊞ Collect multiple channels');
        multi.addEventListener('click', runMultiChannelFlow);
        float.append(multi);
      }
      // Everywhere: new-songs-from-bookmarks, the deduplicator and the gear.
      const newSongs = el('button', {
        class: 'ycfp-float-btn ycfp-float-ns',
        title: 'Collect videos uploaded since your last check by the channels in your bookmarks folder into a "New Songs <date>" playlist',
      }, '🆕 New songs');
      newSongs.addEventListener('click', runNewSongsFlow);
      float.append(newSongs);
      const batchPull = el('button', {
        class: 'ycfp-float-btn ycfp-float-bp',
        title: 'Pull the full catalog of the first N channels (alphabetically) from a bookmarks folder into one playlist, then move their bookmarks to a "done" folder',
      }, '📥 Pull batch');
      batchPull.addEventListener('click', runBatchPullFlow);
      float.append(batchPull);
      const bmDupe = el('button', {
        class: 'ycfp-float-btn ycfp-float-bd',
        title: 'Find bookmarks pointing at the same channel (@handle vs /channel/UC…) in a bookmarks folder and all its subfolders',
      }, '🔖 Bookmark dupes');
      bmDupe.addEventListener('click', runBookmarkDedupeFlow);
      float.append(bmDupe);
      const bmSort = el('button', {
        class: 'ycfp-float-btn ycfp-float-bd',
        title: 'Sort a bookmarks folder (and its subfolders) A–Z — folders first, nothing changes folder',
      }, '🔤 Sort bookmarks');
      bmSort.addEventListener('click', runBookmarkSortFlow);
      float.append(bmSort);
      const plBm = el('button', {
        class: 'ycfp-float-btn ycfp-float-pb',
        title: 'Bookmark every channel that has a video in the playlists you pick, unless it is already bookmarked (any link form) somewhere in a folder tree',
      }, '📌 Bookmark channels');
      plBm.addEventListener('click', runPlaylistBookmarkFlow);
      float.append(plBm);
      const binge = el('button', {
        class: 'ycfp-float-btn ycfp-float-binge',
        title: 'Add every video bookmarked under Binge Videos to Watch later (removing the bookmarks), and find replacements for dead links there and in Watch later',
      }, '📺 Binge → Watch later');
      binge.addEventListener('click', runBingeToWatchLaterFlow);
      float.append(binge);
      const libBtn = el('button', {
        class: 'ycfp-float-btn ycfp-float-lib',
        title: 'Music library: status, move songs rated on the website, import your playlists',
      }, '🗂 Library');
      libBtn.addEventListener('click', openLibraryDialog);
      float.append(libBtn);
      const dedupe = el('button', {
        class: 'ycfp-float-btn ycfp-float-dedupe',
        title: 'Find & remove duplicates across your playlists',
      }, '🧹 Dedupe');
      dedupe.addEventListener('click', runDedupeFlow);
      const hist = el('button', {
        class: 'ycfp-float-btn ycfp-gear',
        title: 'Removed & moved videos — review with filters, undo',
      }, '📜');
      hist.addEventListener('click', () => openHistory());
      const unav = el('button', {
        class: 'ycfp-float-btn ycfp-float-unav',
        title: 'Remove the unavailable videos (deleted, private, blocked) from the playlists you pick — saves a txt of their links, and can also collect them in an "Unavailable videos" playlist',
      }, '⊘ Unavailable');
      unav.addEventListener('click', runUnavailableFlow);
      float.append(unav);
      const gear = el('button', { class: 'ycfp-float-btn ycfp-gear', title: 'Collector settings' }, '⚙');
      gear.addEventListener('click', openSettings);
      float.append(dedupe, hist, gear);

      // Collapse toggle: shrink the whole stack to one ☰ button.
      const collapsed = loadCfg().floatCollapsed;
      if (collapsed) float.classList.add('ycfp-collapsed');
      const collapseBtn = el('button', {
        class: 'ycfp-float-btn ycfp-collapse',
        title: 'Show / hide the collector buttons',
      }, collapsed ? '☰' : '−');
      collapseBtn.addEventListener('click', () => {
        const stored = loadCfg();
        stored.floatCollapsed = !stored.floatCollapsed;
        saveCfg(stored);
        float.classList.toggle('ycfp-collapsed', stored.floatCollapsed);
        collapseBtn.textContent = stored.floatCollapsed ? '☰' : '−';
      });
      float.append(collapseBtn);
      document.body.append(float);
    }

    // Dead-video alert. Outside the build-once block above so it can appear
    // on a tab that was already open when a scan somewhere found one, and
    // disappear again the moment the list is cleared.
    const deadBtn = float.querySelector('.ycfp-float-dead');
    if (!deadPending) {
      if (deadBtn) deadBtn.remove();
    } else if (deadBtn) {
      deadBtn.textContent = `🪦 ${deadPending} dead`;
    } else {
      const b = el('button', {
        class: 'ycfp-float-btn ycfp-float-dead',
        title: 'Videos YouTube deleted or made private that are still sitting in your playlists — review, and remove the ones you want gone',
      }, `🪦 ${deadPending} dead`);
      b.addEventListener('click', openDeadVideos);
      const collapse = float.querySelector('.ycfp-collapse');
      if (collapse) float.insertBefore(b, collapse); else float.append(b);
    }
  }

  // Nothing starts until the disk store is loaded (a fraction of a second):
  // every button, timer and listener below reads the ledger, the unlinks or
  // the saved scan, and must never see them empty and write that back.
  kvInit().catch((e) => console.warn('[YCFP] storage init failed', e)).then(() => {
    window.addEventListener('yt-navigate-start', () => {
      document.querySelectorAll('.ycfp-chip').forEach((e) => e.remove());
      watchPanelAutoScroll();
    });
    watchPanelAutoScroll();
    window.addEventListener('yt-navigate-finish', () => setTimeout(ensureButtons, 300));
    // YouTube keeps erasing DOM changes and doesn't always fire navigation
    // events, so re-check on an interval (cheap: early returns).
    setInterval(ensureButtons, 2000);
    ensureButtons();
    // Detect channels newly added to the bookmarks folder soon after any
    // YouTube page opens (throttled inside; needs ytcfg, hence the delay).
    setTimeout(nsAutoScan, 6000);
    // Move songs rated on the Music Library website into their playlists.
    setTimeout(libAutoSync, 20000);
    setInterval(libAutoSync, 10 * 60 * 1000);
    // Surface anything an earlier scan found dead — the floating button reads
    // this count, and it is the only thing that makes the button appear.
    refreshDeadCount();
  });
})();

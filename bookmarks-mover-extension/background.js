// Service worker: the only extension context with chrome.bookmarks access.
// content.js relays requests from the youtube.com page here and posts the
// response back. Protocol tag: msg.ycfpBmx.

const VERSION = '1.4.0';

const normTitle = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// Path like "Bookmarks Bar/Music/Youtube/Done" -> folder node, or null.
// The first segment may match any root (Bookmarks Bar / Other / Mobile) or
// any folder at any depth; from there every remaining segment must descend
// directly into a child folder — mirrors the matching used by the
// companion file-reading bridge so both scripts agree on the same paths.
function findBookmarkFolder(rootChildren, pathStr) {
  const segs = (pathStr || '').split('/').map(normTitle).filter(Boolean);
  if (!segs.length) return null;
  const descend = (folder, i) => {
    if (i >= segs.length) return folder;
    for (const c of folder.children || []) {
      if (c.url) continue; // only folders
      if (normTitle(c.title) === segs[i]) {
        const r = descend(c, i + 1);
        if (r) return r;
      }
    }
    return null;
  };
  const queue = [...rootChildren];
  while (queue.length) {
    const f = queue.shift();
    if (normTitle(f.title) === segs[0]) {
      const r = descend(f, 1);
      if (r) return r;
    }
    for (const c of f.children || []) if (!c.url) queue.push(c);
  }
  return null;
}

const YT_URL_RE = /^https?:\/\/([^/]*\.)?(youtube\.com|youtu\.be)\//i;

// Every bookmark under `folder`, subfolders included. `folder` is the path
// of the containing folder RELATIVE to the scanned root ('' = a direct
// child of it), which is what the dedupe UI groups and bulk-selects by.
function walkFolder(node, relPath, out) {
  for (const c of node.children || []) {
    if (c.url) out.push({ id: c.id, title: c.title || '', url: c.url, folder: relPath });
    else walkFolder(c, relPath ? `${relPath}/${c.title || ''}` : (c.title || ''), out);
  }
}

// Full paths of every folder in the tree ("Bookmarks Bar/Music/Youtube"),
// so the page can offer a picker instead of asking for a typed path.
function collectFolderPaths(nodes, prefix, out) {
  for (const n of nodes) {
    if (n.url) continue;
    const path = prefix ? `${prefix}/${n.title || ''}` : (n.title || '');
    if (path.trim()) out.push(path);
    if (n.children) collectFolderPaths(n.children, path, out);
  }
}

async function handleMessage(msg) {
  if (msg.ycfpBmx === 'ping') return { ok: true, pong: true, version: VERSION };

  const tree = await chrome.bookmarks.getTree();
  const rootChildren = tree[0].children || [];

  if (msg.ycfpBmx === 'listFolders') {
    const paths = [];
    collectFolderPaths(rootChildren, '', paths);
    return { ok: true, paths };
  }

  if (msg.ycfpBmx === 'listFolder') {
    const folder = findBookmarkFolder(rootChildren, msg.path);
    if (!folder) return { ok: false, error: `Bookmarks folder "${msg.path}" not found.` };
    // Direct children only — subfolders (e.g. a "Final" folder inside this
    // one) are intentionally not descended into.
    const items = (folder.children || [])
      .filter((c) => c.url && YT_URL_RE.test(c.url))
      .map((c) => ({ id: c.id, title: c.title || '', url: c.url }));
    return { ok: true, items };
  }

  // Recursive counterpart of listFolder, used by the bookmark deduplicator:
  // the whole subtree, and (unless youtubeOnly) non-YouTube links too, since
  // a plain same-URL duplicate is worth reporting whatever it points at.
  if (msg.ycfpBmx === 'listTree') {
    const folder = findBookmarkFolder(rootChildren, msg.path);
    if (!folder) return { ok: false, error: `Bookmarks folder "${msg.path}" not found.` };
    const all = [];
    walkFolder(folder, '', all);
    const items = msg.youtubeOnly ? all.filter((b) => YT_URL_RE.test(b.url)) : all;
    return { ok: true, items, total: all.length };
  }

  if (msg.ycfpBmx === 'moveBookmarks') {
    const folder = findBookmarkFolder(rootChildren, msg.destPath);
    if (!folder) return { ok: false, error: `Destination folder "${msg.destPath}" not found.` };
    const moved = [];
    const failed = [];
    for (const id of msg.ids || []) {
      try {
        await chrome.bookmarks.move(id, { parentId: folder.id });
        moved.push(id);
      } catch (e) {
        failed.push({ id, error: e.message || String(e) });
      }
    }
    return { ok: true, moved, failed };
  }

  // Delete bookmarks, returning everything needed to put them back
  // (createBookmarks below) — the caller's Undo depends on this, so the
  // record is read BEFORE the removal and a node that can't be read is
  // never removed.
  if (msg.ycfpBmx === 'removeBookmarks') {
    const removed = [];
    const failed = [];
    for (const id of msg.ids || []) {
      try {
        const [node] = await chrome.bookmarks.get(id);
        if (!node || !node.url) throw new Error('not a bookmark (folders are never removed)');
        await chrome.bookmarks.remove(id);
        removed.push({
          id, title: node.title || '', url: node.url,
          parentId: node.parentId, index: node.index,
        });
      } catch (e) {
        failed.push({ id, error: e.message || String(e) });
      }
    }
    return { ok: true, removed, failed };
  }

  // Undo for removeBookmarks. The new bookmark gets a new id; the original
  // position is restored when the parent folder still exists, otherwise the
  // item is recreated in `fallbackPath` (or reported as failed).
  if (msg.ycfpBmx === 'createBookmarks') {
    const fallback = msg.fallbackPath ? findBookmarkFolder(rootChildren, msg.fallbackPath) : null;
    const created = [];
    const failed = [];
    for (const n of msg.nodes || []) {
      const attempt = async (parentId, withIndex) => chrome.bookmarks.create(Object.assign(
        { parentId, title: n.title || '', url: n.url },
        withIndex && typeof n.index === 'number' ? { index: n.index } : {}));
      try {
        let node;
        try {
          node = await attempt(n.parentId, true);
        } catch (e) {
          // Stale index (the folder shrank since) — same folder, at the end.
          try {
            node = await attempt(n.parentId, false);
          } catch (e2) {
            // The original folder itself is gone.
            if (!fallback) throw e2;
            node = await attempt(fallback.id, false);
          }
        }
        created.push({ oldId: n.id, id: node.id });
      } catch (e) {
        failed.push({ id: n.id, url: n.url, error: e.message || String(e) });
      }
    }
    return { ok: true, created, failed };
  }

  // New bookmarks at the end of the folder at `destPath` — used by the
  // playlist-channels-to-bookmarks feature. Only http(s) links are accepted.
  if (msg.ycfpBmx === 'addBookmarks') {
    const folder = findBookmarkFolder(rootChildren, msg.destPath);
    if (!folder) return { ok: false, error: `Destination folder "${msg.destPath}" not found.` };
    const created = [];
    const failed = [];
    // `i` = position in msg.nodes, so the caller can pair results with its
    // own rows even when Chrome normalizes the URL it was given.
    for (const [i, n] of (msg.nodes || []).entries()) {
      try {
        if (!/^https?:\/\//i.test(n.url || '')) throw new Error('not an http(s) link');
        const node = await chrome.bookmarks.create({ parentId: folder.id, title: n.title || '', url: n.url });
        created.push({ i, id: node.id, url: node.url });
      } catch (e) {
        failed.push({ i, url: n.url, error: e.message || String(e) });
      }
    }
    return { ok: true, created, failed };
  }

  // A folder called `name` directly inside `parentPath`, created if it isn't
  // there yet — used for the "Deleted" folder the Binge → Watch later flow
  // files dead links into.
  if (msg.ycfpBmx === 'ensureFolder') {
    const parent = findBookmarkFolder(rootChildren, msg.parentPath);
    if (!parent) return { ok: false, error: `Bookmarks folder "${msg.parentPath}" not found.` };
    const have = (parent.children || []).find((c) => !c.url && normTitle(c.title) === normTitle(msg.name));
    if (have) return { ok: true, id: have.id, created: false };
    const node = await chrome.bookmarks.create({ parentId: parent.id, title: msg.name });
    return { ok: true, id: node.id, created: true };
  }

  // A–Z by name inside the folder at `path` (and every subfolder when
  // `recursive`): subfolders first, then bookmarks. Names compare without
  // the "(2) " notification count and " - YouTube" tail. Nothing changes
  // folder — only the order inside each one. v1.4.0+.
  if (msg.ycfpBmx === 'sortFolder') {
    const root = findBookmarkFolder(rootChildren, msg.path);
    if (!root) return { ok: false, error: `Bookmarks folder "${msg.path}" not found.` };
    const key = (n) => normTitle(n.title).replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*youtube$/, '');
    let folders = 0, moved = 0;
    const sortOne = async (folder) => {
      const kids = folder.children || [];
      const want = [...kids].sort((a, b) => (Number(!!a.url) - Number(!!b.url))
        || key(a).localeCompare(key(b), undefined, { numeric: true }));
      folders++;
      for (let i = 0; i < want.length; i++) {
        // Walk the live order so each move lands where the next one expects.
        if (kids[i] !== want[i]) {
          await chrome.bookmarks.move(want[i].id, { parentId: folder.id, index: i });
          kids.splice(kids.indexOf(want[i]), 1);
          kids.splice(i, 0, want[i]);
          moved++;
        }
      }
      if (msg.recursive) for (const c of want) if (!c.url) await sortOne(c);
    };
    await sortOne(root);
    return { ok: true, folders, moved };
  }

  return { ok: false, error: `Unknown request "${msg.ycfpBmx}".` };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.ycfpBmx) return false;
  handleMessage(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true; // keep the message channel open for the async response
});

console.info(`[YCFP mover] background v${VERSION} active.`);

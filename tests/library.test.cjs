// Music-library filing logic, run against the real userscript source.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../channel-full-playlist.user.js'), 'utf8');

const start = source.indexOf('  const LIB_SITE =');
const end = source.indexOf('  function libToast(', start);
const section = source.slice(start, end);

function harness({ videos = {}, buckets = {}, failAddTo = null, extra = {} } = {}) {
  const calls = [];
  const db = { meta: { buckets: JSON.parse(JSON.stringify(buckets)) }, chunks: Array(32).fill(null).map(() => ({})) };
  const ctx = vm.createContext({
    PLAYLIST_CAP: 5000,
    TOPIC_SUFFIX: /\s*-\s*Topic$/i,
    console: { warn() {} },
    loadCfg: () => ({ batchSize: 50, batchDelayMs: 0 }),
    sleep: async () => {},
    archivePatch() {}, invalidateExclCache() {},
    playlistTitleOf: (p) => p,
    journalRemovals: (entries, src, to) => calls.push(['journal', entries.map((e) => `${e.id}@${e.playlistId}`).join(','), src, to && to.id]),
    createPlaylist: async (title, ids) => { calls.push(['create', title, ids.join(',')]); return 'NEW_' + title; },
    addToPlaylist: async (pid, ids) => {
      if (pid === failAddTo) throw new Error('STATUS_FAILED');
      calls.push(['add', pid, ids.join(',')]);
    },
    removeFromPlaylist: async (pid, vid) => calls.push(['removeCur', pid, vid]),
    api: async (path, body) => {
      if (path === 'player') return { videoDetails: { title: 'New one', author: 'Artist - Topic', lengthSeconds: '1000' } };
      if (path === 'browse/edit_playlist') { calls.push(['remove', body.playlistId, body.actions.map((a) => a.removedVideoId).join(',')]); return {}; }
      throw new Error('unexpected api ' + path);
    },
    window: { addEventListener() {}, removeEventListener() {}, postMessage() {} },
    location: { origin: 'https://www.youtube.com' },
    setTimeout, clearTimeout, Date, Map, Set, Promise, Object, Array, String, Number, Math, JSON,
    ...extra,
  });
  vm.runInContext(section, ctx);
  // Replace the bridge with an in-memory database.
  for (const [id, v] of Object.entries(videos)) db.chunks[vm.runInContext(`libChunkOf(${JSON.stringify(id)})`, ctx)][id] = v;
  ctx.__db = db;
  vm.runInContext(`libBridge = async (op, args) => {
    const db = __db;
    if (op === 'ping') return { signedIn: true };
    if (op === 'getAll') return JSON.parse(JSON.stringify(db));
    if (op === 'setMeta') { Object.assign(db.meta, JSON.parse(JSON.stringify(args.fields))); return {}; }
    if (op === 'putVideos') { for (const it of args.items) db.chunks[Number(it.chunk.slice(1))][it.id] = JSON.parse(JSON.stringify(it.rec)); return {}; }
    throw new Error('op ' + op);
  };`, ctx);
  const rec = (id) => {
    for (const c of db.chunks) if (c[id]) return c[id];
    return null;
  };
  return { ctx, calls, db, rec, run: (code) => vm.runInContext(code, ctx) };
}

test('the Hololive category recognises VTubers in general', () => {
  const h = harness();
  const is = (s) => h.run(`LIB_HOLO_RE.test(${JSON.stringify(s)})`);
  for (const s of ['Mori Calliope Ch. hololive-EN', 'しぐれうい', 'にじさんじ', 'Ironmouse', 'VSPO! 【ぶいすぽっ！】', 'indie VTuber cover', '花譜']) assert.ok(is(s), s);
  for (const s of ['Michael Jackson', 'Karaoke Ch.', 'Victor Entertainment', 'THE FIRST TAKE', 'Kanaria']) assert.ok(!is(s), s);
});

const SONGS = { '4-song': [{ id: 'PL_S1', name: 'Songs', n: 5000 }, { id: 'PL_S3', name: 'Songs 3', n: 104 }] };

test('bucket names and next playlist names', () => {
  const h = harness();
  assert.equal(h.run(`libBucketName('3-relax-L')`), '3★ Relax · Long');
  assert.equal(h.run(`libNextName('4-song', [{ name: 'Songs 3' }])`), 'Songs 4');
  assert.equal(h.run(`libNextName('3-epic', [{ name: 'Epic' }])`), 'Epic 2');
  assert.equal(h.run(`libNextName('4-pop-L', [])`), '4★ Pop · Long');
});

test('rating a new song files it into its combination and leaves the current playlist', async () => {
  const h = harness({ buckets: SONGS });
  const r = await h.run(`libFile('aaaaaaaaaaa', { c: 'song', s: 4 }, { listId: 'PL_INBOX', canEdit: true })`);
  // 1000 s is over 15 min → Long → its own new playlist.
  assert.equal(r.key, '4-song-L');
  assert.deepEqual(h.calls[0], ['create', '4★ Song · Long', 'aaaaaaaaaaa']);
  assert.deepEqual(h.calls[1], ['removeCur', 'PL_INBOX', 'aaaaaaaaaaa']);
  assert.equal(r.leftCurrent, true);
  const saved = h.rec('aaaaaaaaaaa');
  assert.equal(saved.a, 'Artist');
  assert.equal(saved.f, 'L');
  assert.equal(saved.p, 'NEW_4★ Song · Long');
  assert.ok(h.db.meta.buckets['4-song-L']);
});

test('changing stars moves the song out of its old home', async () => {
  const h = harness({
    buckets: { ...SONGS, '5-song': [{ id: 'PL_BEST', name: 'Best Songs', n: 12 }] },
    videos: { bbbbbbbbbbb: { t: 'x', a: 'y', d: 200, c: 'song', s: 4, f: '', p: 'PL_S3' } },
  });
  await h.run(`libFile('bbbbbbbbbbb', { s: 5 }, { listId: 'PL_S3', canEdit: true, setVideoId: 'SV' })`);
  assert.deepEqual(h.calls.filter((c) => c[0] !== 'journal'), [
    ['add', 'PL_BEST', 'bbbbbbbbbbb'],
    ['removeCur', 'PL_S3', 'bbbbbbbbbbb'],
  ]);
  assert.equal(h.rec('bbbbbbbbbbb').p, 'PL_BEST');
  assert.equal(h.db.meta.buckets['5-song'][0].n, 13);
});

const SHORT_SONG = { t: 'x', a: 'y', d: 200, c: 'song', s: 3, f: '', p: 'PL_SOFT' };
const WITH_SOFT = (chain) => ({ '4-song': chain, '3-song': [{ id: 'PL_SOFT', name: 'Soft songs', n: 9 }] });

test('a full playlist rolls over to the next one', async () => {
  const h = harness({ buckets: WITH_SOFT([{ id: 'PL_S3', name: 'Songs 3', n: 5000 }]), videos: { ccccccccccc: SHORT_SONG } });
  await h.run(`libFile('ccccccccccc', { s: 4 }, {})`);
  assert.deepEqual(h.calls[0], ['create', 'Songs 4', 'ccccccccccc']);
  assert.equal(h.db.meta.buckets['4-song'].length, 2);
  assert.equal(h.rec('ccccccccccc').p, 'NEW_Songs 4');
});

test('an out-of-date count that hits a full playlist also rolls over', async () => {
  const h = harness({ buckets: WITH_SOFT([{ id: 'PL_S3', name: 'Songs 3', n: 4950 }]), videos: { ddddddddddd: SHORT_SONG }, failAddTo: 'PL_S3' });
  await h.run(`libFile('ddddddddddd', { s: 4 }, {})`);
  assert.deepEqual(h.calls[0], ['create', 'Songs 4', 'ddddddddddd']);
});

test('songs rated on the website are moved in batches', async () => {
  const h = harness({
    buckets: { ...SONGS, '3-relax': [{ id: 'PL_RELAX', name: 'Relaxing Music', n: 10 }] },
    videos: {
      e1eeeeeeeee: { t: 'a', d: 100, c: 'relax', s: 3, f: '', p: 'PL_S3' }, // changed on the site
      e2eeeeeeeee: { t: 'b', d: 100, c: 'relax', s: 3, f: '', p: 'PL_S1' }, // changed on the site
      e3eeeeeeeee: { t: 'c', d: 100, c: 'song', s: 4, f: '', p: 'PL_S3' },  // already right
    },
  });
  const n = await h.run('libSyncPending()');
  assert.equal(n, 2);
  const nonJournal = h.calls.filter((c) => c[0] !== 'journal');
  assert.deepEqual([nonJournal[0][0], nonJournal[0][1], nonJournal[0][2].split(',').sort().join(',')],
    ['add', 'PL_RELAX', 'e1eeeeeeeee,e2eeeeeeeee']);
  assert.deepEqual(nonJournal.slice(1).sort(), [['remove', 'PL_S1', 'e2eeeeeeeee'], ['remove', 'PL_S3', 'e1eeeeeeeee']]);
  assert.equal(h.rec('e1eeeeeeeee').p, 'PL_RELAX');
  assert.equal(h.rec('e3eeeeeeeee').p, 'PL_S3');
});

// Dead songs: a suspect is only removed when a logged-out player call says it
// is really gone; then it leaves the playlist and stays on record with z.
function deadHarness(players) {
  const vid = (t) => ({ t, a: 'x', d: 200, c: 'song', s: 4, f: '', p: 'PL_S3' });
  const videos = { aaaaaaaaaa1: vid('deleted one'), aaaaaaaaaa2: vid('plays fine'), aaaaaaaaaa3: vid('blocked here'), aaaaaaaaaa4: vid('age gate'), aaaaaaaaaa5: vid('healthy') };
  const entries = Object.keys(videos).map((id) => ({ id, dead: id === 'aaaaaaaaaa1' }));
  const hidden = new Set(entries.filter((e) => ['aaaaaaaaaa2', 'aaaaaaaaaa3', 'aaaaaaaaaa4'].includes(e.id)));
  const read = Object.assign(entries.slice(), { hiddenEntries: hidden });
  return harness({
    buckets: { '4-song': [{ id: 'PL_S3', name: '4★ Song 3', n: 5 }] },
    videos,
    extra: {
      ORIGIN: 'https://www.youtube.com',
      ytcfgGet: () => 'x',
      textOf: (t) => (t && t.simpleText) || '',
      lsSet() {}, parsePlaylistId: (p) => p, saveCfg() {},
      deadKind: (v) => (v.dead ? 'deleted' : null),
      readWithUnavailable: async () => read,
      fetch: async (url, opt) => {
        const id = JSON.parse(opt.body).videoId;
        return { ok: true, json: async () => ({ playabilityStatus: players[id] || { status: 'OK' } }) };
      },
    },
  });
}

test('only confirmed dead songs are taken out and kept on record', async () => {
  const h = deadHarness({
    aaaaaaaaaa1: { status: 'ERROR', reason: 'This video has been removed by the uploader' },
    aaaaaaaaaa2: { status: 'UNPLAYABLE', reason: 'The page needs to be reloaded.' },
    aaaaaaaaaa3: { status: 'UNPLAYABLE', reason: 'The uploader has not made this video available in your country' },
    aaaaaaaaaa4: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' },
  });
  await h.run('libLoad(true)');
  const dead = await h.run(`libCheckPlaylist({ id: 'PL_S3', name: '4★ Song 3' })`);
  assert.deepEqual(JSON.parse(JSON.stringify(dead.map((d) => d.id).sort())), ['aaaaaaaaaa1', 'aaaaaaaaaa3']);
  const removed = h.calls.filter((c) => c[0] === 'remove');
  assert.deepEqual(removed.map((c) => c[2].split(',').sort().join(',')), ['aaaaaaaaaa1,aaaaaaaaaa3']);
  assert.ok(h.calls.some((c) => c[0] === 'journal' && c[2] === 'dead'));
  assert.match(h.rec('aaaaaaaaaa1').z.why, /removed by the uploader/);
  assert.equal(h.rec('aaaaaaaaaa3').z.pl, 'PL_S3');
  assert.equal(h.rec('aaaaaaaaaa3').z.pn, '4★ Song 3');
  for (const id of ['aaaaaaaaaa2', 'aaaaaaaaaa4', 'aaaaaaaaaa5']) assert.equal(h.rec(id).z, undefined, id);
  assert.equal(h.db.meta.buckets['4-song'][0].n, 3);
});

test('dead songs are not moved by the sync, and rating one again revives it', async () => {
  const h = harness({
    buckets: { '4-song': [{ id: 'PL_S3', name: '4★ Song 3', n: 1 }], '5-song': [{ id: 'PL_BEST', name: '5★ Song', n: 1 }] },
    videos: { fffffffffff: { t: 'gone', d: 100, c: 'song', s: 5, f: '', p: 'PL_S3', z: { at: 1, why: 'deleted' } } },
  });
  assert.equal(await h.run('libSyncPending()'), 0);
  await h.run(`libFile('fffffffffff', { s: 5 }, {})`);
  assert.equal(h.rec('fffffffffff').z, undefined);
  assert.equal(h.rec('fffffffffff').p, 'PL_BEST');
});

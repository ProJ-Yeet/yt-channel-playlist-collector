const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../channel-full-playlist.user.js'), 'utf8');

function node(tag, props = {}, ...children) {
  return { tag, ...props, textContent: children.filter(x => typeof x === 'string').join(''), children,
    events: {}, classList: { add() {}, toggle() {} },
    append(...items) { this.children.push(...items); },
    addEventListener(name, fn) { this.events[name] = fn; },
  };
}

for (const failure of ['add', 'remove', null]) {
  test(`quick move: ${failure || 'success'}`, async () => {
    const calls = [];
    const notices = [];
    const ctx = vm.createContext({
      el: node, loadCfg: () => ({ quickActions: [{ target: 'target', label: 'T', name: 'Destination' }] }),
      parsePlaylistId: x => x, applyMembership() {},
      isVideoInPlaylist: async () => false,
      addOneToPlaylist: async () => { calls.push('add'); if (failure === 'add') throw Error('HTTP 403'); },
      removeFromPlaylist: async () => { calls.push('remove'); if (failure === 'remove') throw Error('STATUS_FAILED'); },
      setMembership: async () => {}, showQuickActionError: x => notices.push(x),
      markRowDone: () => calls.push('marked'), journalRemovals: () => calls.push('journal'),
      findRowForVideo: () => null, document: { title: 'Example - YouTube', querySelector: () => null },
      console: { warn() {} }, setTimeout: fn => fn(),
    });
    const start = source.indexOf('  function buildQuickStrip(');
    const end = source.indexOf('\n  const hasQuickActions', start);
    vm.runInContext(source.slice(start, end), ctx);
    const strip = ctx.buildQuickStrip('source', 'video', true);
    await strip.children[1].events.click({ preventDefault() {}, stopPropagation() {} });
    if (failure === 'add') {
      assert.deepEqual(calls, ['add']);
      assert.match(notices[0], /source was not removed.*HTTP 403/);
    } else if (failure === 'remove') {
      assert.deepEqual(calls, ['add', 'remove']);
      assert.match(notices[0], /could not remove.*both playlists.*STATUS_FAILED/);
    } else {
      assert.deepEqual(calls, ['add', 'remove', 'journal', 'marked']);
      assert.equal(notices.length, 0);
    }
    assert.equal(strip.children[1].disabled, false);
  });
}

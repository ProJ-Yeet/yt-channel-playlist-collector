const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../channel-full-playlist.user.js'), 'utf8');

// Nov 2026: playlist pages end in a continuationItemViewModel whose outer
// continuationCommand wraps the real one — reads stopped at 100 items.
test('video section token: continuationItemViewModel', () => {
  const ctx = vm.createContext({});
  const start = source.indexOf('  function deepFind(obj, key)');
  const end = source.indexOf('  // Continuation token of the list itself');
  vm.runInContext(source.slice(start, end) + ';this.videoSection = videoSection;', ctx);
  const lock = (id) => ({ lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } });
  const page = {
    contents: { itemSectionRenderer: { contents: [
      lock('aaaaaaaaaaa'), lock('bbbbbbbbbbb'),
      { continuationItemViewModel: { continuationCommand: {
        innertubeCommand: { continuationCommand: { token: 'TOKEN-2', request: 'X' } } } } },
    ] } },
  };
  const sec = ctx.videoSection(page);
  assert.equal(sec.count, 2);
  assert.equal(sec.token, 'TOKEN-2');
  // The old renderer still works.
  const old = { contents: { itemSectionRenderer: { contents: [lock('ccccccccccc'),
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'OLD' } } } }] } } };
  assert.equal(ctx.videoSection(old).token, 'OLD');
});

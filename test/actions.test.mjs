import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseAction } = require('../src/main/actionspec.cjs');
const { parseCombo } = require('../src/main/input.cjs');
const { DEFAULTS, ACTION_PRESETS } = require('../src/core/defaults.cjs');

test('key combinations: both "<ctrl>+<shift>+s" and "ctrl+shift+s" styles', () => {
  assert.deepEqual(parseCombo('<ctrl>+<shift>+s'), [0x11, 0x10, 0x53]);
  assert.deepEqual(parseCombo('ctrl+shift+s'), [0x11, 0x10, 0x53]);
  assert.deepEqual(parseCombo('<cmd>+<tab>'), [0x5b, 0x09]);
  assert.deepEqual(parseCombo('<alt>+<left>'), [0x12, 0x25]);
  assert.equal(parseCombo('ctrl+nonsense'), null);
  assert.equal(parseCombo(''), null);
});

test('action texts are checked before they are ever run', () => {
  assert.equal(parseAction('none').kind, 'none');
  assert.equal(parseAction('launcher').kind, 'launcher');
  assert.equal(parseAction('zoom:in').value, 'in');
  assert.ok(parseAction('zoom:sideways').error);
  assert.equal(parseAction('media:playpause').kind, 'media');
  assert.ok(parseAction('media:explode').error);
  assert.equal(parseAction('open:C:/Users/someone/Documents').value, 'C:/Users/someone/Documents');
  assert.ok(parseAction('open:').error);
  assert.ok(parseAction('format:disk').error);
  assert.ok(parseAction('keys:<ctrl>+nonsense').error);
});

test('every default action, preset and launcher tile is valid', () => {
  const all = [DEFAULTS.actions.ringPinch, DEFAULTS.actions.pinkyPinch, ...DEFAULTS.actions.tiles.map((t) => t[1]), ...ACTION_PRESETS.map((p) => p[0])];
  for (const a of all) assert.ok(!parseAction(a).error, `"${a}" should be valid`);
  assert.ok(DEFAULTS.actions.tiles.length <= 11, 'the launcher has room for 11 tiles + Close');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../public/modules/bridge.mjs';

test('posts the four message shapes', () => {
  const sent = [];
  const b = createBridge({ postMessage: (m) => sent.push(m) });
  b.resize(412);
  b.drag();
  b.hide();
  b.attention(2);
  assert.deepEqual(sent, [
    { type: 'resize', height: 412 },
    { type: 'drag' },
    { type: 'hide' },
    { type: 'attention', count: 2 },
  ]);
  assert.equal(b.inShell, true);
});

test('without a webview nothing throws and inShell is false', () => {
  const b = createBridge(undefined);
  b.resize(412);
  b.drag();
  b.hide();
  b.attention(2);
  assert.equal(b.inShell, false);
});

test('a webview that throws does not break the page', () => {
  const b = createBridge({ postMessage: () => { throw new Error('gone'); } });
  assert.doesNotThrow(() => b.resize(1));
});

test('options posts the patch and onOptions hears the shell', () => {
  const sent = [];
  let listener;
  const webview = {
    postMessage: (m) => sent.push(m),
    addEventListener: (t, fn) => { listener = fn; },
    removeEventListener: () => { listener = null; },
  };
  const b = createBridge(webview);
  const heard = [];
  const off = b.onOptions((o) => heard.push(o));
  b.options();
  b.options({ autostart: true });
  listener({ data: { type: 'options', autostart: true, topmost: false } });
  listener({ data: { type: 'options', autostart: 'yes', topmost: false } }); // ignored
  listener({ data: { type: 'other' } }); // ignored
  assert.deepEqual(sent, [{ type: 'options' }, { type: 'options', autostart: true }]);
  assert.deepEqual(heard, [{ autostart: true, topmost: false }]);
  off();
  assert.equal(listener, null);
});

test('without a webview options and onOptions do nothing', () => {
  const b = createBridge(undefined);
  b.options({ topmost: true });
  const off = b.onOptions(() => { throw new Error('must not be called'); });
  assert.equal(typeof off, 'function');
  off();
});

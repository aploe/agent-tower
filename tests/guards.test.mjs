import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPost, checkPostOrigin } from '../src/guards.mjs';
import * as guards from '../src/guards.mjs';

const ID = '123e4567-e89b-42d3-a456-426614174000';

test('checkHookRequest: Claude Code calls from loopback with JSON and without an Origin', () => {
  // The headers Claude Code's hook client sends (axios): no Origin among them.
  const ok = { remoteAddress: '127.0.0.1', headers: { 'content-type': 'application/json', 'user-agent': 'axios/1.15.2', host: '127.0.0.1:4188' } };
  assert.deepEqual(guards.checkHookRequest(ok), { ok: true });
  assert.deepEqual(guards.checkHookRequest({ ...ok, remoteAddress: '::1' }), { ok: true });
  assert.deepEqual(guards.checkHookRequest({ ...ok, remoteAddress: '192.168.1.7' }), { ok: false, status: 403, reason: 'Local only' });
  // A browser always names its origin on a POST; even the daemon's own page is not the hook.
  for (const origin of ['http://evil.example', 'http://127.0.0.1:4188', 'null', '']) {
    assert.deepEqual(guards.checkHookRequest({ ...ok, headers: { ...ok.headers, origin } }), { ok: false, status: 403, reason: 'Foreign origin' }, origin);
  }
  assert.deepEqual(guards.checkHookRequest({ ...ok, headers: { 'content-type': 'text/plain' } }),
    { ok: false, status: 415, reason: 'Content-type must be application/json' });
  assert.equal(guards.checkHookRequest({ remoteAddress: '127.0.0.1' }).status, 415);
});

test('checkPost order and statuses', () => {
  const ok = { remoteAddress: '127.0.0.1', headers: { origin: 'http://127.0.0.1:4188', 'content-type': 'application/json; charset=utf-8' }, sessionId: ID, knownIds: new Set([ID]), port: 4188 };
  assert.deepEqual(checkPost(ok), { ok: true });
  assert.equal(checkPost({ ...ok, remoteAddress: '192.168.1.7' }).status, 403);
  assert.equal(checkPost({ ...ok, headers: { ...ok.headers, origin: undefined } }).status, 403);
  assert.equal(checkPost({ ...ok, headers: { ...ok.headers, origin: 'http://evil.example' } }).status, 403);
  assert.equal(checkPost({ ...ok, headers: { ...ok.headers, origin: 'http://localhost:4188' } }).ok, true);
  assert.equal(checkPost({ ...ok, headers: { ...ok.headers, 'content-type': 'text/plain' } }).status, 415);
  assert.equal(checkPost({ ...ok, sessionId: '../etc' }).status, 400);
  assert.equal(checkPost({ ...ok, knownIds: new Set() }).status, 404);
});

test('checkPost accepts the other loopback spellings and rejects a wrong port', () => {
  const ok = { remoteAddress: '::1', headers: { origin: 'http://127.0.0.1:4188', 'content-type': 'application/json' }, sessionId: ID, knownIds: new Set([ID]), port: 4188 };
  assert.equal(checkPost(ok).ok, true);
  assert.equal(checkPost({ ...ok, remoteAddress: '::ffff:127.0.0.1' }).ok, true);
  assert.equal(checkPost({ ...ok, headers: { ...ok.headers, origin: 'http://127.0.0.1:9999' } }).status, 403);
});

test('checkPost checks origin before content type, content type before id', () => {
  const bad = { remoteAddress: '127.0.0.1', headers: {}, sessionId: 'x', knownIds: new Set(), port: 1 };
  assert.equal(checkPost(bad).status, 403);
  assert.equal(checkPost({ ...bad, headers: { origin: 'http://127.0.0.1:1' } }).status, 415);
  assert.equal(checkPost({ ...bad, headers: { origin: 'http://127.0.0.1:1', 'content-type': 'application/json' } }).status, 400);
});

test('checkPostOrigin needs no session id; foreign origin 403, wrong content type 415, foreign peer 403', () => {
  const ok = { remoteAddress: '127.0.0.1', headers: { origin: 'http://127.0.0.1:4188', 'content-type': 'application/json' }, port: 4188 };
  assert.deepEqual(checkPostOrigin(ok), { ok: true });
  assert.equal(checkPostOrigin({ ...ok, headers: { ...ok.headers, origin: 'http://evil.example' } }).status, 403);
  assert.equal(checkPostOrigin({ ...ok, headers: { ...ok.headers, origin: undefined } }).status, 403);
  assert.equal(checkPostOrigin({ ...ok, headers: { ...ok.headers, 'content-type': 'text/plain' } }).status, 415);
  assert.equal(checkPostOrigin({ ...ok, remoteAddress: '192.168.1.7' }).status, 403);
});

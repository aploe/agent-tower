// Planning the change to Claude Code's settings.json: pure functions on made-up settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOOK_PATH, HOOK_TIMEOUT_S, hookEntry, isOwnEntry, planInstall, planUninstall } from '../scripts/lib/hookPlan.mjs';

const own = hookEntry(4188);
// Another tool's hook on the same event, and a hook on another event.
const other = { matcher: '*', hooks: [{ type: 'command', command: 'bash /opt/demo/status.sh PermissionRequest' }] };
const stop = { hooks: [{ type: 'command', command: 'bash /opt/demo/status.sh Stop' }] };

const bare = () => ({ model: 'demo', permissions: { allow: ['Bash(ls:*)'] } });
const withOther = () => ({ ...bare(), hooks: { PermissionRequest: [other], Stop: [stop] } });
const withOldPort = () => ({ hooks: { PermissionRequest: [other, hookEntry(4190)], Stop: [stop] } });

test('the entry is an http hook on the daemon, for every tool, with the long timeout', () => {
  assert.equal(HOOK_PATH, '/api/hook/permission-request');
  assert.equal(HOOK_TIMEOUT_S, 43200);
  assert.deepEqual(own, {
    matcher: '*',
    hooks: [{ type: 'http', url: 'http://127.0.0.1:4188/api/hook/permission-request', timeout: 43200 }],
  });
});

test('isOwnEntry: only a group whose hooks all point at the daemon\'s hook path on 127.0.0.1', () => {
  assert.equal(isOwnEntry(own), true);
  assert.equal(isOwnEntry(hookEntry(5000)), true);
  assert.equal(isOwnEntry(other), false);
  const at = (url) => ({ matcher: '*', hooks: [{ type: 'http', url }] });
  assert.equal(isOwnEntry(at('http://example.com/api/hook/permission-request')), false);
  assert.equal(isOwnEntry(at('http://127.0.0.1:4188/some/other/hook')), false);
  assert.equal(isOwnEntry(at('not a url')), false);
  assert.equal(isOwnEntry({ matcher: '*', hooks: [...own.hooks, ...other.hooks] }), false); // mixed: not ours to remove whole
  for (const odd of [null, 'x', {}, { hooks: 'x' }, { hooks: [] }, { hooks: [null] }]) assert.equal(isOwnEntry(odd), false);
});

test('planInstall creates hooks.PermissionRequest when missing and keeps every other key', () => {
  const plan = planInstall(bare(), own);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.next, { ...bare(), hooks: { PermissionRequest: [own] } });
});

test('planInstall appends after another tool\'s hook and leaves it in place', () => {
  const plan = planInstall(withOther(), own);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.next, { ...bare(), hooks: { PermissionRequest: [other, own], Stop: [stop] } });
});

test('planInstall is a no-op for an identical entry, wherever it stands', () => {
  for (const list of [[other, own], [own, other], [own]]) {
    const settings = { hooks: { PermissionRequest: list } };
    const plan = planInstall(settings, own);
    assert.equal(plan.changed, false);
    assert.deepEqual(plan.next, settings);
  }
});

test('planInstall replaces an own entry with another port or timeout, in its place, and leaves one', () => {
  const plan = planInstall(withOldPort(), own);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.next.hooks, { PermissionRequest: [other, own], Stop: [stop] });

  const twice = planInstall({ hooks: { PermissionRequest: [hookEntry(4190), other, own] } }, own);
  assert.deepEqual(twice.next.hooks.PermissionRequest, [own, other]);
});

test('planUninstall removes own entries only and drops the keys it leaves empty', () => {
  const both = planUninstall({ ...bare(), hooks: { PermissionRequest: [other, own], Stop: [stop] } });
  assert.equal(both.changed, true);
  assert.deepEqual(both.next, { ...bare(), hooks: { PermissionRequest: [other], Stop: [stop] } });

  const onlyOwnEvent = planUninstall({ ...bare(), hooks: { PermissionRequest: [own], Stop: [stop] } });
  assert.deepEqual(onlyOwnEvent.next, { ...bare(), hooks: { Stop: [stop] } });

  const onlyOwn = planUninstall({ ...bare(), hooks: { PermissionRequest: [own] } });
  assert.deepEqual(onlyOwn.next, bare());

  const none = planUninstall(withOther());
  assert.equal(none.changed, false);
  assert.deepEqual(none.next, withOther());
  // Keys that were empty before are not ours to tidy up.
  assert.deepEqual(planUninstall({ hooks: {} }), { changed: false, next: { hooks: {} } });
  assert.deepEqual(planUninstall({ hooks: { PermissionRequest: [] } }), { changed: false, next: { hooks: { PermissionRequest: [] } } });
});

test('planUninstall takes its hook out of a group it shares and keeps the rest of the group', () => {
  const mixed = { matcher: '*', hooks: [...own.hooks, ...other.hooks] };
  const plan = planUninstall({ hooks: { PermissionRequest: [mixed] } });
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.next, { hooks: { PermissionRequest: [other] } });
});

test('install then uninstall gives back the original settings', () => {
  for (const make of [bare, withOther]) {
    assert.deepEqual(planUninstall(planInstall(make(), own).next).next, make());
  }
  // An old own entry is not "the original": after the round trip it is simply gone.
  assert.deepEqual(planUninstall(planInstall(withOldPort(), own).next).next, { hooks: { PermissionRequest: [other], Stop: [stop] } });
});

test('neither function mutates its input', () => {
  for (const make of [bare, withOther, withOldPort]) {
    const input = make();
    const before = structuredClone(input);
    planInstall(input, own);
    planUninstall(input);
    assert.deepEqual(input, before);
  }
});

test('odd shapes abort instead of being rewritten', () => {
  for (const settings of [null, [], 'x']) {
    assert.throws(() => planInstall(settings, own), { message: 'settings.json: not a JSON object' });
    assert.throws(() => planUninstall(settings), { message: 'settings.json: not a JSON object' });
  }
  for (const hooks of [[], 'x', 7]) {
    assert.throws(() => planInstall({ hooks }, own), { message: 'settings.json: "hooks" is not an object' });
    assert.throws(() => planUninstall({ hooks }), { message: 'settings.json: "hooks" is not an object' });
  }
  for (const list of [{}, 'x', 7]) {
    const settings = { hooks: { PermissionRequest: list } };
    assert.throws(() => planInstall(settings, own), { message: 'settings.json: "hooks.PermissionRequest" is not a list' });
    assert.throws(() => planUninstall(settings), { message: 'settings.json: "hooks.PermissionRequest" is not a list' });
  }
});

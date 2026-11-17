// What scripts/answer-hook.mjs changes in Claude Code's settings.json, as pure functions: they
// take the parsed settings and give back the next ones, and never touch what they were given.
import { isDeepStrictEqual } from 'node:util';

export const HOOK_PATH = '/api/hook/permission-request';
/** How long Claude Code waits for an answer from the widget before the hook call is given up
 *  (seconds). The dialog in the session stays usable all that time. */
export const HOOK_TIMEOUT_S = 43200;

/** The entry for hooks.PermissionRequest: every tool, sent to the daemon on `port`. */
export function hookEntry(port) {
  return {
    matcher: '*',
    hooks: [{ type: 'http', url: `http://127.0.0.1:${port}${HOOK_PATH}`, timeout: HOOK_TIMEOUT_S }],
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One hook that points at the daemon's hook path on 127.0.0.1, whatever the port. */
function isOwnHook(hook) {
  if (!isObj(hook) || hook.type !== 'http' || typeof hook.url !== 'string') return false;
  try {
    const url = new URL(hook.url);
    return url.hostname === '127.0.0.1' && url.pathname === HOOK_PATH;
  } catch {
    return false;
  }
}

/** A matcher group that holds nothing but our hook. */
export function isOwnEntry(group) {
  return isObj(group) && Array.isArray(group.hooks) && group.hooks.length > 0 && group.hooks.every(isOwnHook);
}

/** hooks.PermissionRequest as a list ([] when there is none); throws on a shape we will not rewrite. */
function requestGroups(settings) {
  if (!isObj(settings)) throw new Error('settings.json: not a JSON object');
  if (settings.hooks === undefined) return [];
  if (!isObj(settings.hooks)) throw new Error('settings.json: "hooks" is not an object');
  const list = settings.hooks.PermissionRequest;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error('settings.json: "hooks.PermissionRequest" is not a list');
  return list;
}

/** Our hook as it stands in the settings ({ type, url, timeout }), or null when it is not
 *  installed. Entries of a shape we do not know are passed over. */
export function ownHook(settings) {
  for (const group of requestGroups(settings)) {
    const hooks = isObj(group) && Array.isArray(group.hooks) ? group.hooks : [];
    const found = hooks.find(isOwnHook);
    if (found) return found;
  }
  return null;
}

/** The list without our hook. `at` is where the first one stood (-1: there was none). A group
 *  we share with another hook keeps that other hook. */
function withoutOwn(groups) {
  let at = -1;
  const rest = [];
  for (const group of groups) {
    const hooks = isObj(group) && Array.isArray(group.hooks) ? group.hooks : null;
    if (!hooks || !hooks.some(isOwnHook)) {
      rest.push(group);
      continue;
    }
    if (at === -1) at = rest.length;
    const others = hooks.filter((hook) => !isOwnHook(hook));
    if (others.length) rest.push({ ...group, hooks: others });
  }
  return { rest, at };
}

const sameAs = (settings) => ({ changed: false, next: settings });

/** The settings with `entry` in hooks.PermissionRequest: appended, or in the place of an own
 *  entry that differs (another port or timeout). Identical entry already there: no change. */
export function planInstall(settings, entry) {
  const groups = requestGroups(settings);
  const { rest, at } = withoutOwn(groups);
  const list = at === -1 ? [...rest, entry] : [...rest.slice(0, at), entry, ...rest.slice(at)];
  // Already there, exactly so and only once: leave the file alone, wherever the entry stands.
  if (rest.length === groups.length - 1 && groups.some((group) => isDeepStrictEqual(group, entry))) return sameAs(settings);
  return { changed: true, next: { ...settings, hooks: { ...settings.hooks, PermissionRequest: list } } };
}

/** The settings without our hook. Keys that become empty by that go too; keys that were empty
 *  before stay as they are. */
export function planUninstall(settings) {
  const groups = requestGroups(settings);
  const { rest, at } = withoutOwn(groups);
  if (at === -1) return sameAs(settings);
  const hooks = { ...settings.hooks };
  if (rest.length) hooks.PermissionRequest = rest;
  else delete hooks.PermissionRequest;
  const next = { ...settings };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return { changed: true, next };
}

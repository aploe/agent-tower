// Replaces a file in one step, and only if nobody changed it since it was read.
import fs from 'node:fs/promises';
import path from 'node:path';

/** The file's bytes, or null when it does not exist. */
export async function readOrNull(file) {
  try {
    return await fs.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Writes a file and waits until its content is on the disk, so that a crash right after
 *  cannot leave it empty. flag 'wx' refuses to write over an existing file. */
export async function writeDurable(file, data, { mode = 0o600, flag = 'w' } = {}) {
  const handle = await fs.open(file, flag, mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Makes a rename in `dir` durable. Best effort: not every file system lets a folder be synced. */
async function syncDir(dir) {
  try {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // the rename itself happened; only its durability across a crash is not guaranteed
  }
}

/**
 * Writes `text` to `target` through a temp file in the same folder and a rename, keeping the
 * file's mode. `expected` is what the caller read before it planned its change (null: there
 * was no file). If the file holds something else by now, nothing is written and the error says
 * "changed meanwhile": the program that owns the file writes it too.
 */
export async function replaceFile(target, { expected, text }) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  let mode = 0o600;
  try {
    mode = (await fs.stat(target)).mode & 0o777;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await writeDurable(tmp, text, { mode });
  try {
    const now = await readOrNull(target);
    const same = expected === null ? now === null : now !== null && now.equals(expected);
    if (!same) throw new Error(`${path.basename(target)} changed meanwhile, nothing was written; run the command again`);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await syncDir(path.dirname(target));
}

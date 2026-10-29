import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Generated or untracked directories no workflow ever runs from; tools may rewrite them any time. */
export const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.turbo',
  'coverage',
  '.vite-temp',
]);

/**
 * Every file under `dir` (absolute paths), without descending into generated directories. An entry
 * that disappears between listing and stat is skipped: parallel tool runs create and delete temp
 * files, and a vanished file is not a file the workflow runs.
 */
export function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return out;
    throw error;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const s = lstatSync(full);
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
    }
    if (isDir) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...walkFiles(full));
    } else if (isFile) out.push(full);
  }
  return out;
}

// Small process and path helpers shared by the build scripts. Output is never echoed with env values.
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} exited with ${r.status}.`);
}

export function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`);
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}.`);
    const name = a.slice(2);
    const kind = spec[name];
    if (!kind) throw new Error(`Unknown option ${a}.`);
    if (kind === 'flag') out[name] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value.`);
      out[name] = v;
    }
  }
  return out;
}

/** Recursively lists entries: [{path, dir, symlink}]. Does not follow symlinks. */
export function walk(root) {
  const out = [];
  const rec = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      out.push({ path: p, dir: st.isDirectory(), symlink: st.isSymbolicLink() });
      if (st.isDirectory()) rec(p);
    }
  };
  rec(root);
  return out;
}

const MACHO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
export function isMachO(file) {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(4);
    if (readSync(fd, b, 0, 4, 0) < 4) return false;
    return MACHO.has(b.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

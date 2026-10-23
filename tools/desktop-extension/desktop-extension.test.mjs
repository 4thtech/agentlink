import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest, TARGETS } from './manifest.mjs';
import { appendSignatureBlock, extractSignatureBlock } from './signature.mjs';
import { writeDeterministicZip } from './zip.mjs';

// M1-9f (D-91): the optional Claude Desktop extension bundle (MCPB format, formerly DXT).
// Checks the manifest template (fields, one thing to add, 11 §5 vocabulary), the reproducible zip,
// the MCPB signature block, the openssl sign and verify scripts the release job runs, and the
// release.yml jobs that build, sign, hash, attest and attach the bundle.

const root = resolve(import.meta.dirname, '../..');
const extDir = join(root, 'apps/cli/desktop-extension');
const template = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

const ENTRY = 'server/node_modules/@4thtech-io/agentlink/dist/agentlink.js';

/** The body of one job: from `  <name>:` to the next job header or the end. */
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) return '';
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 2);
}

/** The steps of a job body, split at `      - name:`. */
function steps(body) {
  return body.split(/\n(?= {6}- name: )/).slice(1);
}

/** The `permissions:` block of a job body as `key: value` lines. */
function permissions(body) {
  const m = /\n {4}permissions:\n((?: {6}[a-z-]+: [a-z]+.*\n)+)/.exec(body);
  return m
    ? m[1]
        .trim()
        .split('\n')
        .map((l) => l.trim().replace(/\s*#.*$/, ''))
    : [];
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

describe('desktop extension manifest (apps/cli/desktop-extension/manifest.json)', () => {
  it('is an MCPB manifest that starts the published CLI as `agentlink mcp`', () => {
    expect(template.manifest_version).toBe('0.3');
    expect(template.name).toBe('agentlink');
    expect(template.display_name).toBe('AgentLink');
    expect(template.author).toMatchObject({ name: '4thTech' });
    expect(template.license).toBe('MIT');
    expect(template.repository).toEqual({
      type: 'git',
      url: 'https://github.com/4thtech/agentlink',
    });
    expect(template.server).toEqual({
      type: 'node',
      entry_point: ENTRY,
      mcp_config: { command: 'node', args: [`\${__dirname}/${ENTRY}`, 'mcp'] },
    });
    expect(template.compatibility.runtimes.node).toBe('>=22.14.0');
  });

  it('asks the user for nothing and carries no secrets (D-40: adding it is the only step)', () => {
    expect(template).not.toHaveProperty('user_config');
    expect(template.server.mcp_config).not.toHaveProperty('env');
    expect(JSON.stringify(template)).not.toMatch(/PRIVATE KEY|token|secret|password/i);
  });

  it('uses the 11 §5 vocabulary in every user-facing string', () => {
    const banned =
      /\b(wallet|address|seed phrase|private key|transaction|tx hash|gas|blockchain|on-chain|smart contract|chain|nostr|relay|mcp|harness|envelope|keystore|notari[sz]e|usdc|usdt|faucet)\b/i;
    const text = [
      template.display_name,
      template.description,
      template.long_description,
      ...(template.keywords ?? []),
    ];
    for (const s of text) expect(s).not.toMatch(banned);
  });

  it('is filled per release: version pinned to the npm version, one platform per bundle', () => {
    expect(Object.keys(TARGETS).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'win32-x64']);
    const m = buildManifest(template, { version: '1.2.3', target: 'win32-x64' });
    expect(m.version).toBe('1.2.3');
    expect(m.compatibility.platforms).toEqual(['win32']);
    expect(m.server).toEqual(template.server);
    expect(() => buildManifest(template, { version: '1.2', target: 'win32-x64' })).toThrow();
    expect(() => buildManifest(template, { version: '1.2.3', target: 'linux-x64' })).toThrow();
  });

  it('keeps only public material next to it: the certificate is empty or a PEM certificate', () => {
    const cert = readFileSync(join(extDir, '4thtech-signing.crt'), 'utf8');
    if (cert.trim() !== '') {
      expect(cert).toMatch(/^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----\n?$/);
    }
    for (const name of readdirSync(extDir)) {
      expect(readFileSync(join(extDir, name), 'utf8')).not.toMatch(/PRIVATE KEY/);
    }
  });
});

describe('reproducible bundle zip', () => {
  function stage() {
    const dir = mkdtempSync(join(tmpdir(), 'm1-9f-stage-'));
    mkdirSync(join(dir, 'server/b'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{"a":1}\n');
    writeFileSync(join(dir, 'server/b/z.js'), 'export {};\n'.repeat(50));
    writeFileSync(join(dir, 'server/a.node'), Buffer.from([0, 1, 2, 3, 255]));
    return dir;
  }

  it('gives the same bytes for the same input, with sorted entries a standard unzip reads', () => {
    const out = mkdtempSync(join(tmpdir(), 'm1-9f-zip-'));
    const a = join(out, 'a.mcpb');
    const b = join(out, 'b.mcpb');
    writeDeterministicZip(stage(), a, { mtime: 1_760_000_000 });
    writeDeterministicZip(stage(), b, { mtime: 1_760_000_000 });
    const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
    expect(hash(a)).toBe(hash(b));
    expect(run('unzip', ['-Z1', a]).trim().split('\n')).toEqual([
      'manifest.json',
      'server/a.node',
      'server/b/z.js',
    ]);
    const x = mkdtempSync(join(tmpdir(), 'm1-9f-unzip-'));
    run('unzip', ['-q', a, '-d', x]);
    expect(readFileSync(join(x, 'server/a.node'))).toEqual(Buffer.from([0, 1, 2, 3, 255]));
    expect(readFileSync(join(x, 'server/b/z.js'), 'utf8')).toBe('export {};\n'.repeat(50));
  });
});

describe('MCPB signature block (MCPB_SIG_V1, @anthropic-ai/mcpb 2.1.2 src/node/sign.ts)', () => {
  it('appends header, little-endian length, PKCS#7 DER and footer, and extracts them back', () => {
    const content = Buffer.from('PK zip bytes');
    const sig = Buffer.from([0x30, 0x82, 0x01, 0x02, 0xaa]);
    const signed = appendSignatureBlock(content, sig);
    expect(signed.subarray(0, content.length)).toEqual(content);
    const block = signed.subarray(content.length);
    expect(block.subarray(0, 11).toString()).toBe('MCPB_SIG_V1');
    expect(block.readUInt32LE(11)).toBe(sig.length);
    expect(block.subarray(15, 15 + sig.length)).toEqual(sig);
    expect(block.subarray(15 + sig.length).toString()).toBe('MCPB_SIG_END');
    expect(extractSignatureBlock(signed)).toEqual({ content, signature: sig });
    expect(extractSignatureBlock(content)).toBeNull();
  });

  it('signs with the release scripts and verifies only against the matching certificate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm1-9f-sign-'));
    const mk = (name) => {
      run('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/O=Test/CN=${name}`,
        '-keyout',
        join(dir, `${name}.key`),
        '-out',
        join(dir, `${name}.crt`),
      ]);
    };
    mk('good');
    mk('other');
    const bundle = join(dir, 'x.mcpb');
    writeFileSync(bundle, 'unsigned zip bytes');
    const scripts = join(root, 'tools/desktop-extension');
    run('bash', [join(scripts, 'sign.sh'), join(dir, 'good.key'), join(dir, 'good.crt'), bundle]);
    const signed = readFileSync(bundle);
    expect(extractSignatureBlock(signed).content.toString()).toBe('unsigned zip bytes');
    expect(() =>
      run('bash', [join(scripts, 'verify.sh'), join(dir, 'good.crt'), bundle]),
    ).not.toThrow();
    expect(() =>
      run('bash', [join(scripts, 'verify.sh'), join(dir, 'other.crt'), bundle]),
    ).toThrow();
    writeFileSync(bundle, Buffer.concat([Buffer.from('X'), signed.subarray(1)]));
    expect(() =>
      run('bash', [join(scripts, 'verify.sh'), join(dir, 'good.crt'), bundle]),
    ).toThrow();
  });
});

describe('release.yml desktop extension jobs (D-91)', () => {
  const build = job('desktop-extension-build');
  const release = job('desktop-extension-release');

  it('builds after the npm latest publish, without credentials', () => {
    expect(build).not.toBe('');
    expect(build).toMatch(/needs: publish-latest/);
    expect(build).toMatch(/needs\.publish-latest\.outputs\.published == 'true'/);
    expect(build).not.toMatch(/environment:|secrets\.|id-token/);
    expect(permissions(build)).toEqual(['contents: read']);
    expect(build).toMatch(/tools\/desktop-extension\/build\.mjs/);
    expect(build).toMatch(/timeout-minutes: \d+/);
  });

  it('signs, hashes, attests and attaches in the approved environment, after a green smoke test', () => {
    expect(release).not.toBe('');
    expect(release).toMatch(/needs: \[publish-latest, smoke-latest, desktop-extension-build\]/);
    expect(release).toMatch(/needs\.smoke-latest\.result == 'success'/);
    expect(release).toMatch(/\n {4}environment: npm-publish\n/);
    expect(permissions(release).sort()).toEqual([
      'attestations: write',
      'contents: write',
      'id-token: write',
    ]);
    expect(release).toMatch(/uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
    expect(release).toMatch(/sha256sum/);
    expect(release).toMatch(/gh release upload/);
    expect(release).toMatch(/Stop if DEPLOY_FREEZE is set/);
    expect(release).toMatch(/timeout-minutes: \d+/);
  });

  it('reads the signing key in exactly one step, never prints it, and removes the key file', () => {
    expect(workflow.match(/secrets\.DESKTOP_EXT_SIGNING_KEY/g)).toHaveLength(1);
    const withKey = steps(release).filter((s) => s.includes('DESKTOP_EXT_SIGNING_KEY'));
    expect(withKey).toHaveLength(1);
    const sign = withKey[0];
    expect(sign).toMatch(/- name: Sign the bundles/);
    expect(sign).toMatch(/umask 077/);
    expect(sign).toMatch(/trap .*rm -f/);
    expect(sign).not.toMatch(/set -x|echo "?\$\{?SIGNING_KEY|cat .*key\.pem/);
    expect(sign).toMatch(/tools\/desktop-extension\/sign\.sh/);
    expect(sign).toMatch(/tools\/desktop-extension\/verify\.sh/);
  });

  it('ships unsigned with a clear notice, instead of failing, while the key or certificate is missing', () => {
    const sign = steps(release).find((s) => s.includes('- name: Sign the bundles'));
    expect(sign).toMatch(/::notice::[^\n]*not signed/);
    expect(sign).toMatch(/4thtech-signing\.crt/);
    expect(sign).not.toMatch(/continue-on-error/);
  });

  it('pins every action in both jobs to a full commit SHA', () => {
    const uses = [...`${build}${release}`.matchAll(/uses: ([^\s#]+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(2);
    for (const use of uses) {
      if (use.startsWith('./')) continue;
      expect(use).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('documents the build script, scripts and certificate that the jobs use', () => {
    for (const f of [
      'build.mjs',
      'sign.sh',
      'verify.sh',
      'manifest.mjs',
      'zip.mjs',
      'signature.mjs',
    ]) {
      expect(existsSync(join(root, 'tools/desktop-extension', f))).toBe(true);
    }
    expect(existsSync(join(extDir, 'README.md'))).toBe(true);
  });
});

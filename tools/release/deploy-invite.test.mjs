import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readbackDiagnosisSuite } from './readback-settings-suite.mjs';
import { commandLines, runScripts } from './workflow-run-steps.mjs';

// M1-19-b: the invite page's deploy workflow (release-and-deployment.md §4.5, §4.6, D-25, D-52).
// Structure checks on .github/workflows/deploy-invite.yml as text, and the shared blocks (manifest,
// site check, credential check), extracted between their markers and run on
// fixtures, a local HTTP server and fake tools. The same job layout as deploy-drop.yml, which
// deploy-drop.test.mjs covers in more depth; blocks that are the same text are asserted to be.

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const workflow = read('.github/workflows/deploy-invite.yml');
const dropWorkflow = read('.github/workflows/deploy-drop.yml');
const execFileAsync = promisify(execFile);

/** The body of one job: from `  <name>:` to the next job header or the end. */
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) return '';
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 2);
}

function jobNames() {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  return [...jobs.matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)].map((m) => m[1]);
}

/** Every copy of a marked bash block, unindented (10 spaces). */
function blocks(marker, source = workflow) {
  return [
    ...source.matchAll(new RegExp(`# ${marker}-BEGIN\\n([\\s\\S]*?)\\n\\s*# ${marker}-END`, 'g')),
  ].map((m) => m[1].replace(/^ {10}/gm, ''));
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function fakeBin(tools) {
  const dir = tempDir('invite-fakes');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const output = join(dir, 'github-output');
  const summary = join(dir, 'step-summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  return { dir, bin, output, summary };
}

function run(script, fakes, env) {
  let result;
  try {
    const stdout = execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
      env: {
        PATH: `${fakes.bin}:${process.env.PATH}`,
        RUNNER_TEMP: fakes.dir,
        GITHUB_OUTPUT: fakes.output,
        GITHUB_STEP_SUMMARY: fakes.summary,
        ...env,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    result = { ok: true, output: stdout };
  } catch (error) {
    result = { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
  return {
    ...result,
    github: readFileSync(fakes.output, 'utf8'),
    summary: readFileSync(fakes.summary, 'utf8'),
  };
}

describe('deploy-invite.yml structure', () => {
  it('runs on pushes to main and by dispatch, never on pull requests, with no default permissions', () => {
    expect(workflow).toMatch(/\non:\n {2}push:\n {4}branches: \[main\]\n/);
    expect(workflow).toMatch(/\n {2}workflow_dispatch:\n/);
    expect(workflow).not.toMatch(/pull_request/);
    expect(workflow).toMatch(/\npermissions: \{\}\n/);
  });

  it('has the staging jobs of the drop pipeline and no production job', () => {
    expect(jobNames()).toEqual([
      'ci-green',
      'guard',
      'build',
      'deploy-staging',
      'smoke-staging',
      'catch-up',
    ]);
  });

  it('pins every action to a full commit SHA, the same SHAs as deploy-drop.yml', () => {
    const uses = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(8);
    for (const use of uses) {
      if (use.startsWith('./')) continue;
      expect(use, use).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(dropWorkflow, use).toContain(`uses: ${use}`);
    }
  });

  it('has a timeout on every job', () => {
    for (const name of jobNames()) {
      expect(job(name), name).toMatch(/\n {4}timeout-minutes: \d+\n/);
    }
  });

  it('waits for green CI before anything deploys', () => {
    expect(job('ci-green')).toMatch(/wait-for-ci\.mjs/);
    expect(job('ci-green')).toMatch(/--require ci\.yml:ci-gate/);
    expect(job('ci-green')).toMatch(/--require security\.yml:security-gate/);
    expect(job('guard')).toMatch(/needs: ci-green/);
  });

  it('builds the site once, with no credentials, and deploys that directory to staging', () => {
    const build = job('build');
    expect(build).not.toMatch(/environment:|secrets\.|CLOUDFLARE/);
    expect(build).toMatch(/exactly _headers, i\/index\.html, index\.html and invite\.js/);
    expect(job('deploy-staging')).toMatch(/--assets "\$RUNNER_TEMP\/invite-site"/);
    expect(job('deploy-staging')).toMatch(/name: invite-site/);
  });

  it('deploys staging in environment staging, frozen by DEPLOY_FREEZE and re-checked at start', () => {
    const staging = job('deploy-staging');
    expect(staging).toMatch(/environment: staging/);
    expect(staging).toMatch(/vars\.DEPLOY_FREEZE != 'true'/);
    expect(staging).toMatch(/Stop if DEPLOY_FREEZE is set/);
    expect(staging).toMatch(/--env staging/);
    expect(staging).toMatch(/group: deploy-invite-staging/);
  });

  it('skips cleanly while the Cloudflare credentials are missing', () => {
    const body = job('deploy-staging');
    expect(body).toMatch(/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
    expect(body).toMatch(/CREDENTIAL-CHECK-BEGIN/);
    expect(body).toMatch(/id: deploy\n {8}if: steps\.ready\.outputs\.ready == 'true'\n/);
  });

  it('runs the staging smoke without credentials, on the same bytes as the build', () => {
    const smoke = job('smoke-staging');
    expect(smoke).toMatch(/SITE-CHECK-BEGIN/);
    expect(smoke).toMatch(/needs: \[build, deploy-staging\]/);
    expect(smoke).not.toMatch(/environment:/);
    expect(smoke).not.toMatch(/secrets\./);
    expect(smoke).not.toMatch(/CLOUDFLARE/);
  });

  it('reads back the logging settings after the deploy', () => {
    const body = job('deploy-staging');
    expect(body.indexOf('READBACK-SETTINGS-BEGIN')).toBeGreaterThan(body.indexOf('id: deploy\n'));
    expect(body.lastIndexOf('/script-settings"')).toBeGreaterThan(body.indexOf('id: deploy\n'));
  });

  it('is staging only (owner decision 2026-10-24, card M1-19-d): nothing configures or claims a production deploy', () => {
    expect(workflow).not.toMatch(
      /deploy-production|environment: production|INVITE_PRODUCTION_ORIGIN/,
    );
    expect(workflow).not.toMatch(
      /--env production|agentlink\.4thtech\.io|deploy-invite-production/,
    );
    expect(workflow).not.toMatch(
      /job: freeze|\n {2}freeze:\n|DEPLOY_FREEZE_TOKEN|environment: deploy-freeze/,
    );
    // DEPLOY_FREEZE still halts staging, at the job and again at the start.
    expect(workflow).toMatch(/vars\.DEPLOY_FREEZE != 'true'/);
    // The hourly reconcile reads a deploy-production job; it must not list this workflow yet.
    expect(read('.github/workflows/deploy-reconcile.yml')).not.toContain('deploy-invite.yml');
  });

  it('hands a superseded run to the catch-up job for this same workflow', () => {
    const catchUp = job('catch-up');
    expect(catchUp).toContain('catch-up-deploy.mjs --workflow deploy-invite.yml');
    expect(catchUp).toMatch(/needs: ci-green\n/);
    expect(catchUp).toMatch(/needs\.ci-green\.outputs\.result == 'superseded'/);
    expect(catchUp).toMatch(/needs\.ci-green\.result == 'failure'/);
    expect(catchUp).toMatch(/permissions:\n {6}actions: write\b[^\n]*\n {6}contents: read\n/);
    expect(catchUp).not.toMatch(/environment:|secrets\./);
  });

  it('never cancels a deploy in flight and never interpolates event data into run scripts', () => {
    expect(workflow).toMatch(/cancel-in-progress: false/);
    expect(workflow).not.toMatch(/cancel-in-progress: true/);
    expect(workflow).not.toMatch(/\$\{\{\s*github\.event\./);
    const scripts = runScripts(workflow);
    expect(scripts.length).toBeGreaterThan(10);
    // `${{ }}` only outside run: blocks (if:, env:, with:, outputs:, environment:).
    const runBlocks = [...workflow.matchAll(/run: \|\n((?: {10,}.*\n|\n)*)/g)].map((m) => m[1]);
    for (const body of runBlocks) expect(body).not.toMatch(/\$\{\{/);
  });

  it('never prints the API token, never traces shell commands, never requests a URL with a fragment', () => {
    expect(workflow).not.toMatch(/(echo|printf)[^\n]*\$\{?CLOUDFLARE_API_TOKEN/);
    expect(workflow).not.toMatch(/(echo|printf)[^\n]*\$\{?auth\b/);
    expect(workflow).not.toMatch(/set -x|set -o xtrace/);
    expect(workflow).not.toMatch(/\$ORIGIN[^"\s]*#/);
  });

  it('passes the invite wrangler config and an environment to every wrangler call', () => {
    const calls = [];
    for (const { script } of runScripts(workflow)) {
      for (const line of commandLines(script)) {
        if (/^\s*(echo|printf)\b/.test(line)) continue;
        if (/\bwrangler\s/.test(line)) calls.push(line.trim());
      }
    }
    expect(calls.length).toBe(1);
    for (const call of calls) {
      expect(call, call).toMatch(/pnpm exec wrangler /);
      expect(call, call).toMatch(/ --env staging /);
      expect(call, call).toContain(' --config wrangler.toml');
    }
    const deploys = calls.filter((c) => / wrangler deploy /.test(c));
    expect(deploys.length).toBe(1);
    for (const deploy of deploys) expect(deploy).toMatch(/ --assets "\$RUNNER_TEMP\/invite-site" /);
    // Each of those steps runs in apps/invite, where wrangler.toml lives.
    expect(job('deploy-staging')).toMatch(/\n {8}working-directory: apps\/invite\n/);
  });
});

// Staging only: one read-back block (the drop and the submitter have two).
readbackDiagnosisSuite('deploy-invite.yml', blocks('READBACK-SETTINGS'), 1);

describe('manifest', () => {
  const copies = blocks('MANIFEST');

  it('is the same block in the build, the staging deploy and the smoke', () => {
    expect(copies.length).toBe(3);
    for (const copy of copies) expect(copy).toBe(copies[0]);
    for (const name of ['build', 'deploy-staging', 'smoke-staging']) {
      expect(job(name)).toMatch(/MANIFEST-BEGIN/);
    }
  });

  it('lists every file with its SHA-256, sorted, and hashes the list', () => {
    const site = tempDir('invite-site');
    mkdirSync(join(site, 'i'));
    writeFileSync(join(site, 'index.html'), 'a');
    writeFileSync(join(site, 'i/index.html'), 'b');
    writeFileSync(join(site, 'invite.js'), 'c');
    writeFileSync(join(site, '_headers'), 'd');
    const manifest = join(tempDir('invite-manifest'), 'm');
    const script = `${copies[0]}\necho "sha=$sha"`;
    const out = execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
      env: { PATH: process.env.PATH, SITE_DIR: site, MANIFEST: manifest },
      encoding: 'utf8',
    });
    const lines = readFileSync(manifest, 'utf8').trim().split('\n');
    expect(lines.map((l) => l.split(/\s+/)[1])).toEqual([
      './_headers',
      './i/index.html',
      './index.html',
      './invite.js',
    ]);
    expect(lines[2]).toMatch(/^[0-9a-f]{64} +\.\/index\.html$/);
    expect(out).toMatch(/^sha=[0-9a-f]{64}$/m);
    // A changed byte changes the hash of the list.
    writeFileSync(join(site, 'invite.js'), 'x');
    const again = execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
      env: { PATH: process.env.PATH, SITE_DIR: site, MANIFEST: manifest },
      encoding: 'utf8',
    });
    expect(again).not.toBe(out);
  });
});

describe('credential check', () => {
  const copies = blocks('CREDENTIAL-CHECK');
  const script = copies[0] ?? '';
  const ACCOUNT = '0123456789abcdef0123456789abcdef';
  const check = (code, env = {}) => {
    const fakes = fakeBin({ curl: `printf '%s' ${JSON.stringify(code)}` });
    return run(script, fakes, {
      CLOUDFLARE_API_TOKEN: 'test-token-value',
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      DEPLOY_ENV: 'staging',
      WORKER: 'agentlink-invite-staging',
      ...env,
    });
  };

  it('appears once, in the staging deploy', () => {
    expect(copies.length).toBe(1);
  });

  it('skips cleanly without credentials', () => {
    for (const env of [{ CLOUDFLARE_API_TOKEN: '' }, { CLOUDFLARE_ACCOUNT_ID: '' }]) {
      const result = check('200', env);
      expect(result.ok).toBe(true);
      expect(result.github).toContain('ready=false');
    }
  });

  it('is ready when the Worker exists or does not exist yet (the first deploy creates it)', () => {
    for (const code of ['200', '404']) {
      const result = check(code);
      expect(result.ok, result.output).toBe(true);
      expect(result.github).toContain('ready=true');
    }
  });

  it('fails loudly for a token the API refuses, and never prints it', () => {
    for (const code of ['401', '403', '500', '']) {
      const result = check(code);
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(
        /::error::Reading the settings of agentlink-invite-staging failed/,
      );
      expect(result.output).not.toContain('test-token-value');
    }
  });

  it('fails for a malformed account ID', () => {
    const result = check('200', { CLOUDFLARE_ACCOUNT_ID: 'not-hex' });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/32-character hex/);
  });
});

describe('site check (what is served equals the build)', () => {
  const copies = blocks('SITE-CHECK');
  const FILES = {
    '/': ['index.html', '<!doctype html><title>Index</title>'],
    '/i': ['i/index.html', '<!doctype html><title>Invite</title>'],
    '/invite.js': ['invite.js', 'export const x = 1;'],
  };
  const HEADERS = {
    'Content-Security-Policy': "default-src 'none'; script-src 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };

  function stageSite() {
    const site = tempDir('invite-staged');
    mkdirSync(join(site, 'i'));
    for (const [file, body] of Object.values(FILES)) writeFileSync(join(site, file), body);
    // Written the way site/_headers is: comments (with colons), a rule line, indented headers.
    writeFileSync(
      join(site, '_headers'),
      [
        '# Headers of the invite host (08 §4): one block.',
        '/*',
        ...Object.entries(HEADERS).map(([k, v]) => `  ${k}: ${v}`),
        '',
      ].join('\n'),
    );
    const manifest = join(tempDir('invite-staged-manifest'), 'm');
    execFileSync(
      'bash',
      ['-c', `(cd "$SITE_DIR" && find . -type f | LC_ALL=C sort | xargs sha256sum) > "$MANIFEST"`],
      { env: { PATH: process.env.PATH, SITE_DIR: site, MANIFEST: manifest } },
    );
    return { site, manifest };
  }

  /** Serves the staged site; `tweak(path, response)` may change an answer. */
  async function withServer(tweak, fn) {
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      const entry = FILES[path];
      const answer = {
        status: entry ? 200 : 404,
        headers: { ...HEADERS },
        body: entry ? entry[1] : 'not found',
      };
      tweak(path, answer);
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
      return await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
      server.close();
    }
  }

  async function check(origin, staged) {
    const script = `${copies[0]}\nrc=0\nsite_check || rc=$?\necho "rc=$rc"`;
    const { stdout } = await execFileAsync('bash', ['-euo', 'pipefail', '-c', script], {
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: tempDir('invite-check'),
        ORIGIN: origin,
        SITE_DIR: staged.site,
        MANIFEST: staged.manifest,
        SITE_PROTO: '=http',
      },
    });
    return { rc: Number(/rc=(\d+)/.exec(stdout)[1]), stdout };
  }

  const staged = stageSite();

  it('appears once, in the staging smoke', () => {
    expect(copies.length).toBe(1);
  });

  it('is healthy when the pages and script equal the build, the headers match and an unknown path is a 404', async () => {
    await withServer(
      () => {},
      async (origin) => {
        const result = await check(origin, staged);
        expect(result.rc, result.stdout).toBe(0);
        expect(result.stdout).toMatch(/Healthy/);
      },
    );
  });

  it('fails when a served file is not the built one', async () => {
    for (const path of Object.keys(FILES)) {
      await withServer(
        (p, answer) => {
          if (p === path) answer.body += ' ';
        },
        async (origin) => {
          const result = await check(origin, staged);
          expect(result.rc, path).toBe(1);
          expect(result.stdout).toContain(`${path}: the served bytes are not the built`);
        },
      );
    }
  });

  it('fails when any header of 08 §4 is missing or differs', async () => {
    for (const name of Object.keys(HEADERS)) {
      for (const change of ['missing', 'differs']) {
        await withServer(
          (p, answer) => {
            if (p !== '/i') return;
            if (change === 'missing') delete answer.headers[name];
            else answer.headers[name] += ' x';
          },
          async (origin) => {
            const result = await check(origin, staged);
            expect(result.rc, `${name} ${change}`).toBe(1);
            expect(result.stdout).toContain(`header ${name.toLowerCase()}`);
            // Names only: no header value is printed.
            expect(result.stdout).not.toContain("default-src 'none'");
          },
        );
      }
    }
  });

  it('fails on a redirect (the invite path must answer 200 itself) and on a non-404 for an unknown path', async () => {
    await withServer(
      (p, answer) => {
        if (p === '/i') {
          answer.status = 307;
          answer.headers.Location = '/i/';
        }
      },
      async (origin) => {
        const result = await check(origin, staged);
        expect(result.rc).toBe(1);
        expect(result.stdout).toMatch(/\/i: HTTP 307/);
      },
    );
    await withServer(
      (p, answer) => {
        if (!FILES[p]) answer.status = 200;
      },
      async (origin) => {
        const result = await check(origin, staged);
        expect(result.rc).toBe(1);
        expect(result.stdout).toMatch(/unknown path answered HTTP 200/);
      },
    );
  });

  it('returns 2 when nothing answers at all (no connection yet)', async () => {
    const result = await check('http://127.0.0.1:9', staged);
    expect(result.rc).toBe(2);
  });
});

describe('apps/invite/wrangler.toml', () => {
  const toml = read('apps/invite/wrangler.toml');
  const section = (name) => {
    const start = toml.indexOf(`\n[${name}]\n`);
    if (start < 0) return '';
    const rest = toml.slice(start + 1);
    const next = rest.slice(1).search(/\n\[/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };

  it('has a staging environment and no production environment (M1-19-d)', () => {
    expect(section('env.staging')).toMatch(/name = "agentlink-invite-staging"/);
    expect(section('env.staging')).toMatch(/workers_dev = true/);
    expect(section('env.staging')).toMatch(/routes = \[\]/);
    expect(toml).not.toMatch(/env\.production|custom_domain|agentlink\.4thtech\.io/);
  });

  it('serves static assets only: no script, no vars, no bindings, no secrets', () => {
    expect(toml).not.toMatch(/^main\s*=/m);
    expect(toml).not.toMatch(/\[vars\]|\[env\.\w+\.vars\]|\[\[.*\]\]|account_id/);
    for (const env of ['', 'env.staging.']) {
      const assets = section(`${env}assets`);
      expect(assets, env).toMatch(/directory = "\.\/dist\/site"/);
      // `/i` must answer 200 itself, not redirect to `/i/` (the invite link path).
      expect(assets, env).toMatch(/html_handling = "drop-trailing-slash"/);
      expect(assets, env).toMatch(/not_found_handling = "none"/);
    }
  });

  it('keeps logging off in every environment (04 §4, I-7)', () => {
    for (const env of ['', 'env.staging.']) {
      expect(section(`${env}observability`), env).toMatch(/enabled = false/);
      expect(section(`${env}observability.logs`), env).toMatch(/enabled = false/);
      expect(section(`${env}observability.logs`), env).toMatch(/invocation_logs = false/);
      expect(section(`${env}observability.traces`), env).toMatch(/enabled = false/);
    }
    expect(toml.match(/^logpush = false$/gm)?.length).toBe(2);
    expect(toml).not.toMatch(/logpush = true|tail_consumers/);
  });

  it('serves the headers of 08 §4 from site/_headers, which the build copies', () => {
    const headers = read('apps/invite/site/_headers');
    expect(headers).toContain('Referrer-Policy: no-referrer');
    expect(headers).toContain('connect-src https://drop.agentlink.4thtech.io;');
    expect(read('apps/invite/vite.config.ts')).toContain("publicDir: 'site'");
  });
});

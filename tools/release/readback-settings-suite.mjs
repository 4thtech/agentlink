import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// OPS-PRIV-1 follow-up: the logging read-back's diagnosis, shared by deploy-submitter.test.mjs and
// deploy-drop.test.mjs. Every READBACK-SETTINGS block in both workflows runs one jq program,
// .github/scripts/worker-logging-settings.jq; on a failure it names the failed conditions and,
// for the fields they read, only the JSON type and a boolean, number or null value. The
// `documented-*` fixtures mirror the response shape of Cloudflare's "Get Script Settings"
// (GET .../workers/scripts/{script_name}/script-settings), including the fields our settings
// leave at their defaults (head_sampling_rate, persist, propagation_policy, tags).

const ROOT = resolve(import.meta.dirname, '../..');
export const PROGRAM = '.github/scripts/worker-logging-settings.jq';
const FIXTURES = resolve(import.meta.dirname, 'fixtures/script-settings');

export const documented = (name) =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

function fixture(value) {
  const dir = mkdtempSync(join(tmpdir(), 'settings-readback-'));
  const file = join(dir, 'response.json');
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

/** Runs one READBACK-SETTINGS block on a response body, as the workflow step does. */
export function runReadback(script, body) {
  try {
    const stdout = execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
      env: { PATH: process.env.PATH, GITHUB_WORKSPACE: ROOT, SETTINGS_JSON: fixture(body) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/** The diagnostic lines of an output: one per failed condition. */
const failures = (output) => output.split('\n').filter((line) => line.startsWith('failed '));

// A field description: our own path, then a type and at most a scalar, a length or a boolean.
const FIELD =
  '(?:success|result(?:\\.[a-z_]+)*): (?:missing|null|boolean (?:true|false)|number -?[0-9.eE+-]+|string|array of [0-9]+(?:, only "cloudflare": (?:true|false))?|object with [0-9]+ keys|not readable(?: \\(parent is [a-z]+\\))?)';
const LINE = new RegExp(`^failed [a-z-]+: ${FIELD}(?:; ${FIELD})*$`);

/** The diagnosis tests for the blocks of one workflow (`copies`: its READBACK-SETTINGS blocks). */
export function readbackDiagnosisSuite(workflowName, copies) {
  describe(`logging settings read-back diagnosis (${workflowName})`, () => {
    const script = copies[0] ?? '';
    const run = (body) => runReadback(script, body);

    it('runs the one shared jq program, with no inline copy of the check', () => {
      expect(copies.length).toBe(2);
      for (const copy of copies) {
        expect(copy).toContain(`jq -r -f "$GITHUB_WORKSPACE/${PROGRAM}"`);
        expect(copy).not.toMatch(/jq -e '/);
      }
    });

    it('accepts the documented response shape with everything off and the defaults set', () => {
      const result = run(documented('documented-off'));
      expect(result.ok, result.output).toBe(true);
      expect(failures(result.output)).toEqual([]);
    });

    it('refuses the documented example (everything on) and names each condition', () => {
      const result = run(documented('documented-on'));
      expect(result.ok).toBe(false);
      expect(failures(result.output)).toEqual([
        'failed observability-off: result.observability.enabled: boolean true',
        'failed logs-off: result.observability.logs: object with 5 keys; result.observability.logs.enabled: boolean true',
        'failed invocation-logs-off: result.observability.logs.invocation_logs: boolean true',
        'failed log-destinations-none: result.observability.logs.destinations: array of 1, only "cloudflare": true',
        'failed traces-off: result.observability.traces: object with 5 keys; result.observability.traces.enabled: boolean true',
        'failed trace-destinations-none: result.observability.traces.destinations: array of 1, only "cloudflare": true',
        'failed tail-consumers-none: result.tail_consumers: array of 1',
      ]);
    });

    it('names only the failed conditions, with the type and scalar of each field', () => {
      const off = documented('documented-off');
      const missing = structuredClone(off);
      delete missing.result.logpush;
      expect(failures(run(missing).output)).toEqual(['failed logpush-off: result.logpush: missing']);

      const invocation = structuredClone(off);
      invocation.result.observability.logs.invocation_logs = true;
      expect(failures(run(invocation).output)).toEqual([
        'failed invocation-logs-off: result.observability.logs.invocation_logs: boolean true',
      ]);

      const typed = structuredClone(off);
      typed.result.logpush = 'false';
      typed.result.observability.enabled = 0;
      typed.result.tail_consumers = {};
      expect(failures(run(typed).output)).toEqual([
        'failed logpush-off: result.logpush: string',
        'failed observability-off: result.observability.enabled: number 0',
        'failed tail-consumers-none: result.tail_consumers: object with 0 keys',
      ]);

      expect(failures(run({ success: false, errors: [{ code: 10007 }] }).output)).toContain(
        'failed success: success: boolean false',
      );
    });

    it('prints only field names and scalars, never strings, URLs, tokens or IDs from the body', () => {
      const secrets = [
        'https://example.invalid/collect?token=abc',
        'cf-token-0123456789abcdefSECRET',
        '0123456789abcdef0123456789abcdef',
        'agentlink-secret-script',
        'otel-export-destination',
      ];
      const [url, token, id, script, destination] = secrets;
      const body = {
        success: true,
        errors: [{ code: 1000, message: token, documentation_url: url }],
        result: {
          id,
          logpush: url,
          observability: {
            enabled: token,
            logs: { enabled: true, invocation_logs: id, destinations: [destination, url] },
            traces: { enabled: script, destinations: { [token]: url } },
          },
          tail_consumers: [{ service: script, namespace: id, environment: token }],
          streaming_tail_consumers: url,
          [token]: url,
        },
      };
      const result = run(body);
      expect(result.ok).toBe(false);
      for (const secret of secrets) expect(result.output).not.toContain(secret);
      const lines = failures(result.output);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line, line).toMatch(LINE);
      // The output is the error line, the diagnostic lines and nothing else.
      for (const line of result.output.split('\n').filter((l) => l.trim() !== '')) {
        expect(line.startsWith('::error::') || LINE.test(line), line).toBe(true);
      }
    });

    it('refuses an empty body, two JSON documents and non-JSON, without echoing them', () => {
      for (const body of ['', '{"success":true} {"success":true}', 'token=cf-SECRET-value']) {
        const result = run(body);
        expect(result.ok, body).toBe(false);
        expect(result.output).not.toContain('cf-SECRET-value');
      }
    });
  });
}

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseYaml } from './yaml.mjs';
import {
  STATUS_FILE,
  TARGETS,
  renderReadmeRoadmap,
  renderReadmeStatus,
  renderSiteMilestones,
  renderSiteSummary,
  replaceBlock,
  run,
  validateStatus,
} from './status.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const real = () => parseYaml(readFileSync(join(repo, STATUS_FILE), 'utf8'));

describe('the real status file', () => {
  it('is valid', () => {
    expect(validateStatus(real())).toEqual([]);
  });

  it('is in sync with README.md and the docs-site page in this repository', () => {
    const { problems, skipped } = run({ root: repo, check: true });
    expect(problems).toEqual([]);
    expect(skipped).toEqual([]); // the knowledge base carries the markers, so nothing is skipped
  });
});

describe('validateStatus', () => {
  const clone = () => structuredClone(real());

  it.each([
    ['a missing required field', (d) => delete d.phase, /"phase" is required/],
    ['a bad date', (d) => (d.updated = '15 Oct 2026'), /YYYY-MM-DD/],
    ['a bad version', (d) => (d.version = '0.0.1'), /v0\.0\.1/],
    [
      'an unknown component state',
      (d) => (d.areas[0].components[0].state = 'finished'),
      /state must be one of/,
    ],
    [
      'a bad pull request ref',
      (d) => (d.areas[1].components[0].prs = ['#27']),
      /number or contracts#N/,
    ],
    ['an unknown milestone state', (d) => (d.roadmap[0].state = 'late'), /state must be one of/],
    [
      'a milestone that is not in the roadmap',
      (d) => (d.milestone = 'M9 Nothing'),
      /roadmap entry/,
    ],
    ['an empty roadmap', (d) => (d.roadmap = []), /"roadmap" must be a non-empty list/],
    ['a missing deploy note', (d) => delete d.deploy.testnet.note, /deploy\.testnet/],
    [
      'an address',
      (d) => (d.deploy.testnet.note = `at 0x${'ab'.repeat(20)}`),
      /address or a 32-byte hex/,
    ],
    [
      'a 32-byte hex string',
      (d) => (d.areas[0].components[0].summary = 'ab'.repeat(32)),
      /address or a 32-byte hex/,
    ],
  ])('rejects %s', (_label, mutate, expected) => {
    const data = clone();
    mutate(data);
    expect(validateStatus(data).join('\n')).toMatch(expected);
  });
});

describe('renderers', () => {
  it('render the source, with pull request links and the state of each component', () => {
    const data = real();
    const status = renderReadmeStatus(data);
    expect(status).toContain(`**Version:** ${data.version}`);
    expect(status).toContain('[#27](https://github.com/4thtech/agentlink/pull/27)');
    expect(status).toContain('contracts#4');
    expect(status).not.toContain('](https://github.com/4thtech/agentlink/pull/contracts');
    expect(status.split('\n').every((line) => line.startsWith('>'))).toBe(true);
    expect(renderReadmeRoadmap(data)).toContain('| **M0 Foundations** (nearly complete) |');
    expect(renderSiteMilestones(data)).toContain('| **M3** Mainnet beta (Base, Gnosis) |');
    expect(renderSiteSummary(data)).toContain(
      '| Core (@agentlink/core) | Invites and pairing | Done |',
    );
  });
});

describe('replaceBlock', () => {
  it('replaces only what is between the markers', () => {
    const out = replaceBlock('a\n<!-- x:start -->\nold\n<!-- x:end -->\nb', 'x', 'new');
    expect(out.text).toBe('a\n<!-- x:start -->\nnew\n<!-- x:end -->\nb');
  });

  it.each([
    ['an end marker without a start', 'a\n<!-- x:end -->'],
    ['a start marker without an end', 'a\n<!-- x:start -->\nb'],
    ['a duplicated start marker', '<!-- x:start -->\n<!-- x:start -->\n<!-- x:end -->'],
    ['a duplicated end marker', '<!-- x:start -->\n<!-- x:end -->\n<!-- x:end -->'],
    ['an end marker before the start marker', '<!-- x:end -->\n<!-- x:start -->'],
  ])('reports %s', (_label, text) => {
    expect(replaceBlock(text, 'x', 'new').error).toBeTypeOf('string');
  });

  it('reports absent markers as missing', () => {
    expect(replaceBlock('nothing here', 'x', 'new')).toEqual({ missing: true });
  });
});

describe('run', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'docs-status-'));
    for (const file of [STATUS_FILE, ...TARGETS.filter((t) => !t.optional).map((t) => t.file)]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(join(repo, file), join(root, file));
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const read = (file) => readFileSync(join(root, file), 'utf8');
  const write = (file, text) => writeFileSync(join(root, file), text);
  const SITE = 'docs-site/technical/project/status-and-roadmap.md';

  it('passes the check when nothing has drifted, and skips an absent knowledge base', () => {
    const result = run({ root, check: true });
    expect(result.problems).toEqual([]);
    expect(result.skipped.join('\n')).toContain('knowledge/07-status-and-roadmap.md is absent');
  });

  it('fails the check when README.md was edited by hand, and fixes it when generating', () => {
    write('README.md', read('README.md').replace('· **Version:** v0.0.1', '· **Version:** v9.9.9'));
    const checked = run({ root, check: true });
    expect(checked.problems.join('\n')).toContain('README.md is out of date');
    expect(read('README.md')).toContain('v9.9.9'); // the check never writes

    expect(run({ root }).changed).toEqual(['README.md']);
    expect(read('README.md')).not.toContain('v9.9.9');
    expect(run({ root, check: true }).problems).toEqual([]);
  });

  it('fails the check when the source changed and a page did not', () => {
    const source = read(STATUS_FILE).replace(
      /updated: "\d{4}-\d{2}-\d{2}"/,
      'updated: "2026-11-01"',
    );
    write(STATUS_FILE, source);
    const { problems } = run({ root, check: true });
    expect(problems.join('\n')).toContain('README.md is out of date');
    expect(problems.join('\n')).toContain(`${SITE} is out of date`);
    run({ root });
    expect(read(SITE)).toContain('Current as of 1 Nov 2026');
    expect(run({ root, check: true }).problems).toEqual([]);
  });

  it('fails when a required page lost its markers or is missing', () => {
    write(SITE, read(SITE).replace('<!-- status-hint:start -->', ''));
    expect(run({ root, check: true }).problems.join('\n')).toContain(
      'no "<!-- status-hint:start -->"',
    );
    write(SITE, '# no markers at all\n');
    expect(run({ root, check: true }).problems.join('\n')).toContain(
      'missing <!-- status-hint:start -->',
    );
    rmSync(join(root, SITE));
    expect(run({ root, check: true }).problems).toContain(`${SITE} is missing`);
  });

  it('fails when the milestone badge disagrees with the source', () => {
    write(
      'README.md',
      read('README.md').replace('[![Milestone: M0 Foundations]', '[![Milestone: M1a]'),
    );
    expect(run({ root, check: true }).problems.join('\n')).toContain('milestone badge says "M1a"');
  });

  it('fails when the source is missing, malformed or invalid, and then writes nothing', () => {
    const before = read('README.md');
    write(STATUS_FILE, 'version: v0.0.1\n\tbad: 1');
    expect(run({ root }).problems.join('\n')).toContain('tabs are not allowed');
    write(STATUS_FILE, 'version: "nope"\n');
    expect(run({ root }).problems.join('\n')).toContain(
      'docs/status.yaml: status: "updated" is required',
    );
    rmSync(join(root, STATUS_FILE));
    expect(run({ root, check: true }).problems).toEqual([`${STATUS_FILE} is missing`]);
    expect(read('README.md')).toBe(before);
  });

  describe('the knowledge base (created by a separate change)', () => {
    const KB = 'knowledge/07-status-and-roadmap.md';
    const withMarkers = [
      '# Status and roadmap',
      '<!-- status-intro:start -->\nstale\n<!-- status-intro:end -->',
      '<!-- status-summary:start -->\nstale\n<!-- status-summary:end -->',
      '<!-- status-milestones:start -->\nstale\n<!-- status-milestones:end -->',
      '',
    ].join('\n\n');

    it('is skipped when the file has no markers yet', () => {
      mkdirSync(join(root, 'knowledge'));
      write(KB, '# Status and roadmap\n\nhand-written\n');
      const result = run({ root, check: true });
      expect(result.problems).toEqual([]);
      expect(result.skipped.join('\n')).toContain(`${KB} has no status-intro markers`);
    });

    it('is enforced once it has markers', () => {
      mkdirSync(join(root, 'knowledge'));
      write(KB, withMarkers);
      expect(run({ root, check: true }).problems.join('\n')).toContain(`${KB} is out of date`);
      expect(run({ root }).changed).toEqual([KB]);
      expect(run({ root, check: true }).problems).toEqual([]);
      expect(existsSync(join(root, KB))).toBe(true);
    });
  });
});

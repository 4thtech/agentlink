// N1 notice lint: pages raise notices only through the shared Banner, PageNotice, InlineError and
// notify() (@4thtech-io/ui; docs/design/notices.md). Page code may not add its own live regions
// (role alert or status, aria-live) or its own note, error or hint classes. The counts in
// notice-lint-baseline.json are the notices still to migrate: they may go down, never up, and a new
// file starts at zero. Lowering a count: edit the baseline in the same change.
import { describe, expect, it } from 'vitest';
import baselineRaw from './notice-lint-baseline.json?raw';

const sources = import.meta.glob<string>('./pages/**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const LIVE = /role="(?:alert|status)"|role: '(?:alert|status)'|aria-live=/g;
const BESPOKE =
  /className="[^"]*\b[a-z]{1,4}-(?:note|notice|error|error-box|failed|hint|status|live|problem)(?:-[a-z]+)?\b[^"]*"/g;

interface Baseline {
  readonly liveRegions: Readonly<Record<string, number>>;
  readonly bespokeClasses: Readonly<Record<string, number>>;
}
const baseline = JSON.parse(baselineRaw) as Baseline;

const pageFiles = Object.entries(sources).filter(([file]) => !/\.test\./.test(file));

function count(source: string, re: RegExp): number {
  return source.match(re)?.length ?? 0;
}

describe('notice lint (N1)', () => {
  it('scans the pages', () => {
    expect(pageFiles.length).toBeGreaterThan(50);
  });

  it('adds no live region outside the shared notice components', () => {
    const over: string[] = [];
    for (const [file, source] of pageFiles) {
      const key = file.replace('./pages/', '');
      const n = count(source, LIVE);
      const allowed = baseline.liveRegions[key] ?? 0;
      if (n > allowed) {
        over.push(
          `${key}: ${n} live regions, ${allowed} allowed. Use Banner, PageNotice, InlineError or notify().`,
        );
      }
    }
    expect(over).toEqual([]);
  });

  it('adds no bespoke note, error or hint class for a notice', () => {
    const over: string[] = [];
    for (const [file, source] of pageFiles) {
      const key = file.replace('./pages/', '');
      const n = count(source, BESPOKE);
      const allowed = baseline.bespokeClasses[key] ?? 0;
      if (n > allowed) {
        over.push(
          `${key}: ${n} ad-hoc notice classes, ${allowed} allowed. Use Banner, PageNotice, InlineError or notify().`,
        );
      }
    }
    expect(over).toEqual([]);
  });

  it('keeps the baseline honest: no entry for a file that is gone or has no notices left', () => {
    const byKey = new Map(
      pageFiles.map(([file, source]) => [file.replace('./pages/', ''), source]),
    );
    const stale: string[] = [];
    for (const [key, allowed] of Object.entries(baseline.liveRegions)) {
      const n = count(byKey.get(key) ?? '', LIVE);
      if (n < allowed) stale.push(`${key}: live regions now ${n}, baseline ${allowed}`);
    }
    for (const [key, allowed] of Object.entries(baseline.bespokeClasses)) {
      const n = count(byKey.get(key) ?? '', BESPOKE);
      if (n < allowed) stale.push(`${key}: classes now ${n}, baseline ${allowed}`);
    }
    expect(stale).toEqual([]);
  });

  it('adds no new clipboard write in a page: copying goes through CopyButton or copyText', () => {
    const own = pageFiles
      .filter(([, source]) => /\.writeText\(/.test(source))
      .map(([file]) => file.replace('./pages/', ''))
      .sort();
    // Still to migrate: their copy needs a link fetched on click, a path or a code with its own steps.
    expect(own).toEqual([
      'about/diagnostics.tsx',
      'apps/panel.tsx',
      'backup/export-kit.tsx',
      'first-run/backup-code.tsx',
      'home/file-reader.tsx',
      'invite/invite-link-actions.tsx',
      'invite/invite-panel.tsx',
    ]);
  });
});

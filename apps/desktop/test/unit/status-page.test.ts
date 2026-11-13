// The local status page (src/main/status-page.ts): a fixed, script-free page shown in the window
// while the core starts and when it could not start. Nothing from the core or the environment is
// ever inserted; the two buttons are links to fixed URLs that the main process intercepts.
import { describe, expect, it } from 'vitest';
import {
  STATUS_ACTION_URLS,
  STATUS_COPY,
  STATUS_KINDS,
  STATUS_PAGE_CSP,
  isStatusPageUrl,
  statusAction,
  statusPageHtml,
  statusPageUrl,
} from '../../src/main/status-page.js';
import { START_FAILURE_REASONS } from '../../src/shared/protocol.js';

const decode = (url: string): string => {
  const comma = url.indexOf(',');
  return Buffer.from(url.slice(comma + 1), 'base64').toString('utf8');
};

describe('status page', () => {
  it('has a fixed text for starting, every start failure, port, retries, early exit, AI app, missing files', () => {
    expect([...STATUS_KINDS].sort()).toEqual(
      [
        'starting',
        ...START_FAILURE_REASONS,
        'port',
        'retries',
        'exited',
        'ai_app',
        'missing_files',
        'changed_files',
        // OD-M (WIN-DESK-2): the Windows data folder is open to other people.
        'shared_data_folder',
      ].sort(),
    );
    for (const kind of STATUS_KINDS) {
      expect(STATUS_COPY[kind].heading.length).toBeGreaterThan(0);
      expect(STATUS_COPY[kind].body.length).toBeGreaterThan(0);
    }
  });

  it('uses plain words only (11 §5)', () => {
    const all = JSON.stringify(STATUS_COPY).toLowerCase();
    for (const word of ['wallet', 'gas', 'seed phrase', 'transaction', 'stderr', 'exit code']) {
      expect(all).not.toContain(word);
    }
  });

  it('is a data: page with a strict CSP and no script, form, frame or remote reference', () => {
    for (const kind of STATUS_KINDS) {
      const url = statusPageUrl(kind);
      expect(url.startsWith('data:text/html;charset=utf-8;base64,')).toBe(true);
      expect(isStatusPageUrl(url)).toBe(true);
      const html = decode(url);
      expect(html).toBe(statusPageHtml(kind));
      expect(html).toContain(
        `<meta http-equiv="Content-Security-Policy" content="${STATUS_PAGE_CSP}">`,
      );
      expect(html.toLowerCase()).not.toMatch(
        /<script|<form|<iframe|<object|<embed|<link|src=|https:/,
      );
      expect(html).toContain(STATUS_COPY[kind].heading.replace(/'/g, '&#39;'));
    }
    expect(STATUS_PAGE_CSP).toContain("default-src 'none'");
    expect(STATUS_PAGE_CSP).not.toContain('script-src');
  });

  it('shows Try again and Open log folder on failure pages, not while starting', () => {
    const starting = statusPageHtml('starting');
    expect(starting).not.toContain(STATUS_ACTION_URLS['try-again']);
    for (const kind of STATUS_KINDS.filter((k) => k !== 'starting')) {
      const html = statusPageHtml(kind);
      expect(html).toContain(`href="${STATUS_ACTION_URLS['try-again']}"`);
      expect(html).toContain(`href="${STATUS_ACTION_URLS['open-log-folder']}"`);
    }
  });

  it('recognises only the two exact action URLs', () => {
    expect(statusAction(STATUS_ACTION_URLS['try-again'])).toBe('try-again');
    expect(statusAction(STATUS_ACTION_URLS['open-log-folder'])).toBe('open-log-folder');
    for (const url of [
      `${STATUS_ACTION_URLS['try-again']}?x=1`,
      `${STATUS_ACTION_URLS['try-again']}#x`,
      'http://agentlink.invalid/',
      'http://agentlink.invalid/other',
      'https://agentlink.invalid/try-again',
      'http://localhost:4567/try-again',
      'agentlink://try-again',
    ]) {
      expect(statusAction(url)).toBeNull();
    }
  });

  it('the action host can never resolve (reserved .invalid)', () => {
    for (const url of Object.values(STATUS_ACTION_URLS)) {
      expect(new URL(url).hostname.endsWith('.invalid')).toBe(true);
    }
  });

  it('isStatusPageUrl is false for anything that is not one of the fixed pages', () => {
    expect(isStatusPageUrl('http://localhost:4567/?t=x')).toBe(false);
    expect(isStatusPageUrl('data:text/html,<p>hi</p>')).toBe(false);
    expect(isStatusPageUrl('data:text/html;charset=utf-8;base64,PHA+aGk8L3A+')).toBe(false);
  });
});

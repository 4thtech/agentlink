// M1-36e (11 §5.1, finding F14): the user guide (docs-site/guide, the default pages a user reads)
// and the local approval page (packages/node/src/approval-page.ts) stay inside the default
// vocabulary. The approval page is linted here because packages/node cannot import the list. The technical docs (docs-site/technical) are the "Advanced"
// side and are not linted. The banned terms are the CLI's list (apps/cli/src/vocabulary.ts), so the
// terminal and the guide use one source.
//
// Only prose is linted: fenced and inline code, link targets, HTML comments and command lines are
// removed first. Exceptions are listed in ALLOWED, each with its reason; an entry that no longer
// matches fails, so the list cannot outlive the text it excuses.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lintVocabulary } from '../apps/cli/src/vocabulary.ts';
import { APP_JS, EXPIRED_HTML, UI_STRINGS, pageHtml } from '../packages/node/src/approval-page.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = join(root, 'docs-site/guide');

/**
 * Reviewed exceptions: a guide page (relative to docs-site/guide) → the terms it may use, and why.
 * Keep each entry to the page and the term that need it.
 */
const ALLOWED = [
  {
    page: 'get-started/README.md',
    terms: ['MCP', 'harness/envelope'],
    reason:
      'the "How it connects: MCP" section is the developer context 11 §5.1 allows: it names the protocol and links the harness configuration reference',
  },
  {
    page: 'get-started/other-ai-apps.md',
    terms: ['MCP'],
    reason:
      'this page is for AI apps that add tools "through MCP": the apps label the setting that way, so the reader has to recognise the word',
  },
  {
    page: 'help/faq.md',
    terms: ['MCP', 'address'],
    reason:
      'the compatibility answer says which apps support MCP tools (developer context), and "web address" means a website, not an agent address',
  },
  {
    page: 'help/glossary.md',
    terms: ['MCP', 'nostr/relay'],
    reason:
      'the glossary defines "MCP" (how AI apps plug in tools) and "Relay" (an open message server) in plain words, so it has to name them',
  },
  {
    page: 'get-started/gemini-cli.md',
    terms: ['policy'],
    reason: 'cites the "Gemini CLI policy engine", the name of a third-party feature and its page',
  },
  {
    page: 'get-started/opencode-and-antigravity.md',
    terms: ['harness/envelope'],
    reason: 'links the harness configuration reference by its page name (technical docs)',
  },
  {
    page: 'everyday-use/allowed-folders.md',
    terms: ['password'],
    reason:
      "names the user's own saved passwords in ~/Library/Keychains, not one of our codes (§5.5)",
  },
  {
    page: 'apps/desktop-app.md',
    terms: ['password'],
    reason: "the operating system's device password, not one of our codes (§5.5)",
  },
  {
    page: 'get-started/protect-your-approvals.md',
    terms: ['owner key'],
    reason:
      'the security note on what changing the code does not protect (old copies of the saved owner key) needs the exact term to stay honest (04 §2.5, 11 §5.3)',
  },
  {
    page: 'privacy-and-security.md',
    terms: ['address'],
    reason: 'an IP (connection) address, not an agent address',
  },
  {
    page: 'pricing.md',
    terms: ['network name', 'token'],
    reason:
      'the "how credits are paid" section names the stablecoins and the network a top-up method needs (11 §5.1 D-111, §6.7)',
  },
];

/** Every Markdown page of the guide, relative to docs-site/guide. */
function pages(dir = GUIDE) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return pages(path);
    return path.endsWith('.md') ? [relative(GUIDE, path).split('\\').join('/')] : [];
  });
}

/** The prose of a guide page: code, link targets, comments and command lines removed. */
function guideProse(markdown) {
  return markdown
    .replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .split('\n')
    .filter((line) => !/^\s*(npx|agentlink) /.test(line))
    .join('\n');
}

const allowFor = (page) => ALLOWED.filter((a) => a.page === page).flatMap((a) => a.terms);

describe('user guide vocabulary (M1-36e, 11 §5.1)', () => {
  const all = pages();

  it('finds the guide pages', () => {
    expect(all.length).toBeGreaterThan(20);
    expect(all).toContain('get-started/README.md');
  });

  it('no guide page uses a banned term outside its reviewed exceptions', () => {
    const bad = all.flatMap((page) => {
      const prose = guideProse(readFileSync(join(GUIDE, page), 'utf8'));
      return lintVocabulary(prose, allowFor(page)).map((term) => `${page}: "${term}"`);
    });
    expect(bad).toEqual([]);
  });

  it('every exception has a reason and still matches its page', () => {
    for (const entry of ALLOWED) {
      expect(entry.reason.length, entry.page).toBeGreaterThan(20);
      expect(all, entry.page).toContain(entry.page);
      const found = lintVocabulary(guideProse(readFileSync(join(GUIDE, entry.page), 'utf8')));
      for (const term of entry.terms) {
        expect(found, `${entry.page}: "${term}" is no longer used, remove the exception`).toContain(
          term,
        );
      }
    }
  });
});

describe('approval page vocabulary (M1-36e, 11 §5.1)', () => {
  /** The visible text of a page: tags removed (a `<code>` command stays out of the prose). */
  const visible = (html) => html.replace(/<code>[\s\S]*?<\/code>/g, ' ').replace(/<[^>]*>/g, ' ');

  it('no approval page text uses a banned term', () => {
    const texts = [
      ...Object.entries(UI_STRINGS).map(([key, text]) => [`UI_STRINGS.${key}`, text]),
      ['EXPIRED_HTML', visible(EXPIRED_HTML)],
      ['pageHtml', visible(pageHtml('abc'))],
    ];
    expect(texts.length).toBeGreaterThan(40);
    const bad = texts.flatMap(([where, text]) =>
      lintVocabulary(text).map((term) => `${where}: "${term}"`),
    );
    expect(bad).toEqual([]);
  });

  it('the page script shows only the UI_STRINGS texts', () => {
    // Every sentence the script can show comes from S (UI_STRINGS), checked above.
    expect(APP_JS).toContain(JSON.stringify(UI_STRINGS));
  });

  it('a planted violation in the page text is caught (self-test)', () => {
    const planted = { ...UI_STRINGS, planted: 'Sign the transaction in your wallet.' };
    const bad = Object.values(planted).flatMap((text) => lintVocabulary(text));
    expect(bad).toEqual(['wallet', 'transaction']);
  });
});

describe('the guide lint itself (self-test)', () => {
  it('fails on a planted violation', () => {
    const planted = guideProse('Pay the gas from your wallet.\n');
    expect(lintVocabulary(planted)).toEqual(['wallet', 'gas']);
  });

  it('code, link targets and command lines are not prose', () => {
    const page = [
      'See [the list](https://example.test/wallet-addresses).',
      '`agentlink policy show`',
      '```json',
      '{ "mcpServers": {} }',
      '```',
      '   npx -y @4thtech-io/agentlink init --harness codex',
      '<!-- relay notes -->',
    ].join('\n');
    expect(lintVocabulary(guideProse(page))).toEqual([]);
  });

  it('an exception covers only its own page', () => {
    expect(allowFor('pricing.md')).toContain('token');
    expect(allowFor('everyday-use/messages.md')).toEqual([]);
  });
});

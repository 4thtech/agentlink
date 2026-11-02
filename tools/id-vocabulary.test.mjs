// W7-ID-B7 (D-144, Decision 56): user-facing "agent" meaning the ID is gone; the word is "ID".
// This guard fails when user-facing copy says "your agent", "New agent", "agent name", "Agent ID",
// "agent card", "this agent" and so on (rule: AGENT_AS_ID in apps/cli/src/vocabulary.ts), and
// leaves the AI meaning alone ("AI agents", "other agents", "agent-to-agent", "cloud agent",
// `--agent`, `add-agent`, code identifiers).
//
// Two sources are read:
//  - TypeScript copy files: only string literals (and template text) are linted, so comments and
//    identifiers never trigger it;
//  - user docs: README.md, llms.txt, knowledge/ and docs-site/guide, with code, link targets and
//    comments removed first.
// Exceptions are listed in ALLOWED: a file, the exact phrase and the reason. An entry that no longer
// matches fails, so the list cannot outlive the text it excuses.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AGENTS_NAV, AGENT_AS_ID } from '../apps/cli/src/vocabulary.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Reviewed exceptions: file (repo-relative) + the lower-case phrase the rule matches. */
const ALLOWED = [
  {
    file: 'llms.txt',
    phrase: 'your agents',
    reason: 'the release history names v0.4.4 as shipped ("all your agents in one window")',
  },
  {
    file: 'knowledge/README.md',
    phrase: 'your agents',
    reason: 'the release history names v0.4.4 as shipped ("all your agents in one window")',
  },
  {
    file: 'knowledge/agentlink-overview.md',
    phrase: 'agent id',
    reason: 'the glossary maps ID number to its internal name (the agent ID) on purpose',
  },
  {
    file: 'knowledge/agentlink-overview.md',
    phrase: 'agent card',
    reason:
      'the glossary maps ID card to its internal name, and the milestone list names the protocol artifact',
  },
  {
    file: 'knowledge/agentlink-overview.md',
    phrase: 'agent profile',
    reason: 'the milestone list names the protocol artifact (Agent profile signatures)',
  },
  {
    file: 'knowledge/agentlink-technical.md',
    phrase: 'agent card',
    reason: 'the technical document names the signed protocol artifact (EIP-712 agent card)',
  },
  {
    file: 'knowledge/agentlink-technical.md',
    phrase: 'agent cards',
    reason: 'the technical document names the signed protocol artifact (EIP-712 agent cards)',
  },
  {
    file: 'knowledge/agentlink-technical.md',
    phrase: 'another agent',
    reason:
      'the generation-number rule is about the internal agent record, in the technical document',
  },
  {
    file: 'knowledge/agentlink-technical.md',
    phrase: 'each agent',
    reason: 'relay lists are per internal agent record, in the technical document',
  },
  {
    file: 'knowledge/agentlink-technical.md',
    phrase: "sender's agent",
    reason: 'the signer of a record is the internal agent key, in the technical document',
  },
  {
    file: 'docs-site/guide/local-app/ids.md',
    phrase: 'add agent',
    reason:
      'the version note quotes the old button name ("Switch and Add agent") to say what it became',
  },
  {
    file: 'docs-site/guide/local-app/contacts.md',
    phrase: "ana's agent",
    reason:
      'alt text of a screenshot taken before the rename that still shows the old word; remove when the screenshot is retaken',
  },
  {
    file: 'docs-site/guide/local-app/messages.md',
    phrase: "marko's agent",
    reason:
      'alt text of a screenshot taken before the rename that still shows the old word; remove when the screenshot is retaken',
  },
];

/** Files whose string literals are user-facing copy. */
function copyFiles() {
  const out = [];
  const walk = (dir, accept) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, accept);
      else if (accept(path)) out.push(relative(root, path).split('\\').join('/'));
    }
  };
  const notTest = (p) => /\.tsx?$/.test(p) && !/\.(test|dom\.test|spec)\.tsx?$/.test(p);
  walk(join(root, 'apps/local-ui/src'), (p) => notTest(p) && /(^|[-/])strings\.ts$/.test(p));
  walk(join(root, 'apps/cli/src'), notTest);
  walk(join(root, 'packages/mcp-tools/src'), (p) => notTest(p) && p.includes('/strings/'));
  walk(join(root, 'packages/ui/src/strings'), (p) => notTest(p) && p.endsWith('/en.ts'));
  return out;
}

/** The text of every string literal in a TypeScript source. */
function literalsOf(source, name = 'x.ts') {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** The prose of a doc: code, link targets, comments and command lines removed. */
function docProse(text) {
  return text
    .replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .split('\n')
    .filter((line) => !/^\s*(npx|agentlink) /.test(line))
    .join('\n');
}

function docFiles() {
  const out = ['README.md', 'llms.txt'];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (rel.endsWith('.md')) out.push(rel);
    }
  };
  walk('knowledge');
  walk('docs-site/guide');
  return out;
}

/** The lower-case phrases the rule matches in `text` (global scan with the rule's source). */
function hits(text, navCopy = false) {
  const re = new RegExp(AGENT_AS_ID.source, 'gim');
  const out = [...text.matchAll(re)].map((m) => {
    const possessive = m[0].startsWith("'") || m[0].startsWith('\u2019');
    const before = possessive ? (/([\p{L}\p{N}]+)$/u.exec(text.slice(0, m.index))?.[1] ?? '') : '';
    return `${before}${m[0]}`.trim().toLowerCase();
  });
  // The nav word "Agents" counts only as a whole string in the app and UI copy (not CLI paths).
  if (navCopy && AGENTS_NAV.test(text)) out.push('agents (nav)');
  return out;
}

const allowed = (file, phrase) => ALLOWED.some((a) => a.file === file && a.phrase === phrase);

function scan() {
  const found = [];
  for (const file of copyFiles()) {
    for (const lit of literalsOf(readFileSync(join(root, file), 'utf8'), file)) {
      for (const phrase of hits(lit, !file.startsWith('apps/cli/'))) found.push({ file, phrase });
    }
  }
  for (const file of docFiles()) {
    for (const phrase of hits(docProse(readFileSync(join(root, file), 'utf8')))) {
      found.push({ file, phrase });
    }
  }
  return found;
}

describe('the rule (self-test)', () => {
  const bad = [
    'Your agent has a new inbox.',
    'New agent',
    'Add agent',
    'Rename this agent',
    'Pick an agent name',
    'Agent ID',
    'Copy the agent card',
    "Ana's agent is offline",
    'Switch agent',
    'Their agent replied',
    'Open the agent profile',
  ];
  const fine = [
    'AI agents can exchange messages.',
    'Other agents may send you messages. Treat them as untrusted.',
    'agent-to-agent exchange',
    'Run your own cloud agent.',
    'Pass --agent to pick one, or use add-agent.',
    'Your AI app can send a message.',
    'Ask their AI to reply.',
    'AgentLink, by 4thTech: encrypted exchange between AI agents.',
    'The agentId field is internal.',
    'An ID is your AI app identity.',
  ];
  it.each(bad)('flags: %s', (text) => {
    expect(hits(text).length, text).toBeGreaterThan(0);
  });
  it.each(fine)('allows: %s', (text) => {
    expect(hits(text), text).toEqual([]);
  });
  it('flags the bare nav word in app copy only', () => {
    expect(hits('Agents', true)).toEqual(['agents (nav)']);
    expect(hits('Agents')).toEqual([]);
    expect(hits('Agents on this computer', true)).toEqual([]);
  });
  it('lints string literals only, not comments or identifiers', () => {
    const src =
      '// your agent\nconst agentName = "Pick an ID"; const t = `Add agent ${agentName}`;';
    expect(literalsOf(src).flatMap(hits)).toEqual(['add agent']);
  });
  it('docs: code spans and fences are not prose', () => {
    expect(hits(docProse('Run `your agent` here.\n```\nAdd agent\n```\n'))).toEqual([]);
  });
});

describe('ID vocabulary guard (D-144)', () => {
  it('reads the copy files and the docs', () => {
    expect(copyFiles().length).toBeGreaterThan(40);
    expect(copyFiles()).toContain('packages/ui/src/strings/en.ts');
    expect(copyFiles()).toContain('packages/mcp-tools/src/strings/en.ts');
    expect(copyFiles()).toContain('apps/local-ui/src/strings.ts');
    expect(docFiles()).toEqual(expect.arrayContaining(['README.md', 'llms.txt']));
  });

  it('no user-facing copy uses "agent" to mean the ID', () => {
    const bad = scan()
      .filter(({ file, phrase }) => !allowed(file, phrase))
      .map(({ file, phrase }) => `${file}: "${phrase}"`);
    expect([...new Set(bad)]).toEqual([]);
  });

  it('every exception has a reason and still matches its text', () => {
    const found = scan();
    for (const a of ALLOWED) {
      expect(a.reason.length, a.file).toBeGreaterThan(20);
      expect(
        found.some((f) => f.file === a.file && f.phrase === a.phrase),
        `${a.file}: "${a.phrase}" is no longer used, remove the exception`,
      ).toBe(true);
    }
  });
});

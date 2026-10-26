// Project status as one source (docs/status.yaml) and the documents generated from it.
//
// Generated blocks sit between `<!-- NAME:start -->` and `<!-- NAME:end -->` marker lines. The
// generator rewrites what is between them; the check mode fails when any block differs from what
// the source renders (so drift between the source and README, the docs site or the knowledge base
// fails CI, instead of relying on someone remembering).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.mjs';

export const STATUS_FILE = 'docs/status.yaml';
const STATES = ['done', 'in-progress', 'planned'];
const REPO = 'https://github.com/4thtech/agentlink';
const SITE_STATUS_PAGE = 'docs-site/technical/project/status-and-roadmap.md';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// --- Validation -----------------------------------------------------------------------------------

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isList = (v) => Array.isArray(v);

/** Returns a list of problems with the parsed status data (empty when it is valid). */
export function validateStatus(data) {
  const problems = [];
  const need = (obj, keys, where) => {
    for (const key of keys) {
      if (!isText(obj?.[key])) problems.push(`${where}: "${key}" is required and must be text`);
    }
  };
  const state = (obj, where) => {
    if (!STATES.includes(obj?.state)) {
      problems.push(`${where}: state must be one of ${STATES.join(', ')} (got "${obj?.state}")`);
    }
  };

  need(data, ['updated', 'version', 'versionLabel', 'milestone', 'phase'], 'status');
  need(data, ['inProgress', 'notYet', 'next'], 'status');
  if (isText(data.updated) && !/^\d{4}-\d{2}-\d{2}$/.test(data.updated)) {
    problems.push(`status: "updated" must be YYYY-MM-DD (got "${data.updated}")`);
  }
  if (isText(data.version) && !/^v\d+\.\d+\.\d+$/.test(data.version)) {
    problems.push(`status: "version" must look like v0.0.1 (got "${data.version}")`);
  }

  if (!isList(data.areas) || data.areas.length === 0) {
    problems.push('status: "areas" must be a non-empty list');
  } else {
    const ids = new Set();
    for (const area of data.areas) {
      const where = `area ${area?.id ?? '?'}`;
      need(area, ['id', 'title', 'intro'], where);
      if (ids.has(area?.id)) problems.push(`${where}: duplicate area id`);
      ids.add(area?.id);
      if (!isList(area?.components) || area.components.length === 0) {
        problems.push(`${where}: "components" must be a non-empty list`);
        continue;
      }
      for (const c of area.components) {
        const cw = `${where} / ${c?.name ?? '?'}`;
        need(c, ['name', 'summary'], cw);
        state(c, cw);
        for (const pr of c.prs ?? []) {
          if (!/^(\d+|contracts#\d+)$/.test(pr)) {
            problems.push(`${cw}: pull request "${pr}" must be a number or contracts#N`);
          }
        }
        if (c.prs !== undefined && !isList(c.prs)) problems.push(`${cw}: "prs" must be a list`);
      }
    }
  }

  const deploy = data.deploy;
  for (const key of ['testnet', 'mainnet', 'services']) {
    need(deploy?.[key], ['state', 'note'], `deploy.${key}`);
  }

  if (!isList(data.roadmap) || data.roadmap.length === 0) {
    problems.push('status: "roadmap" must be a non-empty list');
  } else {
    for (const m of data.roadmap) {
      const where = `milestone ${m?.id ?? '?'}`;
      need(m, ['id', 'name', 'version', 'duration', 'outcome', 'gate'], where);
      state(m, where);
    }
    if (
      isText(data.milestone) &&
      !data.roadmap.some((m) => `${m.id} ${m.name}` === data.milestone)
    ) {
      problems.push(
        `status: "milestone" ("${data.milestone}") must be a roadmap entry as "<id> <name>"`,
      );
    }
  }

  // Public-safe (the repository is public): no addresses, keys or long hex strings.
  const text = JSON.stringify(data);
  if (/0x[0-9a-fA-F]{40}/.test(text) || /\b[0-9a-fA-F]{64}\b/.test(text)) {
    problems.push(
      'status: contains an address or a 32-byte hex string; keep the status public-safe',
    );
  }
  return problems;
}

// --- Rendering ------------------------------------------------------------------------------------

const prLink = (pr) => (/^\d+$/.test(pr) ? `[#${pr}](${REPO}/pull/${pr})` : pr);
const prList = (c) => (c.prs?.length ? c.prs.map(prLink).join(', ') : '');
const longDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const stateWord = (s) => ({ done: 'Done', 'in-progress': 'In progress', planned: 'Planned' })[s];

/** README: the Status blockquote (short, for a landing page: the full component list lives on the docs site). */
export function renderReadmeStatus(data) {
  const all = data.areas.flatMap((area) => area.components);
  const count = (state) => all.filter((c) => c.state === state).length;
  const parts = [
    [count('done'), 'merged'],
    [count('in-progress'), 'in progress'],
    [count('planned'), 'planned'],
  ]
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`);
  const out = [
    `**Version:** ${data.version} (${data.versionLabel}) · **Milestone:** ${data.milestone} · **Last updated:** ${data.updated}`,
    '',
    `- **Components:** ${parts.join(', ')}`,
    `- **Next:** ${data.next}`,
    '',
    `Every component, with its pull requests, and what does not exist yet, is on the [status and roadmap page](${SITE_STATUS_PAGE}). This section is generated from [\`docs/status.yaml\`](docs/status.yaml) (\`node tools/docs-status/index.mjs\`) and checked in CI.`,
  ];
  return out.map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
}

/** README: the roadmap table (compact: the gates are on the docs site). */
export function renderReadmeRoadmap(data) {
  const rows = data.roadmap.map((m) => {
    const note = m.state !== 'planned' && m.stateNote ? ` (${m.stateNote})` : '';
    return `| **${m.id} ${m.name}**${note} | ${m.outcome} | ${m.version} |`;
  });
  return ['| Milestone | What you can do at the end | Version |', '|---|---|---|', ...rows].join(
    '\n',
  );
}

/** Docs site: the milestone gates in full (what the README roadmap used to carry). */
export function renderSiteRoadmapDetail(data) {
  const rows = data.roadmap.map((m) => {
    const note = m.state !== 'planned' && m.stateNote ? ` (${m.stateNote})` : '';
    const gate = m.progress ? `${m.gate} ${m.progress}` : m.gate;
    return `| **${m.id} ${m.name}**${note} | ${gate} |`;
  });
  return ['| Milestone | Gate and progress |', '|---|---|', ...rows].join('\n');
}

/** Docs site and knowledge base: the "Status: Current as of" line. */
export function renderSiteHint(data) {
  return `> **Status: Current as of ${longDate(data.updated)} (${data.versionLabel}, ${data.version}).** Derived from the [build plan](${REPO}/blob/main/docs/foundation/10-build-plan.md) and updated at every milestone. Durations are indicative, not commitments.`;
}

/** Docs site and knowledge base: where we are, the deploy state and the component table. */
export function renderSiteSummary(data) {
  const out = [
    `**Phase:** ${data.phase}. The repository [README](${REPO}#status) carries the same status; both are generated from one source file, [\`docs/status.yaml\`](${REPO}/blob/main/docs/status.yaml).`,
    '',
    `**Not yet:** ${data.notYet}`,
    '',
    `**Testnet:** ${data.deploy.testnet.note} **Mainnet:** ${data.deploy.mainnet.note} **Services:** ${data.deploy.services.note}`,
    '',
    `**In progress:** ${data.inProgress}`,
    '',
    `**Next:** ${data.next}`,
    '',
    '### Components',
    '',
    'Code that is merged is not necessarily published: only the `@4thtech-io/agentlink` command-line package is on npm; the libraries are bundled into it.',
    '',
    '| Area | Component | State | Pull requests | What it is |',
    '|---|---|---|---|---|',
  ];
  for (const area of data.areas) {
    for (const c of area.components) {
      out.push(
        `| ${area.title} | ${c.name} | ${stateWord(c.state)} | ${prList(c) || '-'} | ${c.summary.replaceAll('|', '\\|')} |`,
      );
    }
  }
  return out.join('\n');
}

/** Docs site and knowledge base: the milestones table. */
export function renderSiteMilestones(data) {
  const rows = data.roadmap.map(
    (m) =>
      `| **${m.id}** ${m.name} | ${m.outcome} | ${m.version} | ${m.duration} | ${stateWord(m.state)} |`,
  );
  return [
    '| Stage | What you can do at the end | Version | Indicative duration | Status |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

/** Knowledge base: the opening paragraph (plain language, short: the base has a size budget). */
export function renderKnowledgeIntro(data) {
  const open = data.roadmap.filter((m) => m.state !== 'planned');
  const names = open.map(
    (m) => `${m.id} (${m.name.toLowerCase()}) is ${m.stateNote ?? 'in progress'}`,
  );
  return `AgentLink is pre-alpha, last updated ${longDate(data.updated)}, version ${data.version}. ${names.join(' and ')}. The released CLI installs with \`npx -y @4thtech-io/agentlink init\`. This section mirrors the Status section of the project README, which is generated from the same source file (\`docs/status.yaml\`).`;
}

/** Knowledge base: where things stand, one line per area (done, in progress, planned). */
export function renderKnowledgeSummary(data) {
  const out = ['## Where things stand', ''];
  for (const area of data.areas) {
    const by = (state) => area.components.filter((c) => c.state === state).map((c) => c.name);
    const parts = [
      ['Merged', by('done')],
      ['In progress', by('in-progress')],
      ['Planned', by('planned')],
    ]
      .filter(([, names]) => names.length > 0)
      .map(([label, names]) => `${label}: ${names.join('; ')}.`);
    out.push(`- **${area.title}.** ${area.intro} ${parts.join(' ')}`);
  }
  out.push(
    `- **Testnet:** ${data.deploy.testnet.note}`,
    `- **Mainnet:** ${data.deploy.mainnet.note}`,
    `- **In progress:** ${data.inProgress}`,
    `- **Does not exist yet:** ${data.notYet}`,
  );
  return out.join('\n');
}

/** Knowledge base: the milestones table. */
export function renderKnowledgeMilestones(data) {
  const status = (m) => {
    if (m.state === 'planned') return 'Planned';
    const word = m.stateNote ?? stateWord(m.state);
    return `${word[0].toUpperCase()}${word.slice(1)}`;
  };
  const rows = data.roadmap.map(
    (m) => `| ${m.id} ${m.name} | ${m.version} | ${m.outcome} | ${status(m)} |`,
  );
  return [
    '| Milestone | Planned version | What it delivers | Status |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

// --- Targets: which file gets which block ----------------------------------------------------------

// --- Backlog card counts ----------------------------------------------------------------------------
// Card counts are derived from the card headings on demand (`index.mjs --counts`) and are NOT
// committed: a committed count goes stale whenever another PR merges first (CHORE-BACKLOG-COUNTS-QUEUE).
// A card is a `#### <ID> · title` heading outside a code fence (so the §1 format example is not
// one). Not counted: split parents (Status starts with "split into", their parts are counted) and
// cards whose Phase starts with "later" (not in a milestone). M1 cards split into M1a and M1b by
// the first word of their `**Phase:**` field.

const BACKLOG_FILE = 'docs/process/backlog.md';

/** Counts cards per section: { M0, M1a, M1b, M1, M2, M3 } (M1 is M1a + M1b + M1 cards with no phase). */
export function countBacklogCards(text) {
  const lines = text.split('\n');
  const counts = { M0: 0, M1a: 0, M1b: 0, M1: 0, M2: 0, M3: 0 };
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('```')) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#### (M[0-3])-\S+/.exec(lines[i]);
    if (!heading) continue;
    let status = '';
    let phase = '';
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('#'); j += 1) {
      status = status || (/\*\*Status:\*\*\s*(.*)$/.exec(lines[j])?.[1] ?? '');
      phase = phase || (/\*\*Phase:\*\*\s*(.*)$/.exec(lines[j])?.[1] ?? '');
      if (status && phase) break;
    }
    if (/^split into/i.test(status) || /^later/i.test(phase)) continue;
    const section = heading[1];
    if (section === 'M1') {
      const word = /^M1([ab])\b/.exec(phase);
      if (word) counts[`M1${word[1]}`] += 1;
      counts.M1 += 1;
    } else {
      counts[section] += 1;
    }
  }
  return counts;
}

/** Plain-text summary of the counts, printed on demand by `index.mjs --counts` (never committed). */
export function formatBacklogCounts(c) {
  return [
    `M0 Foundations: ${c.M0}`,
    `M1 Local beta: ${c.M1} (M1a ${c.M1a}, M1b ${c.M1b})`,
    `M2 Console, desktop apps, self-host, design: ${c.M2}`,
    `M3 Mainnet beta: ${c.M3}`,
  ].join('\n');
}

/** Reads the backlog from `root` and returns its counts text, or null when the file is absent. */
export function backlogCountsText(root) {
  const text = readIfPresent(join(root, BACKLOG_FILE));
  return text === null ? null : formatBacklogCounts(countBacklogCards(text));
}

// --- Targets ---------------------------------------------------------------------------------------

/**
 * `optional` targets (the knowledge overview) are skipped when the
 * file is absent or carries none of the markers; once a file has the markers they are enforced.
 */
export const TARGETS = [
  {
    file: 'README.md',
    blocks: { status: renderReadmeStatus, roadmap: renderReadmeRoadmap },
  },
  {
    file: 'docs-site/technical/project/status-and-roadmap.md',
    blocks: {
      'status-hint': renderSiteHint,
      'status-summary': renderSiteSummary,
      'status-milestones': renderSiteMilestones,
      'status-roadmap-detail': renderSiteRoadmapDetail,
    },
  },
  {
    file: 'knowledge/agentlink-overview.md',
    optional: true,
    blocks: {
      'status-intro': renderKnowledgeIntro,
      'status-summary': renderKnowledgeSummary,
      'status-milestones': renderKnowledgeMilestones,
    },
  },
];

const startMarker = (name) => `<!-- ${name}:start -->`;
const endMarker = (name) => `<!-- ${name}:end -->`;

/**
 * Replaces the body between a block's markers. Returns { text } or { error } or { missing: true }
 * when the markers are absent.
 */
export function replaceBlock(text, name, rendered) {
  const start = startMarker(name);
  const end = endMarker(name);
  const first = text.indexOf(start);
  if (first === -1 && text.indexOf(end) === -1) return { missing: true };
  if (first === -1) return { error: `has "${end}" but no "${start}"` };
  if (text.indexOf(start, first + 1) !== -1) return { error: `has "${start}" more than once` };
  const last = text.indexOf(end, first);
  if (last === -1) return { error: `has "${start}" but no "${end}" after it` };
  if (text.indexOf(end, last + 1) !== -1) return { error: `has "${end}" more than once` };
  return { text: `${text.slice(0, first + start.length)}\n${rendered}\n${text.slice(last)}` };
}

/** README badge: the milestone badge must name the milestone in the source. */
function checkBadge(data, readme) {
  const m = /\[!\[Milestone: ([^\]]+)\]/.exec(readme);
  if (!m) return 'README.md: the "Milestone:" badge is missing';
  return m[1] === data.milestone
    ? null
    : `README.md: the milestone badge says "${m[1]}" but docs/status.yaml says "${data.milestone}"`;
}

/** The file's text, or null when it does not exist (no separate existence check: no race). */
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Renders every target. In check mode nothing is written. Returns { problems, changed, skipped }:
 * `problems` are failures (drift, missing markers in required files, invalid source), `changed`
 * the files that were (or, in check mode, would be) rewritten, `skipped` informational notes.
 */
export function run({ root, check = false }) {
  const problems = [];
  const changed = [];
  const skipped = [];

  const sourceText = readIfPresent(join(root, STATUS_FILE));
  if (sourceText === null) return { problems: [`${STATUS_FILE} is missing`], changed, skipped };
  let data;
  try {
    data = parseYaml(sourceText);
  } catch (error) {
    return { problems: [error.message], changed, skipped };
  }
  const invalid = validateStatus(data);
  if (invalid.length > 0)
    return { problems: invalid.map((p) => `${STATUS_FILE}: ${p}`), changed, skipped };

  const backlog = readIfPresent(join(root, BACKLOG_FILE));
  if (backlog !== null && /<!-- backlog-counts:(start|end) -->/.test(backlog)) {
    problems.push(
      `${BACKLOG_FILE}: card counts are no longer committed (they conflict between pull requests); remove the backlog-counts block and read the counts with: node tools/docs-status/index.mjs --counts`,
    );
  }

  for (const target of TARGETS) {
    const path = join(root, target.file);
    const original = readIfPresent(path);
    if (original === null) {
      if (target.optional) skipped.push(`${target.file} is absent; skipped`);
      else problems.push(`${target.file} is missing`);
      continue;
    }
    let text = original;
    let applied = 0;
    for (const [name, render] of Object.entries(target.blocks)) {
      const result = replaceBlock(text, name, render(data, original));
      if (result.missing) {
        if (target.optional) skipped.push(`${target.file} has no ${name} markers; skipped`);
        else
          problems.push(
            `${target.file}: missing ${startMarker(name)} / ${endMarker(name)} markers`,
          );
      } else if (result.error) {
        problems.push(`${target.file}: ${result.error}`);
      } else {
        text = result.text;
        applied += 1;
      }
    }
    if (target.file === 'README.md') {
      const badge = checkBadge(data, original);
      if (badge) problems.push(badge);
    }
    if (applied > 0 && text !== original) {
      changed.push(target.file);
      if (check) {
        problems.push(
          target.handEditHint
            ? `${target.file} is out of date (${target.handEditHint}); run: node tools/docs-status/index.mjs`
            : `${target.file} is out of date with ${STATUS_FILE}; run: node tools/docs-status/index.mjs`,
        );
      } else {
        writeFileSync(path, text);
      }
    }
  }
  return { problems, changed, skipped };
}

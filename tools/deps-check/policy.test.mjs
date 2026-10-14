import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findCycle, runChecks } from './check.mjs';
import {
  LIBRARIES,
  NODE_ZONES,
  SUBTLE_ZONES,
  WORKSPACE_NAMES,
  ZONES,
  allowedWorkspaceNames,
  violationFor,
} from './policy.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('policy data', () => {
  it('has unique workspace names', () => {
    expect(new Set(WORKSPACE_NAMES).size).toBe(WORKSPACE_NAMES.length);
  });

  it('only lets a zone use packages that exist, and never an app', () => {
    for (const [zone, { uses }] of Object.entries(ZONES)) {
      for (const short of uses) {
        expect(ZONES[`packages/${short}`], `${zone} uses unknown packages/${short}`).toBeDefined();
      }
    }
  });

  it('keeps the layering acyclic', () => {
    const graph = Object.fromEntries(
      Object.values(ZONES).map(({ name, uses }) => [
        name,
        uses.map((short) => ZONES[`packages/${short}`].name),
      ]),
    );
    expect(findCycle(graph)).toBeNull();
  });

  it('requires a justification on every runtime-dependency entry', () => {
    for (const [zone, { external }] of Object.entries(ZONES)) {
      for (const { pattern, reason } of external) {
        expect(reason?.trim().length, `${zone}: ${pattern} needs a reason`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every library zone and Node zone in the layering table', () => {
    for (const zone of [...NODE_ZONES, ...SUBTLE_ZONES, ...LIBRARIES.flatMap((lib) => lib.zones)]) {
      expect(ZONES[zone], zone).toBeDefined();
    }
  });

  it('follows 04 §8.1 and the M0-10 card for the primitive libraries', () => {
    const zonesOf = (specifier) =>
      Object.keys(ZONES).filter((zone) => violationFor(zone, specifier) === null);
    expect(zonesOf('@noble/curves')).toEqual(['packages/crypto']);
    expect(zonesOf('@hpke/core')).toEqual(['packages/crypto']);
    expect(zonesOf('nostr-tools')).toEqual(['packages/crypto', 'packages/transport-nostr']);
    expect(zonesOf('viem')).toEqual(['packages/crypto', 'packages/chain', 'apps/pay']);
    expect(zonesOf('aws4fetch')).toEqual(['packages/storage']);
    expect(zonesOf('node:fs')).toEqual(NODE_ZONES);
    expect(zonesOf('node:crypto')).toEqual([]);
  });

  it('lets a package import itself and its layer, nothing above or beside it', () => {
    expect(allowedWorkspaceNames('packages/chain')).toEqual([
      '@agentlink/chain',
      '@agentlink/types',
      '@agentlink/log',
      '@agentlink/crypto',
    ]);
    // The logger (M0-8) imports no workspace package, and the trusted base does not import it.
    expect(violationFor('packages/log', '@agentlink/types')).toMatch(/layering/);
    expect(violationFor('packages/crypto', '@agentlink/log')).toMatch(/layering/);
    expect(violationFor('packages/crypto', '@agentlink/core')).toMatch(/layering/);
    expect(violationFor('packages/chain', '@agentlink/storage')).toMatch(/layering/);
    expect(violationFor('packages/core', '@agentlink/node')).toMatch(/layering/);
    expect(violationFor('apps/console', '@agentlink/node')).toMatch(/layering/);
    expect(violationFor('apps/submitter', '@agentlink/ui')).toMatch(/layering/);
    expect(violationFor('packages/core', '@4thtech/agentlink')).toMatch(/layering/);
    expect(violationFor('packages/core', '@agentlink/chain/sub')).toBeNull();
    expect(violationFor(null, '@agentlink/types')).toMatch(/no entry/);
  });
});

describe('the repository itself', () => {
  it('passes every boundary check', () => {
    const { problems, packages } = runChecks(REPO);
    expect(problems).toEqual([]);
    expect(packages).toBeGreaterThan(10);
  });
});

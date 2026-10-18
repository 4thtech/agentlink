// M1-3f (D-19, D-83, AGENTS.md): no Solidity source in this public repository. The OCC v2 contracts
// live in the private 4thtech/occ-v2-contracts; this repository consumes only the exported ABI JSON.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findSolidity,
  hasSolidityPragma,
  isSolidityPath,
  listRepoFiles,
} from './check-no-solidity.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('check-no-solidity', () => {
  it('finds no Solidity file or pragma anywhere in the repository', () => {
    const files = listRepoFiles(root);
    expect(files.length).toBeGreaterThan(100);
    expect(findSolidity(root, files)).toEqual([]);
  });

  it.each(['contracts/OCCNotary.sol', 'a/b/IOCCErrors.SOL', 'x.Sol', 'packages/occ-v2-abi/x.sol'])(
    'flags the path %s',
    (path) => {
      expect(isSolidityPath(path)).toBe(true);
    },
  );

  it.each(['x.solution', 'sol', 'solidity.md', 'abi/IOCCNotary.json', 'a.sol.json'])(
    'does not flag the path %s',
    (path) => {
      expect(isSolidityPath(path)).toBe(false);
    },
  );

  // The pragma is spelled in two parts so this file does not match its own scan.
  const PRAGMA = ['pragma', 'solidity'].join(' ');

  it('flags Solidity source under another extension by its pragma at a line start', () => {
    expect(hasSolidityPragma(`// SPDX-License-Identifier: BUSL-1.1\n${PRAGMA} 0.8.37;\n`)).toBe(
      true,
    );
    expect(hasSolidityPragma(`  ${PRAGMA.replace(' ', '   ')} ^0.8.0;`)).toBe(true);
    expect(hasSolidityPragma('{"abi": [], "compiler": "0.8.37"}')).toBe(false);
    expect(hasSolidityPragma('The contracts use Solidity 0.8.37.')).toBe(false);
    expect(hasSolidityPragma(`a prose mention of \`${PRAGMA}\` mid-line`)).toBe(false);
  });
});

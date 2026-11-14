// WIN-BROKEN-ID: doctor never cuts a fixed sentence (terminalOneLine stops at 128 code points with
// "…"); an ID whose key is missing gets its own Problem line and a Fix line that names the app.
import { NodeKeyStoreError } from '@4thtech-io/node';
import { describe, expect, it } from 'vitest';
import { doctorOpenProblem } from './doctor.js';

describe('doctorOpenProblem (WIN-BROKEN-ID)', () => {
  it('an ID whose key is missing: Problem and Fix, uncut, with the label', () => {
    const error = new NodeKeyStoreError(
      'identity_missing',
      "This agent's identity is not in the system keychain. Restore it from a backup or check the agent name; AgentLink never creates a new identity in its place.",
    );
    const lines = doctorOpenProblem(error, 'Personal') ?? [];
    expect(lines).toEqual([
      `Problem  ID "Personal" can't be opened: its key isn't on this computer.`,
      '         Open AgentLink to restore it from a backup or remove it from this computer.',
    ]);
    for (const line of lines) expect(line).not.toContain('…');
  });

  it('any other long fixed sentence is printed whole (still one sanitised line)', () => {
    const long = `${'A fixed sentence that is long. '.repeat(6)}End.`;
    const lines =
      doctorOpenProblem(new NodeKeyStoreError('keychain_failed', long), 'Personal') ?? [];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`Problem  ${long}`);
    expect(lines[0]).not.toContain('…');
  });

  it('control characters in a label never reach the terminal', () => {
    const error = new NodeKeyStoreError('identity_missing', 'x');
    const [first] = doctorOpenProblem(error, 'Per\u001b[31msonal') ?? [];
    expect(first).not.toContain('\u001b');
  });

  it('an error that is not fixed text has no sentence (doctor prints its own)', () => {
    expect(doctorOpenProblem(new Error('/Users/secret/path'), 'Personal')).toBeUndefined();
  });
});

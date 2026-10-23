// The M1a nextStep text (06 §2.5 step 2, IR-M1-9j-1 F02).
import { encodeBase64url, randomBytes } from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import { cliPrefix } from '../runtime/cli-prefix.js';
import { approveCommand, approvalNextStep, isApprovalId } from './next-step.js';

const P = cliPrefix();
const newId = (): string => `apr_${encodeBase64url(randomBytes(16))}`;

describe('approvalNextStep (06 §2.5 step 2)', () => {
  it('the default agent: the fixed text with `agentlink approve <id>`', () => {
    const id = newId();
    const expected = `Tell the user: Approval needed. In your own terminal, run \`${P} approve ${id}\`. Your AI can't approve this for you. After they approve, call the same tool again with approvalId.`;
    expect(approvalNextStep(id)).toBe(expected);
    expect(approvalNextStep(id, 'default')).toBe(expected);
  });

  it('another agent: `--agent <name>` after the name is checked again', () => {
    const id = newId();
    expect(approvalNextStep(id, 'work')).toContain(`\`${P} approve ${id} --agent work\`.`);
  });

  it.each(['-x', 'Work', 'work\n', 'a b', 'w;id', '$(id)', '', `a${'b'.repeat(32)}`])(
    'a name that fails the pattern (%j) is never inserted; the hint sentence follows instead',
    (name) => {
      const id = newId();
      const text = approvalNextStep(id, name);
      expect(text).toBe(
        `Tell the user: Approval needed. In your own terminal, run \`${P} approve ${id}\`. If you have more than one agent, add --agent with this agent's name. Your AI can't approve this for you. After they approve, call the same tool again with approvalId.`,
      );
      if (name !== '') expect(text).not.toContain(`--agent ${name}`);
    },
  );

  it.each([
    '',
    'apr_',
    'apr_short',
    'apr_$(id)aaaaaaaaaaaaaaaaaaa',
    `x${newId()}`,
    `${newId()}\n`,
    `${newId()} --agent x`,
  ])('refuses to build a command around a malformed approval ID (%j)', (id) => {
    expect(() => approvalNextStep(id)).toThrow("That approval ID isn't valid");
    expect(isApprovalId(id)).toBe(false);
  });

  it('every inserted value is only [A-Za-z0-9_-]: no shell metacharacter, space, quote or newline', () => {
    for (let i = 0; i < 50; i += 1) {
      const { command } = approveCommand(newId(), 'side-project');
      const inserted = command.replace(`${P} approve `, '').replace(' --agent ', '');
      expect(inserted).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('the command prefix (M1-36a)', () => {
  const NPX = 'npx -y @4thtech-io/agentlink';

  it('prints the prefix it is given, with and without --agent', () => {
    const id = newId();
    expect(approveCommand(id, undefined, NPX).command).toBe(`${NPX} approve ${id}`);
    expect(approveCommand(id, 'work', NPX).command).toBe(`${NPX} approve ${id} --agent work`);
    expect(approvalNextStep(id, 'default', NPX)).toContain(`\`${NPX} approve ${id}\`.`);
  });

  it('defaults to the launch-detected prefix, so the printed command always works', () => {
    const id = newId();
    expect(approveCommand(id).command).toBe(`${cliPrefix()} approve ${id}`);
  });
});

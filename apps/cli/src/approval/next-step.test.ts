// The M1a nextStep text (06 §2.5 step 2, IR-M1-9j-1 F02).
import { encodeBase64url, randomBytes } from '@agentlink/crypto';
import { describe, expect, it } from 'vitest';
import { approveCommand, approvalNextStep, isApprovalId } from './next-step.js';

const newId = (): string => `apr_${encodeBase64url(randomBytes(16))}`;

describe('approvalNextStep (06 §2.5 step 2)', () => {
  it('the default agent: the fixed text with `agentlink approve <id>`', () => {
    const id = newId();
    const expected = `Tell the user: Approval needed. In your own terminal, run \`agentlink approve ${id}\`. Your AI can't approve this for you. After they approve, call the same tool again with approvalId.`;
    expect(approvalNextStep(id)).toBe(expected);
    expect(approvalNextStep(id, 'default')).toBe(expected);
  });

  it('another agent: `--agent <name>` after the name is checked again', () => {
    const id = newId();
    expect(approvalNextStep(id, 'work')).toContain(`\`agentlink approve ${id} --agent work\`.`);
  });

  it.each(['-x', 'Work', 'work\n', 'a b', 'w;id', '$(id)', '', `a${'b'.repeat(32)}`])(
    'a name that fails the pattern (%j) is never inserted; the hint sentence follows instead',
    (name) => {
      const id = newId();
      const text = approvalNextStep(id, name);
      expect(text).toBe(
        `Tell the user: Approval needed. In your own terminal, run \`agentlink approve ${id}\`. If you have more than one agent, add --agent with this agent's name. Your AI can't approve this for you. After they approve, call the same tool again with approvalId.`,
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
      const inserted = command.replace(/^agentlink approve /, '').replace(' --agent ', '');
      expect(inserted).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

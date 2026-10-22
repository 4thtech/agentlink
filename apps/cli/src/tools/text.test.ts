// The no-owner text (M1-36a; 11 §5): the right step for the machine's state, a command that works
// after the documented install, and no jargon.
import { describe, expect, it } from 'vitest';
import { noOwnerCard } from './text.js';

const NPX = 'npx -y @4thtech-io/agentlink';

describe('noOwnerCard (M1-36a)', () => {
  it('a new machine: owner init with the npx form by default', () => {
    const { summary } = noOwnerCard('default');
    expect(summary).toBe(
      `AgentLink isn't protected yet. In a terminal you opened yourself, run \`${NPX} owner init\`. Your AI can't do this for you.`,
    );
  });

  it('an owner exists here: owner add-agent for this agent', () => {
    const { summary } = noOwnerCard('writer', { ownerExists: true });
    expect(summary).toContain(`\`${NPX} owner add-agent --agent writer\``);
    expect(summary).not.toContain('owner init');
  });

  it('uses the prefix it is given', () => {
    expect(noOwnerCard('x', { prefix: 'agentlink' }).summary).toContain('`agentlink owner init`');
  });

  it('never says "card" and never inserts an unchecked name', () => {
    for (const s of [
      noOwnerCard().summary,
      noOwnerCard('Bad;rm', { ownerExists: true }).summary,
    ]) {
      expect(s).not.toMatch(/\bcard\b/i);
      expect(s).not.toContain('Bad;rm');
    }
  });
});

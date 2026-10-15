// The local agent-name rule (06 §6, IR-M1-9j-1 F02): `^[a-z][a-z0-9-]{0,31}$`, whole string.
import { describe, expect, it } from 'vitest';
import { AGENT_NAME_PATTERN, DEFAULT_AGENT_NAME, isAgentName } from './agent-name.js';

describe('the agent-name rule (06 §6)', () => {
  it('is the exact pattern, without the m flag', () => {
    expect(AGENT_NAME_PATTERN.source).toBe('^[a-z][a-z0-9-]{0,31}$');
    expect(AGENT_NAME_PATTERN.flags).toBe('');
  });

  it.each(['default', 'a', 'work', 'side-project', 'a1', 'x-', `a${'b'.repeat(31)}`])(
    'accepts %j',
    (name) => {
      expect(isAgentName(name)).toBe(true);
    },
  );

  it.each([
    '',
    '-agent',
    '--agent',
    '1agent',
    'Agent',
    'agEnt',
    `a${'b'.repeat(32)}`,
    'my agent',
    'my_agent',
    'agent.x',
    'agent;rm -rf ~',
    'agent$(id)',
    'agent`id`',
    "agent'",
    'agent"',
    'agent\n',
    'agent\nother',
    '\nagent',
    'agent\r',
    'agent\u0000',
    'agént',
    'аgent', // Cyrillic а
    'agent\u200b',
    ' agent',
    'agent ',
  ])('refuses %j', (name) => {
    expect(isAgentName(name)).toBe(false);
  });

  it('refuses non-strings', () => {
    for (const value of [undefined, null, 1, ['default'], { toString: () => 'default' }]) {
      expect(isAgentName(value)).toBe(false);
    }
  });

  it('the default agent is `default`, a valid name', () => {
    expect(DEFAULT_AGENT_NAME).toBe('default');
    expect(isAgentName(DEFAULT_AGENT_NAME)).toBe(true);
  });
});

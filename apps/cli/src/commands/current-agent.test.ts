// U3-b (USABILITY-WAVE-3 §7.4): which agent a command without `--agent` means. Never a question.
import { describe, expect, it } from 'vitest';
import { chooseCurrentAgent } from './current-agent.js';

const never = (): Promise<boolean> => Promise.resolve(false);
const only =
  (...names: string[]) =>
  (name: string): Promise<boolean> =>
    Promise.resolve(names.includes(name));

describe('chooseCurrentAgent (never asks)', () => {
  it('0 agents: nothing to open', async () => {
    await expect(chooseCurrentAgent([], undefined, never)).resolves.toBeUndefined();
  });

  it('1 agent: that one, whatever app.json says', async () => {
    await expect(chooseCurrentAgent(['solo'], 'other', never)).resolves.toBe('solo');
  });

  it('4 agents: the last used one (app.json) wins', async () => {
    const names = ['agent-a', 'agent-b', 'agent-c', 'default'];
    await expect(chooseCurrentAgent(names, 'agent-c', only('default'))).resolves.toBe('agent-c');
  });

  it('a last used name that is not an agent here (or fails the name rule) is ignored', async () => {
    const names = ['agent-a', 'agent-b'];
    await expect(chooseCurrentAgent(names, 'gone', only('agent-b'))).resolves.toBe('agent-b');
    await expect(chooseCurrentAgent(names, 'Bad Name', never)).resolves.toBe('agent-a');
  });

  it('else the agent an AI app serves, default first', async () => {
    const names = ['agent-a', 'agent-b', 'default'];
    await expect(chooseCurrentAgent(names, undefined, only('agent-b', 'default'))).resolves.toBe(
      'default',
    );
    await expect(chooseCurrentAgent(names, undefined, only('agent-b'))).resolves.toBe('agent-b');
  });

  it('else the first by name', async () => {
    await expect(chooseCurrentAgent(['beta', 'alpha', 'gamma'], undefined, never)).resolves.toBe(
      'alpha',
    );
  });

  it('a check that throws counts as "serves nothing"', async () => {
    const boom = (): Promise<boolean> => Promise.reject(new Error('unreadable'));
    await expect(chooseCurrentAgent(['beta', 'alpha'], undefined, boom)).resolves.toBe('alpha');
  });

  it('names that fail the 06 §6 rule are never chosen', async () => {
    await expect(chooseCurrentAgent(['Bad Name', '-x', 'ok'], undefined, never)).resolves.toBe(
      'ok',
    );
    await expect(chooseCurrentAgent(['Bad Name'], undefined, never)).resolves.toBeUndefined();
  });
});

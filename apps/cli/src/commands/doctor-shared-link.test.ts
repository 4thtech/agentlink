// RELAY-SHARED-CONN L4 (D-159 (11); 11 §5.15): `agentlink doctor` says whether the shared server
// connection is on and how many IDs use it. Counts only (I-7): never a path, a program's name
// or an ID. A notice, never a problem: doctor still exits OK.
import { describe, expect, it } from 'vitest';
import { EXIT_OK, createDispatcher } from '../dispatch.js';
import type { TerminalContext } from '../runtime/guards.js';
import type { OpenedAgent } from '../runtime/open-agent.js';
import { DOCTOR_SHARED_LINK_TEXT, createDoctorHandler, type SharedLinkCheck } from './doctor.js';
import { createDeps } from './shared.js';

const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };

function agent(): OpenedAgent {
  return {
    name: 'default',
    agentId: `0x${'1'.repeat(40)}`,
    paths: {},
    approvals: {},
    client: {
      identity: {
        get: () => Promise.resolve({ card: {} }),
        signedCard: () => Promise.resolve({ relays: ['wss://one.relay-alpha.net'] }),
        sendState: () => Promise.resolve('ready'),
      },
      catchUp: () => Promise.resolve({ partial: false, inbox: [], requests: 0 }),
    },
    close: () => Promise.resolve(),
  } as unknown as OpenedAgent;
}

async function doctor(sharedLink?: SharedLinkCheck): Promise<{ code: number; text: string }> {
  const out: string[] = [];
  const handler = createDoctorHandler({
    ...createDeps({
      open: () => Promise.resolve({ status: 'ok', agent: agent() }),
      home: '/nonexistent-home',
    }),
    ...(sharedLink === undefined ? {} : { sharedLink }),
  });
  const code = await createDispatcher({ doctor: handler })(['doctor'], {
    output: { print: (t) => out.push(t), printError: (t) => out.push(t) },
    terminal: TTY,
    version: '0.0.0',
  });
  return { code, text: out.join('\n') };
}

describe('doctor: shared server connection (11 §5.15)', () => {
  it('the strings are exactly the spec copy', () => {
    expect(DOCTOR_SHARED_LINK_TEXT.on(3)).toBe(
      'OK       Shared server connection: on, 3 IDs\n' +
        '         The IDs on this computer share one connection to each server.',
    );
    expect(DOCTOR_SHARED_LINK_TEXT.on(1).split('\n')[0]).toBe(
      'OK       Shared server connection: on, 1 ID',
    );
    expect(DOCTOR_SHARED_LINK_TEXT.own).toBe(
      'Notice   Shared server connection: on, but this program uses its own connections\n' +
        "         It's an older or newer version, or the connection couldn't be checked. Messages still work.",
    );
    expect(DOCTOR_SHARED_LINK_TEXT.off).toBe(
      'OK       Shared server connection: off\n' +
        '         Turn it on with AGENTLINK_SHARED_RELAYS=1.',
    );
    for (const text of [DOCTOR_SHARED_LINK_TEXT.on(2), DOCTOR_SHARED_LINK_TEXT.own]) {
      for (const word of ['relay', 'wallet', 'gas', 'transaction', 'socket', 'token']) {
        expect(text.toLowerCase()).not.toContain(word);
      }
    }
  });

  it('prints the on line with the count, and exits OK', async () => {
    const seen = await doctor(() => Promise.resolve({ on: true, programs: 2 }));
    expect(seen.code).toBe(EXIT_OK);
    expect(seen.text).toContain(DOCTOR_SHARED_LINK_TEXT.on(2));
  });

  it('prints the off line', async () => {
    const seen = await doctor(() => Promise.resolve({ on: false }));
    expect(seen.code).toBe(EXIT_OK);
    expect(seen.text).toContain(DOCTOR_SHARED_LINK_TEXT.off);
  });

  it('on but not reachable is a notice, never a problem; a failing check is the notice too', async () => {
    const own = await doctor(() => Promise.resolve({ on: true }));
    expect(own.code).toBe(EXIT_OK);
    expect(own.text).toContain(DOCTOR_SHARED_LINK_TEXT.own);
    const broken = await doctor(() => Promise.reject(new Error('/home/someone/.agentlink/run')));
    expect(broken.code).toBe(EXIT_OK);
    expect(broken.text).toContain(DOCTOR_SHARED_LINK_TEXT.own);
    expect(broken.text).not.toContain('/home/someone');
  });
});

// DEVICES-INTERIM: `agentlink doctor` says when this ID is also in use on another computer, and that
// spending limits then apply per computer. A warning, not a problem: doctor still exits OK.
import { describe, expect, it } from 'vitest';
import { EXIT_OK, createDispatcher } from '../dispatch.js';
import type { TerminalContext } from '../runtime/guards.js';
import type { OpenedAgent } from '../runtime/open-agent.js';
import { DOCTOR_DEVICES_TEXT, createDoctorHandler } from './doctor.js';
import { createDeps } from './shared.js';

const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };

function agentWith(devices: unknown): OpenedAgent {
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
      devices,
    },
    close: () => Promise.resolve(),
  } as unknown as OpenedAgent;
}

async function doctor(devices: unknown): Promise<{ code: number; text: string }> {
  const out: string[] = [];
  const handler = createDoctorHandler(
    createDeps({
      open: () => Promise.resolve({ status: 'ok', agent: agentWith(devices) }),
      home: '/nonexistent-home',
    }),
  );
  const code = await createDispatcher({ doctor: handler })(['doctor'], {
    output: { print: (t) => out.push(t), printError: (t) => out.push(t) },
    terminal: TTY,
    version: '0.0.0',
  });
  return { code, text: out.join('\n') };
}

describe('doctor: this ID on another computer (DEVICES-INTERIM)', () => {
  it('the copy is plain (11 §5) and names the per-computer limits', () => {
    expect(DOCTOR_DEVICES_TEXT.otherComputer).toMatch(
      /^Warning {2}This ID is also in use on another computer/,
    );
    expect(DOCTOR_DEVICES_TEXT.otherComputer).toContain('Spending limits apply per computer');
    for (const word of ['wallet', 'gas', 'install id', 'device', 'transaction']) {
      expect(DOCTOR_DEVICES_TEXT.otherComputer.toLowerCase()).not.toContain(word);
    }
  });

  it('warns while another computer uses this ID, and still exits OK', async () => {
    const seen = await doctor({
      state: () => Promise.resolve({ otherInUse: true, otherSeenAt: 1 }),
    });
    expect(seen.code).toBe(EXIT_OK);
    expect(seen.text).toContain(DOCTOR_DEVICES_TEXT.otherComputer);
  });

  it('says nothing when no other computer was seen, or the state cannot be read', async () => {
    const none = await doctor({
      state: () => Promise.resolve({ otherInUse: false, otherSeenAt: null }),
    });
    expect(none.text).not.toContain('another computer');
    const broken = await doctor({ state: () => Promise.reject(new Error('store')) });
    expect(broken.code).toBe(EXIT_OK);
    expect(broken.text).not.toContain('another computer');
    const absent = await doctor(undefined);
    expect(absent.text).not.toContain('another computer');
  });
});

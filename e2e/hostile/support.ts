// E2E-HOSTILE: the shared setup of the hostile-peer and hostile-relay suites (e2e/hostile/). It plays
// a misbehaving contact and a misbehaving relay against a real core: every agent is a real
// AgentLinkClient with its own in-memory KeyStore, MemoryStore and test owner (04 §3.1.1 allows the
// seam in e2e), driven through the built CLI's MCP server, over the in-memory relay network of
// ../prompt-injection/harness.ts. Nothing here touches the OS keychain, the network or a real home:
// every file lives under one temporary folder, removed at the end.
//
// Each suite checks a behaviour that is already specified and shipped (06 §2, §3, §4; 07 §3, §4;
// 04 §2.5, §3.4): the tests say what the safe behaviour is. Nothing here prints.
import { rm } from 'node:fs/promises';
import {
  FEE_UNITS,
  RelayNetwork,
  editPolicy,
  makeAgent,
  newWorld,
  pair,
  type PiAgent,
  type World,
} from '../prompt-injection/harness.js';

export { FEE_UNITS };

export type RelayMode =
  /** Every relay behaves. */
  | 'honest'
  /** A relay answers OK to a publish but keeps nothing, so nothing can be read back. */
  | 'ok-without-storing'
  /** A relay answers a look-up by event ID with a different (altered) event under the same ID. */
  | 'serves-another-event'
  /** A relay takes the event but never answers a look-up by event ID. */
  | 'ignores-lookups';

type Frame = readonly unknown[];
type OpenArgs = Parameters<RelayNetwork['open']>;

/** The in-memory relay network, with a misbehaving mode that can be switched on and off. */
export class MisbehavingRelays extends RelayNetwork {
  mode: RelayMode = 'honest';

  override open(...[target, handlers]: OpenArgs): ReturnType<RelayNetwork['open']> {
    const honest = super.open(target, handlers);
    const answer = (frame: Frame): void =>
      void Promise.resolve().then(() => handlers.onMessage(JSON.stringify(frame)));
    return {
      close: () => honest.close(),
      send: (text: string) => {
        const frame = JSON.parse(text) as Frame;
        if (frame[0] === 'EVENT' && this.mode === 'ok-without-storing') {
          answer(['OK', (frame[1] as { id: string }).id, true, '']);
          return;
        }
        const filter = frame[0] === 'REQ' ? (frame[2] as { ids?: string[] }) : undefined;
        if (filter?.ids !== undefined && this.mode === 'ignores-lookups') return;
        if (filter?.ids !== undefined && this.mode === 'serves-another-event') {
          const subId = frame[1] as string;
          const found = (this.stored.get(target.url) ?? []).find((e) => filter.ids?.includes(e.id));
          if (found !== undefined) {
            // The same ID, a different message: the signature and the ID no longer match it.
            answer(['EVENT', subId, { ...found, content: `${found.content.slice(0, -1)}A` }]);
          }
          answer(['EOSE', subId]);
          return;
        }
        honest.send(text);
      },
    };
  }
}

export interface Scene {
  readonly world: World;
  readonly net: MisbehavingRelays;
  /** The victim: its owner's policy is the default. */
  readonly ana: PiAgent;
  /** The misbehaving contact, paired with the victim. */
  readonly mallory: PiAgent;
  /** Moves the clock of every agent forward, seconds (the relays' grace times are minutes). */
  advance(seconds: number): void;
  close(): Promise<void>;
}

export interface SceneOptions {
  readonly anaRestoreMark?: Parameters<typeof makeAgent>[1]['restoreMark'];
  readonly drop?: Parameters<typeof makeAgent>[1]['drop'];
}

/** A victim and a misbehaving contact, paired, on a fresh relay network and a fresh temp folder. */
export async function scene(options: SceneOptions = {}): Promise<Scene> {
  const base = await newWorld();
  const net = new MisbehavingRelays();
  let offset = 0;
  const world: World = {
    ...base,
    net,
    clock: () => Math.floor(Date.now() / 1000) + offset,
  };
  const ana = await makeAgent(world, {
    n: 2,
    label: 'ana',
    name: 'Ana',
    relays: ['wss://one.relay-beta.net', 'wss://two.relay-beta.net'],
    ...(options.anaRestoreMark === undefined ? {} : { restoreMark: options.anaRestoreMark }),
    ...(options.drop === undefined ? {} : { drop: options.drop }),
  });
  const mallory = await makeAgent(world, {
    n: 10,
    label: 'mallory',
    name: 'Mallory',
    relays: ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'],
  });
  // Pairing for the setup only: the victim's owner lets this one invite through (06 §3).
  await editPolicy(ana, (p) => {
    p.contacts.acceptInvites = 'auto';
  });
  await pair(mallory, ana);
  await editPolicy(ana, (p) => {
    p.contacts.acceptInvites = 'approval';
  });
  world.chain.fund(ana.client.agentId, 10n * FEE_UNITS);
  world.chain.fund(mallory.client.agentId, 10n * FEE_UNITS);
  return {
    world,
    net,
    ana,
    mallory,
    advance: (seconds) => {
      offset += seconds;
    },
    close: () => rm(world.root, { recursive: true, force: true }),
  };
}

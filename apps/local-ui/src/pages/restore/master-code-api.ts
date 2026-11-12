// REL051-CF3 (R1-CLASS-03/04, R1-UI-02; 04 §2.3.3 T-12; 08 §1): the master code a first run or a
// restore just showed, asked for again after a reload of that step. The server answers it only to the
// page session that got it, for 10 minutes, until "I saved it"; otherwise it says what to show
// instead (`lost`: made and never saved, `finish_restore`, or nothing). Two fixed POSTs, no input, no
// body. The code lives only in the caller's state while its step is on screen; never stored, put in a
// URL or an attribute, never logged.
import { shownLabel, type Outcome } from './api.js';

export const MASTER_CODE_SHOW = '/api/ui/master-code/show';
export const MASTER_CODE_SAVED = '/api/ui/master-code/saved';
/** What the settings page for a new master code is called by path. */
export const NEW_MASTER_CODE_PATH = '/settings/touch-id';

/** The first-run step's public fields (the master code step of Get started). */
export interface FirstRunView {
  readonly outcome: 'done' | 'done_unconfirmed' | 'created_not_connected';
  readonly passkey: boolean;
  readonly fingerprint: string;
  readonly computerName?: string;
  readonly sendFolder?: string;
}

export type MasterCodeAnswer =
  | {
      readonly kind: 'shown';
      readonly which: 'first_run';
      readonly code: string;
      readonly view: FirstRunView;
    }
  | {
      readonly kind: 'shown';
      readonly which: 'restore';
      readonly code: string;
      readonly ids: readonly Outcome[];
      readonly touchId: boolean;
    }
  /** Made and never saved (a restart, or the 10 minutes passed): say so, never ask for it. */
  | { readonly kind: 'lost'; readonly which: 'first_run' | 'restore'; readonly touchId: boolean }
  /** Restored IDs wait for their owner: "Finish restoring" with the same kit. */
  | { readonly kind: 'finish_restore' }
  /** Nothing to show (or no answer: the page goes on as before). */
  | { readonly kind: 'none' };

export interface MasterCodeApi {
  show(): Promise<MasterCodeAnswer>;
  /** "I saved it": the server forgets the code. */
  saved(): Promise<void>;
}

/** The generator's code as the server shows it: six groups of four, spaces or hyphens. */
const CODE = /^[A-Z2-9]{4}(?:[ -][A-Z2-9]{4}){5}$/;
const OUTCOMES: ReadonlySet<string> = new Set([
  'done',
  'done_unconfirmed',
  'created_not_connected',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

function outcomesOf(value: unknown): Outcome[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Outcome[] = [];
  for (const o of value) {
    if (!isRecord(o)) return undefined;
    const { agentId, name, outcome, label } = o;
    if (typeof agentId !== 'string' || typeof name !== 'string') return undefined;
    if (outcome !== 'restored' && outcome !== 'failed') return undefined;
    out.push({ agentId, name, label: shownLabel(label, name), outcome });
  }
  return out;
}

/** The answer in fixed shapes; anything else is `none` (the page never shows server text). */
export function masterCodeAnswerOf(json: unknown): MasterCodeAnswer {
  const none: MasterCodeAnswer = { kind: 'none' };
  if (!isRecord(json)) return none;
  const { status, kind, code } = json;
  if (status === 'finish_restore') return { kind: 'finish_restore' };
  if (status === 'lost' && (kind === 'first_run' || kind === 'restore')) {
    return { kind: 'lost', which: kind, touchId: json['touchId'] === true };
  }
  if (status !== 'shown' || typeof code !== 'string' || !CODE.test(code)) return none;
  if (kind === 'restore') {
    const ids = outcomesOf(json['ids']);
    if (ids === undefined) return none;
    return { kind: 'shown', which: 'restore', code, ids, touchId: json['touchId'] === true };
  }
  if (kind !== 'first_run') return none;
  const { outcome, passkey, fingerprint, computerName, sendFolder } = json;
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome) || typeof fingerprint !== 'string') {
    return none;
  }
  return {
    kind: 'shown',
    which: 'first_run',
    code,
    view: {
      outcome: outcome as FirstRunView['outcome'],
      passkey: passkey === true,
      fingerprint,
      ...(typeof computerName === 'string' ? { computerName } : {}),
      ...(typeof sendFolder === 'string' ? { sendFolder } : {}),
    },
  };
}

export function createMasterCodeApi(
  options: { readonly fetch?: typeof fetch; readonly token?: string } = {},
): MasterCodeApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const post = async (path: string): Promise<unknown> => {
    const res = await doFetch(path, {
      method: 'POST',
      headers: {
        'X-AgentLink-CSRF': options.token ?? pageToken(),
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(0),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (res.status !== 200) return undefined;
    return (await res.json()) as unknown;
  };
  return {
    async show() {
      try {
        return masterCodeAnswerOf(await post(MASTER_CODE_SHOW));
      } catch {
        return { kind: 'none' };
      }
    },
    async saved() {
      try {
        await post(MASTER_CODE_SAVED);
      } catch {
        // The code leaves the page anyway; the server forgets it after 10 minutes.
      }
    },
  };
}

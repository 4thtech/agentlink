// M1-PAY-CONFIRM-b: the app's paid-action confirmation (04 §2.5.3; 08 §1; b11 §19, §20; D-132).
//
// - The page names the flow only (`{ flow: 'limits', review, acknowledged }` or `{ flow: 'proof',
//   approvalId, remember? }`), as the operation input of POST /api/ui/pay-confirm/begin; the server
//   builds the statement from stored data and answers it with a fresh challenge. Nothing is read
//   from the URL, and the sheet shows only a statement that parses.
// - The passkey: one navigator.credentials.get with that challenge, `userVerification: 'required'`
//   and the PRF salt, only after the owner clicks; its response goes back to /finish as six fields
//   (credential ID, authenticator data, clientDataJSON, signature, user handle, PRF output), each
//   with a 16-bit length first. Or the backup code as the body.
// - The browser never signs (D-118), and nothing here is logged; the presence bytes are wiped.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  PAY_CONFIRM_STRINGS as P,
  PayConfirmSheet,
  parsePayStatement,
  payConfirmView,
  type PayConfirmView,
  type PayPlatform,
  type PaySheetPhase,
} from '@4thtech-io/ui';

const CSRF_HEADER = 'X-AgentLink-CSRF';
const BEGIN = '/api/ui/pay-confirm/begin';
const FINISH = '/api/ui/pay-confirm/finish';

export type PayConfirmInput =
  | { readonly flow: 'limits'; readonly review: string; readonly acknowledged: readonly string[] }
  | { readonly flow: 'proof'; readonly approvalId: string; readonly remember?: true };

export interface PayPublicKey {
  readonly rpId: string;
  readonly challenge: string;
  readonly allowCredentials: readonly string[];
  readonly timeoutMs: number;
  readonly prfSalt: string;
}

export type BeginAnswer =
  | {
      readonly kind: 'ready';
      readonly ceremony: string;
      readonly view: PayConfirmView;
      readonly statementJson: string;
      readonly publicKey: PayPublicKey;
      readonly rememberOffered: boolean;
    }
  /** A fixed refusal word from the server (`not_pending`, `busy`, `not_offered`, …). */
  | { readonly kind: 'refused'; readonly status: string }
  | { readonly kind: 'failed' };

export type FinishAnswer =
  | { readonly kind: 'status'; readonly status: string; readonly retryAfter?: number }
  /** The person dismissed the system prompt: nothing was sent. */
  | { readonly kind: 'dismissed' }
  /** No answer after confirming: the outcome is unknown. */
  | { readonly kind: 'unknown' };

export interface PayConfirmClient {
  begin(input: PayConfirmInput): Promise<BeginAnswer>;
  /** `onAsserted` runs once the system prompt answered, before the finish request. */
  finishPasskey(
    ceremony: string,
    publicKey: PayPublicKey,
    onAsserted?: () => void,
  ): Promise<FinishAnswer>;
  finishCode(ceremony: string, code: string): Promise<FinishAnswer>;
}

export interface PayConfirmClientOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
  readonly credentials?: CredentialsContainer;
}

const fromB64 = (text: string): Uint8Array<ArrayBuffer> => {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

function base64urlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const bytesOf = (buffer: ArrayBuffer | null | undefined): Uint8Array =>
  buffer ? new Uint8Array(buffer) : new Uint8Array(0);

function fields(list: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(list.reduce((n, f) => n + 2 + f.length, 0));
  let at = 0;
  for (const f of list) {
    out[at] = f.length >> 8;
    out[at + 1] = f.length & 255;
    out.set(f, at + 2);
    at += 2 + f.length;
  }
  return out;
}

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

function publicKeyOf(value: unknown): PayPublicKey | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const list = v['allowCredentials'];
  if (
    typeof v['rpId'] !== 'string' ||
    typeof v['challenge'] !== 'string' ||
    typeof v['prfSalt'] !== 'string' ||
    typeof v['timeoutMs'] !== 'number' ||
    !Array.isArray(list) ||
    !list.every((x) => typeof x === 'string')
  ) {
    return undefined;
  }
  return {
    rpId: v['rpId'],
    challenge: v['challenge'],
    allowCredentials: list as string[],
    timeoutMs: v['timeoutMs'],
    prfSalt: v['prfSalt'],
  };
}

export function createPayConfirmClient(options: PayConfirmClientOptions = {}): PayConfirmClient {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();
  const credentials = (): CredentialsContainer | undefined =>
    options.credentials ?? (typeof navigator === 'undefined' ? undefined : navigator.credentials);

  async function post(
    path: string,
    input: unknown,
    body: Uint8Array<ArrayBuffer>,
    passkey: boolean,
  ): Promise<{ status: number; json: Record<string, unknown> } | undefined> {
    const headers: Record<string, string> = {
      [CSRF_HEADER]: token(),
      'content-type': 'application/octet-stream',
      'X-AgentLink-Input': base64urlJson(input),
    };
    if (passkey) headers['X-AgentLink-Presence'] = 'passkey';
    try {
      const res = await doFetch(path, {
        method: 'POST',
        headers,
        body,
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const json = (await res.json()) as unknown;
      return {
        status: res.status,
        json: typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {},
      };
    } catch {
      return undefined;
    } finally {
      body.fill(0);
    }
  }

  const finished = (
    answer: { status: number; json: Record<string, unknown> } | undefined,
  ): FinishAnswer => {
    if (answer === undefined) return { kind: 'unknown' };
    const status = answer.json['status'];
    if (typeof status !== 'string') return { kind: 'unknown' };
    const retry = answer.json['retryAfter'];
    return {
      kind: 'status',
      status,
      ...(typeof retry === 'number' ? { retryAfter: retry } : {}),
    };
  };

  return {
    async begin(input) {
      const answer = await post(BEGIN, input, new Uint8Array(0), false);
      if (answer === undefined) return { kind: 'failed' };
      const j = answer.json;
      if (j['status'] !== 'ready') {
        return typeof j['status'] === 'string'
          ? { kind: 'refused', status: j['status'] }
          : { kind: 'failed' };
      }
      const statement = parsePayStatement(j['statement']);
      const publicKey = publicKeyOf(j['publicKey']);
      if (statement === undefined || publicKey === undefined || typeof j['ceremony'] !== 'string') {
        return { kind: 'failed' };
      }
      return {
        kind: 'ready',
        ceremony: j['ceremony'],
        view: payConfirmView(statement),
        statementJson: JSON.stringify(statement),
        publicKey,
        rememberOffered: j['rememberOffered'] === true,
      };
    },

    async finishPasskey(ceremony, pk, onAsserted) {
      const container = credentials();
      if (container === undefined) return { kind: 'dismissed' };
      let credential: Credential | null;
      try {
        credential = await container.get({
          publicKey: {
            challenge: fromB64(pk.challenge),
            rpId: pk.rpId,
            allowCredentials: pk.allowCredentials.map((id) => ({
              type: 'public-key' as const,
              id: fromB64(id),
            })),
            userVerification: 'required',
            timeout: pk.timeoutMs,
            extensions: {
              prf: { eval: { first: fromB64(pk.prfSalt) } },
            } as AuthenticationExtensionsClientInputs,
          },
        });
      } catch {
        return { kind: 'dismissed' };
      }
      if (credential === null) return { kind: 'dismissed' };
      const c = credential as PublicKeyCredential;
      const r = c.response as AuthenticatorAssertionResponse;
      const ext = c.getClientExtensionResults() as {
        prf?: { results?: { first?: ArrayBuffer } };
      };
      const prf = bytesOf(ext.prf?.results?.first);
      const body = fields([
        bytesOf(c.rawId),
        bytesOf(r.authenticatorData),
        bytesOf(r.clientDataJSON),
        bytesOf(r.signature),
        bytesOf(r.userHandle),
        prf,
      ]);
      prf.fill(0);
      onAsserted?.();
      return finished(await post(FINISH, { ceremony }, body, true));
    },

    async finishCode(ceremony, code) {
      // A plain Uint8Array of this realm (the code is never kept: post() wipes it).
      const body = Uint8Array.from(new TextEncoder().encode(code));
      return finished(await post(FINISH, { ceremony }, body, false));
    },
  };
}

// --- the controller -------------------------------------------------------------------------------

export interface PayConfirmProps {
  readonly client?: PayConfirmClient;
  readonly input: PayConfirmInput;
  readonly platform?: PayPlatform;
  readonly reducedMotion?: boolean;
  /** Runs once when the server applied the confirmed action. */
  readonly onDone: () => void;
  /** The sheet is gone (cancelled, or closed after Done). */
  readonly onClose: () => void;
}

interface State {
  readonly phase: PaySheetPhase;
  readonly view?: PayConfirmView;
  readonly notice?: { readonly tone: 'info' | 'error'; readonly text: string };
  readonly closed: boolean;
  readonly backup: boolean;
  readonly busy: boolean;
}

function systemPlatform(): PayPlatform {
  if (typeof navigator === 'undefined') return 'other';
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  const p = data?.platform ?? navigator.platform;
  return /mac/i.test(p) ? 'mac' : /win/i.test(p) ? 'windows' : 'other';
}

function systemReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/** The sheet, wired to begin and finish. */
export function PayConfirm(props: PayConfirmProps): ReactElement {
  const client = useMemo(() => props.client ?? createPayConfirmClient(), [props.client]);
  const platform = props.platform ?? systemPlatform();
  const reducedMotion = props.reducedMotion ?? systemReducedMotion();
  const [state, setState] = useState<State>({
    phase: 'loading',
    closed: false,
    backup: false,
    busy: true,
  });
  const [remember, setRemember] = useState(false);
  const [offered, setOffered] = useState(false);
  const held = useRef<{
    ceremony: string;
    publicKey: PayPublicKey;
    statementJson: string;
    stale: boolean;
  }>(undefined);
  const input = useRef(props.input);
  const doneOnce = useRef(false);
  const limits = props.input.flow === 'limits';

  const stop = (text: string, tone: 'info' | 'error' = 'info'): void =>
    setState((s) => ({ ...s, phase: 'ready', closed: true, busy: false, notice: { tone, text } }));

  /** Begin (again): true when a statement is held and is the one on screen. */
  const begin = useCallback(
    async (withRemember: boolean): Promise<boolean> => {
      const base = input.current;
      const flow: PayConfirmInput =
        base.flow === 'proof' && withRemember ? { ...base, remember: true } : base;
      const answer = await client.begin(flow);
      if (answer.kind === 'refused' && answer.status === 'not_offered' && withRemember) {
        setRemember(false);
        setOffered(false);
        setState((s) => ({ ...s, notice: { tone: 'info', text: P.notOffered } }));
        return begin(false);
      }
      if (answer.kind !== 'ready') {
        if (answer.kind === 'refused' && answer.status === 'not_pending') stop(P.decided);
        else if (answer.kind === 'refused' && answer.status === 'busy') {
          setState((s) => ({ ...s, busy: false, notice: { tone: 'error', text: P.busy } }));
        } else stop(P.failedStart);
        return false;
      }
      const before = held.current?.statementJson;
      held.current = {
        ceremony: answer.ceremony,
        publicKey: answer.publicKey,
        statementJson: answer.statementJson,
        stale: false,
      };
      setOffered(answer.rememberOffered);
      const canPasskey = answer.publicKey.allowCredentials.length > 0;
      const changed = before !== undefined && before !== answer.statementJson;
      setState((s) => ({
        ...s,
        view: answer.view,
        phase:
          s.phase === 'loading' ? (canPasskey ? 'ready' : 'backup') : s.backup ? 'backup' : 'ready',
        busy: false,
        ...(changed ? { notice: { tone: 'info' as const, text: P.changed } } : {}),
      }));
      return !changed;
    },
    [client],
  );

  useEffect(() => {
    void begin(false);
  }, [begin]);

  const fresh = async (): Promise<boolean> =>
    held.current === undefined || held.current.stale ? begin(remember) : true;

  const outcome = (answer: FinishAnswer, passkey: boolean): void => {
    if (answer.kind === 'dismissed') {
      setState((s) => ({
        ...s,
        phase: 'ready',
        busy: false,
        notice: { tone: 'info', text: P.cancelled },
      }));
      return;
    }
    if (answer.kind === 'unknown') return stop(P.stillWorking);
    const { status } = answer;
    if (held.current !== undefined && (passkey || status !== 'presence_rejected')) {
      held.current.stale = true;
    }
    if (status === 'applied') {
      setState((s) => ({ ...s, phase: 'done', busy: false }));
      if (!doneOnce.current) {
        doneOnce.current = true;
        props.onDone();
      }
      return;
    }
    const back = (notice: State['notice'], over: Partial<State> = {}): void =>
      setState((s) => ({
        ...s,
        phase: s.backup ? 'backup' : 'ready',
        busy: false,
        ...(notice === undefined ? {} : { notice }),
        ...over,
      }));
    switch (status) {
      case 'presence_rejected':
        return back({ tone: 'error', text: passkey ? P.notVerified : P.wrongCode });
      case 'verification_required':
      case 'presence_required':
        return back({ tone: 'error', text: P.notVerified });
      case 'passkey_update_needed':
        return back({ tone: 'info', text: P.updateNeeded }, { backup: true, phase: 'backup' });
      case 'tries_exhausted':
        return stop(P.triesUsed);
      case 'expired':
      case 'unknown':
        return stop(P.expired);
      case 'not_pending':
        return stop(P.decided);
      case 'changed':
        back({ tone: 'info', text: P.changed });
        void begin(remember);
        return;
      case 'wait': {
        const seconds =
          answer.retryAfter !== undefined && answer.retryAfter > 0
            ? Math.ceil(answer.retryAfter)
            : 1;
        return back({ tone: 'error', text: P.wait.replace('{seconds}', String(seconds)) });
      }
      case 'busy':
        return back({ tone: 'error', text: P.busy });
      case 'refused':
        return stop(limits ? P.refusedLimits : P.refusedProof, 'error');
      default:
        return stop(P.stillWorking);
    }
  };

  /** After 400 ms without an answer, the sheet says it is recording (b11 §15.2). */
  const recording = (): (() => void) => {
    const timer = setTimeout(() => setState((s) => ({ ...s, phase: 'recording' })), 400);
    return () => clearTimeout(timer);
  };

  const onConfirm = async (): Promise<void> => {
    setState((s) => {
      const { notice: _n, ...rest } = s;
      void _n;
      return { ...rest, busy: true };
    });
    if (!(await fresh()) || held.current === undefined) return;
    const { ceremony, publicKey } = held.current;
    setState((s) => ({ ...s, phase: 'waiting' }));
    // The system prompt is the browser's; the "recording" word only once it is answered.
    let stopTimer: (() => void) | undefined;
    const answer = await client.finishPasskey(ceremony, publicKey, () => {
      stopTimer = recording();
    });
    stopTimer?.();
    outcome(answer, true);
  };

  const onCode = async (code: string): Promise<void> => {
    setState((s) => {
      const { notice: _n, ...rest } = s;
      void _n;
      return { ...rest, busy: true };
    });
    if (!(await fresh()) || held.current === undefined) return;
    const stopTimer = recording();
    const answer = await client.finishCode(held.current.ceremony, code);
    stopTimer();
    outcome(answer, false);
  };

  const onRemember = (on: boolean): void => {
    setRemember(on);
    setState((s) => {
      const { notice: _n, ...rest } = s;
      void _n;
      return { ...rest, busy: true };
    });
    void begin(on);
  };

  const canPasskey = (held.current?.publicKey.allowCredentials.length ?? 0) > 0;
  return (
    <PayConfirmSheet
      view={state.view}
      platform={platform}
      phase={state.phase}
      {...(state.notice === undefined ? {} : { notice: state.notice })}
      closed={state.closed}
      canPasskey={canPasskey}
      backup={true}
      {...(offered ? { remember: { checked: remember, onChange: onRemember } } : {})}
      reducedMotion={reducedMotion}
      busy={state.busy}
      onConfirm={() => void onConfirm()}
      onCancel={props.onClose}
      onUseBackup={() =>
        setState((s) => {
          const { notice: _n, ...rest } = s;
          void _n;
          return { ...rest, backup: true, phase: 'backup' };
        })
      }
      onCode={(code) => void onCode(code)}
      onClose={props.onClose}
    />
  );
}

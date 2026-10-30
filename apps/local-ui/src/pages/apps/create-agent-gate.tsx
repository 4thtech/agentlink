// W4-ONE-TOUCH (D-140; 04 §2.8; 11 §5.8 "Create and connect"; b11 §29.4): the one screen of New
// agent: the statement ("Add {label}"), "Connect to {app}" prefilled with a detected AI app that no
// agent uses yet (unticked = "Not now"), and one button for the one gesture (or the backup code).
// The page never signs; begin fixes the plan on the server right before the gesture, and finish
// carries only the begin nonce and the proof (create-agent-api.ts).
import { Banner, Button, TextField } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { AppMark } from '../first-run/pick-app.js';
import { createAppsApi, type AppsApi, type DetectedApp } from '../first-run/apps-api.js';
import { CONTACTS_STRINGS as C } from '../contacts/strings.js';
import { NAME, SETUP_MESSAGES } from '../first-run/strings.js';
import { createAgentApi, type CreateAgentApi, type CreateFinish } from './create-agent-api.js';

/** What the sheet shows after the one gesture. */
export interface CreatedAgent {
  readonly name: string;
  readonly label: string;
  /** The app the gesture connected (or tried to), with whether its entry was written. */
  readonly app?: { readonly id: string; readonly name: string; readonly connected: boolean };
}

const MESSAGES: Partial<Record<CreateFinish['kind'] | string, string>> = {
  rejected: "That didn't work. Nothing changed. Try again.",
  required: SETUP_MESSAGES.presence_required,
  tries_exhausted: SETUP_MESSAGES.tries_exhausted,
  expired: SETUP_MESSAGES.expired,
  not_pending: SETUP_MESSAGES.expired,
  changed: SETUP_MESSAGES.changed,
  quit_first: SETUP_MESSAGES.quit_first,
  app_unavailable: SETUP_MESSAGES.app_unavailable,
  busy: SETUP_MESSAGES.busy,
  wait: SETUP_MESSAGES.wait(30),
  dismissed: SETUP_MESSAGES.cancelled,
  verification_required: SETUP_MESSAGES.presence_rejected,
  passkey_update_needed: 'Use your backup code this time.',
  label_invalid: SETUP_MESSAGES.label_invalid,
  session: SETUP_MESSAGES.session_expired,
  offline: SETUP_MESSAGES.offline,
};

/** Refusals after which the same plan may be tried again (Decision 45: the plan is kept). */
const KEEPS_PLAN: ReadonlySet<string> = new Set(['rejected', 'required', 'wait', 'busy']);

export function CreateAgentGate({
  label,
  summary,
  onDone,
  onCancel,
  api: givenApi,
  appsApi: givenApps,
}: {
  label: string;
  /** The statement line ("Add {label}"). */
  summary: string;
  onDone: (created: CreatedAgent) => void;
  onCancel: () => void;
  /** Test seams; the app's own server calls by default. */
  api?: CreateAgentApi;
  appsApi?: AppsApi;
}): ReactElement {
  const [api] = useState<CreateAgentApi>(() => givenApi ?? createAgentApi());
  const [appsApi] = useState<AppsApi>(() => givenApps ?? createAppsApi());
  const [free, setFree] = useState<DetectedApp | undefined>(undefined);
  const [connect, setConnect] = useState(true);
  const [useCode, setUseCode] = useState(false);
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [canPasskey, setCanPasskey] = useState(true);
  // The held plan's nonce for retries with the backup code (Decision 45), and the app it was for.
  const held = useRef<{ nonce: string; app: string | undefined } | undefined>(undefined);
  // The one button, worded as every presence sheet of the app (Contacts, Rename, Remove).
  const useLabel = C.usePasskey;

  useEffect(() => {
    let live = true;
    void appsApi.list().then((result) => {
      if (!live || result.kind !== 'ok') return;
      // A detected app no agent uses yet ("Not connected yet", b11 §29.2), never one that is open
      // and rewrites its file (Claude Desktop running).
      setFree(result.apps.find((a) => a.state === 'not_connected' && !a.quitFirst));
    });
    return () => {
      live = false;
    };
  }, [appsApi]);

  const app = free !== undefined && connect ? free : undefined;

  const settle = (outcome: CreateFinish): void => {
    if (outcome.kind === 'done' || outcome.kind === 'created_not_connected') {
      held.current = undefined;
      onDone({
        name: outcome.name,
        label: outcome.label,
        ...(app === undefined || outcome.app !== app.id
          ? {}
          : { app: { id: app.id, name: app.name, connected: outcome.kind === 'done' } }),
      });
      return;
    }
    if (!KEEPS_PLAN.has(outcome.kind)) held.current = undefined;
    if (outcome.kind === 'passkey_update_needed') {
      setCanPasskey(false);
      setUseCode(true);
    }
    setError(MESSAGES[outcome.kind] ?? SETUP_MESSAGES.unknown);
  };

  /** Begins a plan (or keeps the held one for the same app) and returns its nonce. */
  const plan = async (
    keep: boolean,
  ): Promise<
    { nonce: string; pk?: Parameters<CreateAgentApi['finishPasskey']>[1] } | undefined
  > => {
    const id = app?.id;
    if (keep && held.current !== undefined && held.current.app === id) {
      return { nonce: held.current.nonce };
    }
    const begun = await api.begin(label, id);
    if (begun.kind !== 'ready') {
      setError(
        begun.kind === 'refused'
          ? (MESSAGES[begun.status] ?? SETUP_MESSAGES.unknown)
          : (MESSAGES[begun.kind] ?? SETUP_MESSAGES.unknown),
      );
      return undefined;
    }
    held.current = { nonce: begun.nonce, app: id };
    if (begun.publicKey.allowCredentials.length === 0) setCanPasskey(false);
    return { nonce: begun.nonce, pk: begun.publicKey };
  };

  const withPasskey = async (): Promise<void> => {
    setWorking(true);
    setError(undefined);
    try {
      const begun = await plan(false);
      if (begun?.pk === undefined) return;
      if (begun.pk.allowCredentials.length === 0) {
        setUseCode(true);
        return;
      }
      settle(await api.finishPasskey(begun.nonce, begun.pk));
    } finally {
      setWorking(false);
    }
  };

  const withCode = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (working || code.length === 0) return;
    setWorking(true);
    setError(undefined);
    try {
      const begun = await plan(true);
      if (begun === undefined) return;
      const typed = code;
      setCode('');
      settle(await api.finishCode(begun.nonce, typed));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="ag-sheet-body">
      <p className="al-text-title-3">{summary}</p>
      {free === undefined ? null : (
        <label className="ag-check">
          <input
            type="checkbox"
            checked={connect}
            disabled={working}
            onChange={(e) => {
              setConnect(e.currentTarget.checked);
              held.current = undefined;
            }}
          />
          <AppMark name={free.name} />
          <span>{NAME.connectTo(free.name)}</span>
        </label>
      )}
      {error === undefined ? null : <Banner tone="warning">{error}</Banner>}
      {useCode || !canPasskey ? (
        <form autoComplete="on" onSubmit={(e) => void withCode(e)}>
          <TextField
            label="Backup code"
            name="backup-code"
            type="password"
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            mono
            value={code}
            disabled={working}
            onChange={(e) => setCode(e.currentTarget.value)}
          />
          <div className="ag-actions">
            <Button type="submit" variant="primary" disabled={working || code.length === 0}>
              {NAME.confirmCode}
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              {NAME.back}
            </Button>
          </div>
        </form>
      ) : (
        <div className="ag-actions">
          <Button
            variant="primary"
            icon="key-round"
            disabled={working}
            onClick={() => void withPasskey()}
          >
            {useLabel}
          </Button>
          <Button variant="ghost" size="sm" disabled={working} onClick={() => setUseCode(true)}>
            {NAME.backupInstead}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {NAME.back}
          </Button>
        </div>
      )}
    </div>
  );
}

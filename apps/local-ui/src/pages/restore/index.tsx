// Restore wizard (UX1113-R3; D-147; design-1112 spec §6.4 to §6.6; 04 §2.3.3 "Restore in the app"):
// four steps in the focused column, each its own state of one page, Cancel on every step.
//   /restore/kit    1 Your kit file, 2 Your recovery code, 3 What comes back, 4 Protect and reconnect
//   /restore/check  Check my kit: steps 1 and 2, then "This kit opens." and nothing is written
//   /restore/move   How to move to a new computer
// The page never reads the kit, never derives a key and never signs: it sends the recovery code, the
// master code or the passkey assertion once, to the local server, and shows only fixed fields. The
// recovery code lives in this component's state until the kit opens; the new master code lives in
// state until "Go to Home". Neither is stored, put in a URL or rendered into an attribute.
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { navigate } from '../../router.js';
import { createOwnerClient, passkeyProof as browserPasskeyProof } from '../contacts/owner.js';
import type { OwnerClient, PasskeyInfo, PresenceProof } from '../contacts/owner.js';
import { createAppsApi, type AppsApi, type DetectedApp } from '../first-run/apps-api.js';
import { ConnectApp } from '../first-run/connect-app.js';
import { detectPlatform } from '../first-run/passkey.js';
import { SENSOR, type Platform } from '../first-run/strings.js';
import { markLeavingStart } from '../start/guard.js';
import {
  createRestoreApi,
  type Failure,
  type FoundKit,
  type RestoreApi,
  type Summary,
} from './api.js';
import { emptyGroups, codeOf } from './code-field.js';
import { canRestoreHere, createRestorePasskey, getRestorePrf } from './passkey.js';
import {
  CheckedStep,
  CodeStep,
  Frame,
  HowToMove,
  KitStep,
  NeedsTerminal,
  PresenceStep,
  ProtectStep,
  ReviewStep,
  formatDate,
  type ReviewState,
} from './steps.js';
import { CODE, KIT, PROBLEMS, WIZARD, type StepId } from './strings.js';

export type RestoreMode = 'restore' | 'check';

type View =
  | { readonly k: 'kit' }
  | { readonly k: 'presence' }
  | { readonly k: 'code' }
  | { readonly k: 'checked'; readonly summary: Summary }
  | { readonly k: 'review' }
  | { readonly k: 'protect' }
  | { readonly k: 'terminal' };

export interface RestoreWizardProps {
  readonly mode?: RestoreMode;
  readonly api?: RestoreApi;
  readonly appsApi?: AppsApi;
  readonly owner?: OwnerClient;
  readonly platform?: Platform;
  /** Test seam: one passkey get() for the stored passkey. */
  readonly passkeyProof?: (info: PasskeyInfo) => Promise<PresenceProof | undefined>;
  /** Test seam: leaves the wizard (Cancel, Done, Go to Home). Default: a full load of Home. */
  readonly onLeave?: (to: string) => void;
}

function leaveDefault(to: string): void {
  markLeavingStart();
  window.location.assign(to);
}

const stepOf = (view: View): StepId =>
  view.k === 'kit'
    ? 'kit'
    : view.k === 'presence' || view.k === 'code' || view.k === 'terminal'
      ? 'code'
      : view.k === 'checked'
        ? 'code'
        : view.k === 'review'
          ? 'review'
          : 'protect';

function problemText(f: Failure): string {
  if (f.problem === 'wait' && f.retryAfter !== undefined) return CODE.wait(f.retryAfter);
  return PROBLEMS[f.problem];
}

export function RestoreWizard({
  mode = 'restore',
  api: givenApi,
  appsApi: givenApps,
  owner: givenOwner,
  platform: givenPlatform,
  passkeyProof = browserPasskeyProof,
  onLeave = leaveDefault,
}: RestoreWizardProps = {}): ReactElement {
  const check = mode === 'check';
  const [api] = useState<RestoreApi>(() => givenApi ?? createRestoreApi());
  const [appsApi] = useState<AppsApi>(() => givenApps ?? createAppsApi());
  const [owner] = useState<OwnerClient>(() => givenOwner ?? createOwnerClient());
  const [platform] = useState<Platform>(() => givenPlatform ?? detectPlatform());
  const sensor = SENSOR[platform];

  const [view, setView] = useState<View>({ k: 'kit' });
  const [kits, setKits] = useState<readonly FoundKit[] | undefined>(undefined);
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [picked, setPicked] = useState<{ name: string; savedAt: number } | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [errorHint, setErrorHint] = useState<string | undefined>(undefined);
  const [ownerPresent, setOwnerPresent] = useState(false);
  const [hasPasskey, setHasPasskey] = useState(false);
  const [groups, setGroups] = useState<string[]>(emptyGroups);
  const [waitUntil, setWaitUntil] = useState(0);
  const [kitHandle, setKitHandle] = useState<string | undefined>(undefined);
  const [summary, setSummary] = useState<Summary | undefined>(undefined);
  const [review, setReview] = useState<ReviewState>({ selected: new Set(), names: {} });
  const [restored, setRestored] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [masterCode, setMasterCode] = useState<string | undefined>(undefined);
  const [touchId, setTouchId] = useState(false);
  const [saved, setSaved] = useState(false);
  const [apps, setApps] = useState<readonly DetectedApp[] | undefined>(undefined);
  const [connecting, setConnecting] = useState<string | undefined>(undefined);
  const gestureBusy = useRef(false);

  // Found kit files (name pattern and header only; nothing is opened).
  useEffect(() => {
    let live = true;
    void api.found().then((r) => {
      if (!live) return;
      if (r.kind === 'ok') {
        setKits(r.kits);
        const first = r.kits[0];
        if (first !== undefined) setChoice((c) => c ?? first.handle);
      } else {
        setKits([]);
        if (r.problem === 'session' || r.problem === 'offline') setError(problemText(r));
      }
    });
    return () => {
      live = false;
    };
  }, [api]);

  // The wait after wrong tries counts down on screen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (waitUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waitUntil]);
  const waiting = waitUntil > now ? Math.ceil((waitUntil - now) / 1000) : 0;
  useEffect(() => {
    if (waitUntil !== 0 && waiting === 0) {
      setError(undefined);
      setWaitUntil(0);
    }
  }, [waiting, waitUntil]);

  // The master code never outlives this page.
  useEffect(() => () => setMasterCode(undefined), []);

  const savedAt = picked?.savedAt ?? kits?.find((k) => k.handle === choice)?.modifiedAt;

  const fail = (f: Failure, hint?: string): void => {
    setError(problemText(f));
    setErrorHint(hint);
    if (f.problem === 'wait' && f.retryAfter !== undefined) {
      setNow(Date.now());
      setWaitUntil(Date.now() + f.retryAfter * 1000);
    }
  };

  const leave = useCallback(
    (to: string): void => {
      setMasterCode(undefined);
      onLeave(to);
    },
    [onLeave],
  );

  const cancel = (): void => {
    if (kitHandle !== undefined) void api.cancel(kitHandle);
    leave('/');
  };

  // --- step 1 ---------------------------------------------------------------------------------

  const chooseFile = async (file: File): Promise<void> => {
    setError(undefined);
    setErrorHint(undefined);
    setWorking(true);
    const r = await api.upload(file);
    setWorking(false);
    if (r.kind === 'error') return fail(r);
    setChoice(r.handle);
    setPicked({ name: file.name, savedAt: Math.floor(file.lastModified / 1000) });
  };

  const continueKit = async (): Promise<void> => {
    setError(undefined);
    setErrorHint(undefined);
    if (choice === undefined) return setError(KIT.needsFile);
    setWorking(true);
    const r = await api.header(choice);
    setWorking(false);
    if (r.kind === 'error') return fail(r);
    if (r.header === 'not_a_kit') return setError(KIT.notAKit);
    if (r.header === 'newer_version') return setError(KIT.newer);
    if (r.header === 'other_owner') {
      setError(KIT.otherOwner);
      return setErrorHint(KIT.otherOwnerHint);
    }
    setOwnerPresent(r.ownerPresent);
    if (!check && r.ownerPresent) {
      setHasPasskey((await owner.passkey()) !== undefined);
      return setView({ k: 'presence' });
    }
    setView({ k: 'code' });
  };

  // --- presence -------------------------------------------------------------------------------

  const presence = async (proof: PresenceProof | undefined): Promise<void> => {
    if (choice === undefined) return;
    setError(undefined);
    if (proof === undefined) return setError(PROBLEMS.presence_rejected);
    setWorking(true);
    const r = await api.presence(choice, proof);
    setWorking(false);
    if (r.kind === 'error') return fail(r);
    setView({ k: 'code' });
  };

  const passkeyPresence = async (): Promise<void> => {
    const info = await owner.passkey();
    if (info === undefined) return setError(PROBLEMS.presence_rejected);
    await presence(await passkeyProof(info));
  };

  // --- step 2 ---------------------------------------------------------------------------------

  const openKit = async (): Promise<void> => {
    if (choice === undefined || waiting > 0) return;
    setError(undefined);
    setWorking(true);
    const bytes = new TextEncoder().encode(codeOf(groups));
    if (check) {
      const r = await api.check(choice, bytes);
      setWorking(false);
      if (r.kind === 'error') return fail(r);
      setGroups(emptyGroups());
      return setView({ k: 'checked', summary: r.summary });
    }
    const r = await api.open(choice, bytes);
    setWorking(false);
    if (r.kind === 'error') {
      if (r.problem === 'needs_terminal') return setView({ k: 'terminal' });
      if (r.problem === 'presence_required') return setView({ k: 'presence' });
      return fail(r);
    }
    setGroups(emptyGroups());
    setKitHandle(r.kit);
    setSummary(r.summary);
    setReview({
      selected: new Set(
        r.summary.ids
          .filter((x) => x.state === 'new' || x.state === 'name_taken')
          .map((x) => x.agentId),
      ),
      names: Object.fromEntries(
        r.summary.ids
          .filter((x) => x.state === 'name_taken' && x.suggestedName !== undefined)
          .map((x) => [x.agentId, x.suggestedName as string]),
      ),
    });
    setView({ k: 'review' });
  };

  // --- step 3 ---------------------------------------------------------------------------------

  const finishRestore = (
    ids: readonly { name: string; outcome: 'restored' | 'failed' }[],
    code: string | undefined,
    withTouchId: boolean,
  ): void => {
    setRestored(ids.filter((i) => i.outcome === 'restored').map((i) => i.name));
    setFailed(ids.filter((i) => i.outcome === 'failed').map((i) => i.name));
    setMasterCode(code);
    setTouchId(withTouchId);
    setSaved(false);
    setKitHandle(undefined);
    setView({ k: 'protect' });
  };

  const restore = async (): Promise<void> => {
    if (kitHandle === undefined || summary === undefined || gestureBusy.current) return;
    gestureBusy.current = true;
    setError(undefined);
    setWorking(true);
    try {
      const selection = summary.ids
        .filter((r) => review.selected.has(r.agentId))
        .map((r) => r.agentId);
      const names: Record<string, string> = {};
      for (const id of selection) {
        const n = review.names[id];
        if (n !== undefined) names[id] = n;
      }
      const begun = await api.applyBegin(kitHandle, selection, names);
      if (begun.kind === 'error') return fail(begun);
      const { answer } = begun;
      if (answer.status === 'done') return finishRestore(answer.ids, undefined, false);
      // No owner here: one passkey gesture creates the owner's protection (04 §2.5).
      if (!canRestoreHere()) return setView({ k: 'terminal' });
      const made = await createRestorePasskey(answer.publicKey, { platform: platform !== 'other' });
      if (made.kind === 'unsupported') return setView({ k: 'terminal' });
      if (made.kind === 'cancelled') return setError(PROBLEMS.presence_rejected);
      let finished = await api.applyFinish(answer.nonce, made.body);
      if (finished.kind === 'ok' && finished.answer.status === 'prf_needed') {
        const second = await getRestorePrf(finished.answer.publicKey, made.created);
        if (second.kind === 'unsupported') return setView({ k: 'terminal' });
        if (second.kind === 'cancelled') return setError(PROBLEMS.presence_rejected);
        finished = await api.applyFinish(finished.answer.nonce, second.body);
      }
      if (finished.kind === 'error') return fail(finished);
      if (finished.answer.status !== 'done') return setError(PROBLEMS.failed);
      finishRestore(finished.answer.ids, finished.answer.masterCode, finished.answer.touchId);
    } finally {
      gestureBusy.current = false;
      setWorking(false);
    }
  };

  // --- step 4 ---------------------------------------------------------------------------------

  const lookForApps = useCallback((): void => {
    void appsApi.list().then((r) => setApps(r.kind === 'ok' ? r.apps : []));
  }, [appsApi]);
  useEffect(() => {
    if (view.k === 'protect') lookForApps();
  }, [view.k, lookForApps]);

  // --- render ---------------------------------------------------------------------------------

  const eyebrow = check ? WIZARD.eyebrowCheck : WIZARD.eyebrow;
  const frame = (children: ReactElement): ReactElement => (
    <Frame step={stepOf(view)} check={check} onCancel={cancel}>
      {children}
    </Frame>
  );
  const shownError = waiting > 0 ? CODE.wait(waiting) : error;

  switch (view.k) {
    case 'kit':
      return frame(
        <KitStep
          eyebrow={eyebrow}
          kits={kits}
          choice={choice}
          onChoice={(h) => {
            setChoice(h);
            setPicked(undefined);
          }}
          picked={picked}
          onFile={(f) => void chooseFile(f)}
          working={working}
          error={error}
          {...(errorHint === undefined ? {} : { errorHint })}
          onContinue={() => void continueKit()}
          onStartFresh={() => leave('/')}
        />,
      );
    case 'presence':
      return frame(
        <PresenceStep
          sensor={sensor}
          hasPasskey={hasPasskey}
          working={working}
          error={error}
          onPasskey={() => void passkeyPresence()}
          onCode={(code) => void presence({ kind: 'code', code })}
          onBack={() => {
            setError(undefined);
            setView({ k: 'kit' });
          }}
        />,
      );
    case 'code':
      return frame(
        <CodeStep
          eyebrow={eyebrow}
          savedDate={savedAt === undefined ? undefined : formatDate(savedAt)}
          groups={groups}
          onGroups={setGroups}
          working={working}
          blocked={waiting > 0}
          error={shownError}
          onOpen={() => void openKit()}
          onBack={() => {
            setGroups(emptyGroups());
            setError(undefined);
            setView({ k: 'kit' });
          }}
          onStartFresh={() => leave('/')}
        />,
      );
    case 'checked':
      return frame(
        <CheckedStep
          summary={view.summary}
          onDone={() => leave('/settings/backup')}
          onAnother={() => {
            setError(undefined);
            setView({ k: 'kit' });
          }}
        />,
      );
    case 'review':
      return frame(
        <ReviewStep
          summary={summary as Summary}
          state={review}
          onState={setReview}
          sensor={sensor}
          newOwner={!ownerPresent}
          working={working}
          error={error}
          onRestore={() => void restore()}
          onBack={() => {
            if (kitHandle !== undefined) void api.cancel(kitHandle);
            setKitHandle(undefined);
            setError(undefined);
            setView({ k: 'kit' });
          }}
          onDone={cancel}
        />,
      );
    case 'terminal':
      return frame(
        <NeedsTerminal
          onBack={() => {
            setError(undefined);
            setView({ k: 'kit' });
          }}
        />,
      );
    case 'protect': {
      const first = restored[0] ?? '';
      return frame(
        <ProtectStep
          restored={restored}
          failed={failed}
          masterCode={masterCode}
          sensor={sensor}
          touchId={touchId}
          savedDate={summary === undefined ? '' : formatDate(summary.createdAt)}
          apps={apps}
          idName={first}
          connecting={connecting}
          onConnect={setConnecting}
          connectView={
            connecting === undefined || apps === undefined ? null : (
              <ConnectApp
                appsApi={appsApi}
                appId={connecting}
                appName={apps.find((a) => a.id === connecting)?.name ?? ''}
                folder={first}
                agentLabel={first}
                sensor={sensor}
                passkeyProof={passkeyProof}
                onDone={() => {
                  setConnecting(undefined);
                  lookForApps();
                }}
                onConnected={() => lookForApps()}
              />
            )
          }
          saved={saved}
          onSaved={setSaved}
          onHome={() => leave('/')}
          storage={false}
        />,
      );
    }
  }
}

export function RestoreKitPage(): ReactElement {
  return <RestoreWizard mode="restore" />;
}

export function RestoreCheckPage(): ReactElement {
  return <RestoreWizard mode="check" />;
}

export function RestoreMovePage(): ReactElement {
  return (
    <div className="rs-wizard">
      <div className="rs-body">
        <HowToMove onStart={() => navigate('/restore/kit')} onBack={() => history.back()} />
      </div>
    </div>
  );
}

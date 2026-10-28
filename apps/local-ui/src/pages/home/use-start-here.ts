// The Start here model (UX2-g; B-11 §27.3): reads, steps, what to say and when the card leaves.
//
// The shell (Layout) runs this once and shares it through StartHereContext, so the Home dot, the
// card and the empty states agree. A lone Home (tests) runs its own. Reads are plain GETs on routes
// that exist: the passkey state, the contacts list, the Messages list (Sent) and the kit flag. They
// run on mount, when the page changes, and then every 14 s while the tab is visible. A failed read
// keeps the last known answer and adds nothing alarming.
//
// Nothing here ticks a step: only an answer from a read does (copying a prompt does not).
import { useReducedMotion } from '@4thtech-io/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient } from '../../api/client.js';
import { recoveryKitPending } from '../../states/recovery-kit.js';
import { LIST_PATH, parseList, type ContactRow } from '../contacts/data.js';
import { passkeysAvailable } from '../first-run/passkey.js';
import { createUpgradeApi } from '../first-run/setup-api.js';
import { createMessagesApi } from '../messages/api.js';
import type { StartHereModel, StartPhase } from './start-here-context.js';
import {
  COUNTED,
  deriveStart,
  loadDone,
  saveDone,
  type Signals,
  type StartHereReads,
  type StepId,
} from './start-here.js';
import { START_STRINGS as T, startStepDone } from './strings.js';

const INTERVAL_MS = 14_000;
const ALL_SET_MS = 1_600;
/** The fade and collapse (`--al-duration-base`), with a little room. */
const LEAVE_MS = 260;
/** At most this many conversations are looked at for a sent message. */
const SENT_LOOKUPS = 10;

const STEP_TITLE: Readonly<Record<StepId, string>> = {
  protect: T.protect,
  invite: T.invite,
  check: T.check,
  send: T.send,
  kit: T.kit,
};

/** Approvals are protected: a passkey is registered, or this browser has no passkey to offer. */
async function defaultProtect(): Promise<boolean | undefined> {
  const info = await createUpgradeApi().info();
  if (info.kind !== 'ok') return undefined;
  return info.registered || !passkeysAvailable();
}

async function defaultContacts(): Promise<readonly ContactRow[] | undefined> {
  const result = await createApiClient().get<unknown>(LIST_PATH);
  if (result.kind !== 'ok') return undefined;
  const answer = parseList(result.data);
  return answer.kind === 'ok' ? answer.contacts : undefined;
}

/** True when a message of ours left (not just queued). Undefined when a read gave no answer. */
async function defaultSent(): Promise<boolean | undefined> {
  const api = createMessagesApi(createApiClient());
  const list = await api.conversations();
  if (!list.ok) return undefined;
  let unanswered = false;
  for (const c of list.value.slice(0, SENT_LOOKUPS)) {
    const page = await api.messages(c.contactId, 'out');
    if (!page.ok) {
      unanswered = true;
      continue;
    }
    if (page.value.items.some((i) => i.status !== 'queued' && i.status !== 'not_delivered')) {
      return true;
    }
  }
  return unanswered ? undefined : false;
}

const defaultKit = (): boolean => !recoveryKitPending();

const HIDDEN: StartHereModel = { phase: 'hidden', view: null, announce: '', inviteDone: undefined };

async function attempt<T>(read: (() => Promise<T> | T) | undefined): Promise<T | undefined> {
  if (read === undefined) return undefined;
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * `enabled` false makes the hook do nothing (Home reuses the shell's model when there is one).
 * `refreshKey` reads again when it changes (the shell passes the page's path).
 */
export function useStartHere(
  reads: StartHereReads = {},
  enabled = true,
  refreshKey = '',
): StartHereModel {
  const reduced = useReducedMotion();
  const readsRef = useRef(reads);
  readsRef.current = reads;
  const [signals, setSignals] = useState<Signals>({});
  const [loaded, setLoaded] = useState(false);
  const [remembered, setRemembered] = useState<ReadonlySet<StepId>>(() => loadDone());
  const [finish, setFinish] = useState<'none' | 'allset' | 'leaving' | 'gone'>('none');
  const [announce, setAnnounce] = useState('');
  const [fresh, setFresh] = useState<readonly StepId[]>([]);
  const live = useRef(true);
  const reading = useRef(false);
  const rememberedRef = useRef(remembered);
  rememberedRef.current = remembered;
  const wasShown = useRef(false);
  const prevDone = useRef<ReadonlySet<StepId> | null>(null);

  const readAll = useCallback(async (): Promise<void> => {
    if (reading.current) return;
    reading.current = true;
    try {
      const r = readsRef.current;
      const [protect, contacts, kit] = await Promise.all([
        attempt(r.protect ?? defaultProtect),
        attempt(r.contacts ?? defaultContacts),
        attempt(r.kitSaved ?? defaultKit),
      ]);
      let sent: boolean | undefined;
      if (!rememberedRef.current.has('send') && contacts !== undefined && contacts.length > 0) {
        sent = await attempt(() => (r.sent ?? defaultSent)(contacts));
      }
      if (!live.current) return;
      // A failed read keeps the answer from before.
      setSignals((s) => ({
        protect: protect ?? s.protect,
        contacts: contacts ?? s.contacts,
        sent: sent ?? s.sent,
        kitSaved: kit ?? s.kitSaved,
      }));
      setLoaded(true);
    } finally {
      reading.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    live.current = true;
    void readAll();
    const every = readsRef.current.intervalMs ?? INTERVAL_MS;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void readAll();
    }, every);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [enabled, readAll, refreshKey]);

  const view = useMemo(() => deriveStart(signals, remembered), [signals, remembered]);
  // The kit is never remembered: it is read again on every load (it is a cheap local read).
  let kitNow: boolean;
  try {
    kitNow = (readsRef.current.kitSaved ?? defaultKit)() === true;
  } catch {
    kitNow = false;
  }
  const rememberedComplete =
    kitNow && COUNTED.filter((id) => id !== 'kit').every((id) => remembered.has(id));

  // Remember what has happened once; a step never unticks.
  useEffect(() => {
    if (!enabled || !loaded) return;
    const doneNow = view.steps.filter((s) => s.state === 'done').map((s) => s.id);
    if (doneNow.every((id) => rememberedRef.current.has(id))) return;
    const next = new Set([...rememberedRef.current, ...doneNow]);
    saveDone(next);
    setRemembered(next);
  }, [enabled, loaded, view]);

  const visible = loaded && !view.complete && (!view.unknown || view.doneCount > 0);

  // Announce a step done while you watch; the first evaluation is the baseline.
  useEffect(() => {
    if (!enabled || !loaded) return;
    const doneNow = new Set(view.steps.filter((s) => s.state === 'done').map((s) => s.id));
    const before = prevDone.current;
    prevDone.current = doneNow;
    if (before === null) return;
    const added = [...doneNow].filter((id) => !before.has(id));
    if (added.length === 0) return;
    setFresh(added);
    if (!view.complete) {
      const last = added[added.length - 1] as StepId;
      setAnnounce(startStepDone(STEP_TITLE[last], view.doneCount, view.total));
    }
  }, [enabled, loaded, view]);

  useEffect(() => {
    if (visible) wasShown.current = true;
  }, [visible]);

  // The last of steps 1, 2, 4 and 5 ticked: "You're all set.", then the card leaves.
  useEffect(() => {
    if (!enabled || !loaded || !view.complete || finish !== 'none') return;
    if (!wasShown.current) {
      setFinish('gone');
      return;
    }
    setAnnounce(T.allSet);
    setFinish(reduced ? 'gone' : 'allset');
  }, [enabled, loaded, view.complete, finish, reduced]);

  // "You're all set." shows for 1.6 s, then the card fades and goes.
  const leaving = finish === 'allset' || finish === 'leaving';
  useEffect(() => {
    if (!leaving) return undefined;
    const hold = readsRef.current.allSetMs ?? ALL_SET_MS;
    const a = setTimeout(() => setFinish('leaving'), hold);
    const b = setTimeout(() => setFinish('gone'), hold + LEAVE_MS);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [leaving]);

  const inviteDone: boolean | undefined =
    view.steps.find((s) => s.id === 'invite')?.state === 'done'
      ? true
      : signals.contacts !== undefined
        ? false
        : undefined;

  if (!enabled) return HIDDEN;
  let phase: StartPhase;
  if (!loaded) phase = rememberedComplete ? 'hidden' : 'loading';
  else if (finish === 'allset') phase = 'allset';
  else if (finish === 'leaving') phase = 'leaving';
  else if (finish === 'gone' || !visible) phase = 'hidden';
  else phase = 'shown';
  return {
    phase,
    view: phase === 'loading' || phase === 'hidden' ? null : view,
    announce,
    inviteDone,
    fresh,
  };
}

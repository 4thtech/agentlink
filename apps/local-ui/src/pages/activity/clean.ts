// W4-SETTINGS-ADVANCED (I-5): a name or a state as plain, bounded text for the live stream and the
// diagnostics report. A name can carry control and bidi characters; they are removed, not escaped.
//
// UX1113 WP-A2: also the pure half of the Activity page: the check of each feed entry (an entry or a
// field outside the allowlist is dropped, never guessed) and the plain sentence for each kind. No JSX
// here: a sentence is a list of parts, and the page renders a name as text in <bdi> (I-5).
import { ACTIVITY_COPY as S, APP_NAMES, type Pair } from './strings.js';

const MAX_TEXT = 200;
/** Control characters, and the bidi marks, embeddings, overrides and isolates (written as escapes). */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;

/** A name as plain, bounded text. */
export function cleanLine(text: string): string {
  return text.replace(UNSAFE, '').slice(0, MAX_TEXT);
}

// ---------------------------------------------------------------------------------------------------
// The feed (the shape WP-A1 froze: `{items, nextCursor?}`)

export type Decision = 'approved' | 'approved_by_rules' | 'denied' | 'cancelled';
export type ProofView = 'submitted' | 'needs_credits' | 'failed' | 'recorded' | 'received';
export const ACTION_TYPES = [
  'send_message',
  'send_file',
  'add_proof',
  'accept_invite',
  'offer_terms',
  'accept_terms',
  'reject_terms',
  'counter_terms',
  'accept_record',
  'reject_record',
  'share_proof_key',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface ActionView {
  readonly type: ActionType;
  readonly contactId?: string;
  readonly files: readonly { readonly name: string; readonly size: number }[];
  readonly costUsd?: string;
}

/** One feed entry as the page shows it. */
export type ActivityItem =
  | {
      readonly kind: 'approval_decided';
      readonly at: number;
      readonly decision: Decision;
      readonly action?: ActionView;
    }
  | {
      readonly kind: 'proof';
      readonly at: number;
      readonly direction: 'sent' | 'received';
      readonly state: ProofView;
      readonly contactId?: string;
      readonly costUsd?: string;
    }
  | { readonly kind: 'sender_blocked'; readonly at: number; readonly senderCode: string }
  | { readonly kind: 'contact_blocked'; readonly at: number; readonly contactId?: string }
  | { readonly kind: 'contact_unblocked'; readonly at: number; readonly contactId?: string }
  | { readonly kind: 'contact_checked'; readonly at: number; readonly contactId?: string }
  | { readonly kind: 'contact_removed'; readonly at: number; readonly contactId?: string }
  | { readonly kind: 'contact_revoked'; readonly at: number; readonly contactId?: string }
  // R1-SEC-03 (04 §3.6): someone else also answered the invite this contact used.
  | { readonly kind: 'invite_answered_twice'; readonly at: number; readonly contactId?: string }
  | {
      readonly kind: 'contact_renamed';
      readonly at: number;
      readonly contactId?: string;
      readonly formerName: string;
      readonly newName: string;
    }
  | {
      readonly kind: 'contact_connected';
      readonly at: number;
      readonly contactId?: string;
      readonly via?: 'your_invite' | 'their_invite';
    }
  | { readonly kind: 'id_renamed'; readonly at: number; readonly name?: string }
  | { readonly kind: 'id_created'; readonly at: number; readonly name?: string }
  | { readonly kind: 'app_connected'; readonly at: number; readonly app?: string }
  | { readonly kind: 'app_disconnected'; readonly at: number; readonly app?: string }
  | {
      readonly kind: 'rules_changed' | 'id_removed' | 'id_paused' | 'id_resumed' | 'backup_saved';
      readonly at: number;
    };

const DECISIONS: ReadonlySet<string> = new Set([
  'approved',
  'approved_by_rules',
  'denied',
  'cancelled',
]);
const PROOF_VIEWS: ReadonlySet<string> = new Set([
  'submitted',
  'needs_credits',
  'failed',
  'recorded',
  'received',
]);
const ACTIONS: ReadonlySet<string> = new Set(ACTION_TYPES);
const PLAIN_KINDS: ReadonlySet<string> = new Set([
  'rules_changed',
  'id_removed',
  'id_paused',
  'id_resumed',
  'backup_saved',
]);
const MAX_CODE = 64;
const MAX_NAME = 80;
const MAX_FILES = 20;
const CONTACT_REF = /^0x[0-9a-f]{40}$/;
const USD = /^(0|[1-9][0-9]{0,8})(\.[0-9]{0,5}[1-9])?$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const ref = (v: unknown): { contactId?: string } =>
  typeof v === 'string' && CONTACT_REF.test(v.toLowerCase()) ? { contactId: v.toLowerCase() } : {};
const usd = (v: unknown): { costUsd?: string } =>
  typeof v === 'string' && USD.test(v) ? { costUsd: v } : {};
const plain = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = cleanLine(v).trim();
  return t.length > 0 && t.length <= MAX_NAME ? t : undefined;
};
/**
 * QA2: an ID's name is the owner's own label (at most 32 code points, plain text, as the API checks
 * it): one with a control or direction character is dropped, not cleaned into another name.
 */
const ownLabel = (v: unknown): string | undefined => {
  if (typeof v !== 'string' || cleanLine(v) !== v) return undefined;
  const t = v.trim();
  return t.length > 0 && Array.from(t).length <= 32 ? t : undefined;
};

/**
 * QA2 (N7): an approval's action in the shape the API froze (api/activity.ts): `action` is the type,
 * and `contactId`, `files` and `costUsd` sit on the entry itself. Undefined for an unknown type.
 */
function parseAction(raw: Record<string, unknown>): ActionView | undefined {
  const type = raw['action'];
  if (typeof type !== 'string' || !ACTIONS.has(type)) return undefined;
  const files: { name: string; size: number }[] = [];
  const rawFiles = raw['files'];
  if (Array.isArray(rawFiles)) {
    for (const f of (rawFiles as unknown[]).slice(0, MAX_FILES)) {
      if (!isRecord(f)) continue;
      const name = plain(f['name']);
      const size = f['size'];
      if (
        name !== undefined &&
        typeof size === 'number' &&
        Number.isSafeInteger(size) &&
        size >= 0
      ) {
        files.push({ name, size });
      }
    }
  }
  return { type: type as ActionType, ...ref(raw['contactId']), files, ...usd(raw['costUsd']) };
}

/** One entry, or undefined when it is not one this page knows (skipped, never guessed). */
export function parseItem(raw: unknown): ActivityItem | undefined {
  if (!isRecord(raw)) return undefined;
  const { kind, at } = raw;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return undefined;
  if (typeof kind !== 'string') return undefined;
  if (PLAIN_KINDS.has(kind)) return { kind: kind as 'rules_changed', at };
  switch (kind) {
    case 'approval_decided': {
      const decision = raw['decision'];
      if (typeof decision !== 'string' || !DECISIONS.has(decision)) return undefined;
      const action = parseAction(raw);
      return {
        kind,
        at,
        decision: decision as Decision,
        ...(action === undefined ? {} : { action }),
      };
    }
    case 'proof': {
      const { direction, state } = raw;
      if (direction !== 'sent' && direction !== 'received') return undefined;
      if (typeof state !== 'string' || !PROOF_VIEWS.has(state)) return undefined;
      return {
        kind,
        at,
        direction,
        state: state as ProofView,
        ...ref(raw['contactId']),
        ...usd(raw['costUsd']),
      };
    }
    case 'sender_blocked': {
      const code = raw['senderCode'];
      return typeof code === 'string' && code.length > 0 && code.length <= MAX_CODE
        ? { kind, at, senderCode: cleanLine(code) }
        : undefined;
    }
    case 'contact_blocked':
    case 'contact_unblocked':
    case 'contact_checked':
    case 'contact_removed':
    case 'contact_revoked':
    case 'invite_answered_twice':
      return { kind, at, ...ref(raw['contactId']) };
    case 'contact_renamed': {
      const formerName = plain(raw['formerName']);
      const newName = plain(raw['newName']);
      // QA2: never "{name} is now called {name}".
      return formerName === undefined || newName === undefined || formerName === newName
        ? undefined
        : { kind, at, ...ref(raw['contactId']), formerName, newName };
    }
    case 'contact_connected': {
      const via = raw['via'];
      return {
        kind,
        at,
        ...ref(raw['contactId']),
        ...(via === 'your_invite' || via === 'their_invite' ? { via } : {}),
      };
    }
    case 'id_renamed':
    case 'id_created': {
      const name = ownLabel(raw['name']);
      return name === undefined ? { kind, at } : { kind, at, name };
    }
    case 'app_connected':
    case 'app_disconnected': {
      const app = raw['app'];
      return typeof app === 'string' && Object.hasOwn(APP_NAMES, app)
        ? { kind, at, app }
        : { kind, at };
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------
// Money and sizes

/** "0.05" -> "$0.05", "1" -> "$1.00", "0.123" -> "$0.123". */
export function formatUsd(amount: string): string {
  const [whole = '0', frac = ''] = amount.split('.');
  return `$${whole}.${frac.padEnd(2, '0')}`;
}

/** Sums USD amounts exactly (micros). */
export function sumUsd(amounts: readonly string[]): string {
  let micros = 0n;
  for (const a of amounts) {
    const [whole = '0', frac = ''] = a.split('.');
    micros += BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6));
  }
  const whole = micros / 1_000_000n;
  const frac = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole.toString()}.${frac}`;
}

/** "2.1 MB". Plain base-1000 sizes, as the file pages show them. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 10 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString()} ${units[i] ?? 'GB'}`;
}

// ---------------------------------------------------------------------------------------------------
// The sentence for each kind

/** A piece of a sentence: plain words, a person's name (text in <bdi>), or a file name (bold text). */
export type Part = string | { readonly name: string } | { readonly file: string };

export type Tone = 'success' | 'info' | 'neutral' | 'danger' | 'warning' | 'proof';
export type IconName =
  | 'check'
  | 'x'
  | 'ban'
  | 'proof-seal'
  | 'user-plus'
  | 'users'
  | 'sliders-horizontal'
  | 'agent'
  | 'ai-app'
  | 'hard-drive'
  | 'untrusted'
  | 'pause'
  | 'play'
  | 'minus'
  | 'plus'
  | 'approval';

export interface Rendered {
  readonly icon: IconName;
  readonly tone: Tone;
  readonly sentence: readonly Part[];
  /** The one grey line under the sentence. */
  readonly grey: string;
  readonly pill: string;
  /** Labelled facts for the opened row (no label without a value). */
  readonly facts: readonly { readonly label: string; readonly parts: readonly Part[] }[];
  /** Where the opened row leads. */
  readonly link?: { readonly label: string; readonly href: string };
  /** Everything the search matches: the sentence in words, and the action words. */
  readonly search: string;
}

/** Resolves a contact reference to the shown name; undefined for one this page cannot name. */
export type NameOf = (contactId: string | undefined) => string | undefined;

/** Fills a template: `{who}` becomes a name part, `{file}` a file part, the rest plain text. */
export function fill(
  template: string,
  values: Readonly<Record<string, string | Part>>,
): readonly Part[] {
  const parts: Part[] = [];
  for (const piece of template.split(/(\{[a-z]+\})/)) {
    const m = /^\{([a-z]+)\}$/.exec(piece);
    const value = m === null ? undefined : values[m[1] ?? ''];
    if (value !== undefined) parts.push(value);
    else if (piece !== '') parts.push(piece);
  }
  return parts;
}

const pick = (pair: Pair, named: boolean): string => (named ? pair[0] : pair[1]);

export function partsText(parts: readonly Part[]): string {
  return parts.map((p) => (typeof p === 'string' ? p : 'name' in p ? p.name : p.file)).join('');
}

interface ActionText {
  readonly act: readonly Part[];
  readonly what: string;
  readonly inbound: boolean;
}

function actionOf(action: ActionView | undefined, who: string | undefined): ActionText {
  const named = who !== undefined;
  const v: Record<string, Part> = named ? { who: { name: who } } : {};
  const act = (
    pair: Pair,
    what: string,
    inbound = false,
    extra: Record<string, Part> = {},
  ): ActionText => ({
    act: fill(pick(pair, named), { ...v, ...extra }),
    what,
    inbound,
  });
  switch (action?.type) {
    case 'send_message':
      return act(S.actSendMessage, S.whatSendMessage);
    case 'send_file': {
      const files = action.files;
      const first = files[0];
      if (files.length === 1 && first !== undefined) {
        return act(S.actSendFile, S.whatSendFile, false, { file: { file: first.name } });
      }
      if (files.length > 1) {
        return act(
          S.actSendFiles,
          fill(S.whatSendFiles, { n: String(files.length) }).join(''),
          false,
          {
            n: String(files.length),
          },
        );
      }
      return act(S.actSendFileUnnamed, S.whatSendFile);
    }
    case 'add_proof':
      return act(S.actAddProof, S.whatAddProof);
    case 'accept_invite':
      return act(S.actAcceptInvite, S.whatAcceptInvite, true);
    case 'offer_terms':
      return act(S.actOfferTerms, S.whatOfferTerms);
    case 'accept_terms':
      return act(S.actAcceptTerms, S.whatAcceptTerms, true);
    case 'reject_terms':
      return act(S.actRejectTerms, S.whatRejectTerms, true);
    case 'counter_terms':
      return act(S.actCounterTerms, S.whatCounterTerms, true);
    case 'accept_record':
      return act(S.actAcceptRecord, S.whatAcceptRecord, true);
    case 'reject_record':
      return act(S.actRejectRecord, S.whatRejectRecord, true);
    case 'share_proof_key':
      return act(S.actShareProofKey, S.whatShareProofKey);
    default:
      return act(S.actUnknown, S.whatUnknown);
  }
}

const lower = (s: string): string => s.toLowerCase();

/** The plain sentence, grey line, pill and opened-row facts for one entry. */
export function render(item: ActivityItem, nameOf: NameOf, whenText: string): Rendered {
  const when = { label: S.rowWhen, parts: [whenText] as readonly Part[] };
  const withWhen = (
    facts: readonly { label: string; parts: readonly Part[] }[],
  ): Rendered['facts'] => [...facts, when];
  const link = (label: string, href: string): { label: string; href: string } => ({ label, href });
  const build = (
    r: Omit<Rendered, 'search' | 'facts'> & { facts?: Rendered['facts']; words?: string },
  ): Rendered => ({
    ...r,
    facts: withWhen(r.facts ?? []),
    search: lower(`${partsText(r.sentence)} ${r.grey} ${r.pill} ${r.words ?? ''}`),
  });
  const who = (id: string | undefined): string | undefined => nameOf(id);
  const names = (pair: Pair, id: string | undefined): readonly Part[] => {
    const n = who(id);
    return fill(pick(pair, n !== undefined), n === undefined ? {} : { who: { name: n } });
  };

  switch (item.kind) {
    case 'approval_decided': {
      const a = item.action;
      const n = who(a?.contactId);
      const t = actionOf(a, n);
      // QA2: accepting an invite is the owner's own act, also when done in the app; the store cannot
      // tell who asked, so it never says "Asked by your AI".
      const invite = a?.type === 'accept_invite' && item.decision !== 'approved_by_rules';
      const template =
        item.decision === 'approved'
          ? S.approved
          : item.decision === 'approved_by_rules'
            ? S.approvedByRules
            : item.decision === 'denied'
              ? S.denied
              : S.cancelled;
      const sentence = invite
        ? fill(
            pick(
              item.decision === 'approved'
                ? S.inviteAccepted
                : item.decision === 'denied'
                  ? S.inviteDeclined
                  : S.inviteCancelled,
              n !== undefined,
            ),
            n === undefined ? {} : { who: { name: n } },
          )
        : fill(template, {}).flatMap((p) =>
            typeof p === 'string' && p.includes('{action}') ? [...splitAction(p, t.act)] : [p],
          );
      const cost = a?.costUsd === undefined ? undefined : formatUsd(a.costUsd);
      const outcome = t.inbound ? S.nothingAccepted : S.nothingSent;
      const grey = [
        invite ? S.inviteByYou : S.askedByAi,
        ...(item.decision === 'approved_by_rules' ? [S.decidedByRulesLine] : []),
        ...(item.decision === 'denied' || item.decision === 'cancelled' ? [outcome] : []),
        ...(cost === undefined ? [] : [cost]),
      ].join(' · ');
      const facts: { label: string; parts: readonly Part[] }[] = [
        { label: S.rowWhat, parts: [t.what] },
      ];
      if (a !== undefined && a.files.length > 0) {
        facts.push({
          label: S.rowFiles,
          parts: a.files.flatMap((f, i): Part[] => [
            ...(i > 0 ? [', '] : []),
            { file: f.name },
            ` (${formatSize(f.size)})`,
          ]),
        });
      }
      facts.push({
        label: S.rowDecidedBy,
        parts: [
          item.decision === 'approved'
            ? S.decidedByYou
            : item.decision === 'approved_by_rules'
              ? S.decidedByRules
              : S.decidedByYou,
        ],
      });
      if (cost !== undefined) facts.push({ label: S.rowCost, parts: [cost] });
      return build({
        icon:
          item.decision === 'approved'
            ? 'check'
            : item.decision === 'approved_by_rules'
              ? 'sliders-horizontal'
              : 'x',
        tone:
          item.decision === 'approved'
            ? 'success'
            : item.decision === 'approved_by_rules'
              ? 'info'
              : item.decision === 'denied'
                ? 'danger'
                : 'neutral',
        sentence,
        grey,
        pill:
          item.decision === 'approved'
            ? S.pillApproved
            : item.decision === 'approved_by_rules'
              ? S.pillByRules
              : item.decision === 'denied'
                ? S.pillDenied
                : S.pillCancelled,
        facts,
        words: `${t.what} ${a?.files.map((f) => f.name).join(' ') ?? ''}`,
      });
    }
    case 'proof': {
      const received = item.direction === 'received' || item.state === 'received';
      const pair = received
        ? S.proofReceived
        : item.state === 'recorded'
          ? S.proofRecorded
          : item.state === 'submitted'
            ? S.proofSubmitted
            : item.state === 'needs_credits'
              ? S.proofNeedsCredits
              : S.proofFailed;
      const pill = received
        ? S.pillReceived
        : item.state === 'recorded'
          ? S.pillRecorded
          : item.state === 'submitted'
            ? S.pillSubmitted
            : item.state === 'needs_credits'
              ? S.pillNeedsCredits
              : S.pillFailed;
      const cost = item.costUsd === undefined ? undefined : formatUsd(item.costUsd);
      return build({
        icon: 'proof-seal',
        tone:
          item.state === 'failed' ? 'danger' : item.state === 'needs_credits' ? 'warning' : 'proof',
        sentence: names(pair, item.contactId),
        grey: cost === undefined ? S.proofLine : `${S.proofLine} · ${cost}`,
        pill,
        facts: cost === undefined ? [] : [{ label: S.rowCost, parts: [cost] }],
        link: link(S.linkProofs, '/settings/proofs'),
        words: 'proof',
      });
    }
    case 'sender_blocked':
      return build({
        icon: 'untrusted',
        tone: 'warning',
        sentence: [S.senderBlocked],
        grey: fill(S.senderLine, { code: item.senderCode }).join(''),
        pill: S.pillDropped,
        link: link(S.linkRules, '/settings/rules'),
        words: 'blocked unknown sender',
      });
    case 'contact_blocked':
      return build({
        icon: 'ban',
        tone: 'neutral',
        sentence: names(S.contactBlocked, item.contactId),
        grey: S.contactBlockedLine,
        pill: S.pillBlocked,
        link: link(S.linkPeople, '/contacts'),
      });
    case 'contact_unblocked':
      return build({
        icon: 'ban',
        tone: 'neutral',
        sentence: names(S.contactUnblocked, item.contactId),
        grey: S.contactUnblockedLine,
        pill: S.pillUnblocked,
        link: link(S.linkPeople, '/contacts'),
        words: 'unblocked',
      });
    case 'contact_checked':
      return build({
        icon: 'check',
        tone: 'success',
        sentence: names(S.contactChecked, item.contactId),
        grey: S.contactCheckedLine,
        pill: S.pillChecked,
        link: link(S.linkPeople, '/contacts'),
        words: 'contact check safety code',
      });
    case 'contact_removed':
      return build({
        icon: 'minus',
        tone: 'neutral',
        sentence: names(S.contactRemoved, item.contactId),
        grey: S.contactRemovedLine,
        pill: S.pillRemoved,
        link: link(S.linkPeople, '/contacts'),
      });
    case 'contact_revoked':
      return build({
        icon: 'minus',
        tone: 'neutral',
        sentence: names(S.contactRevoked, item.contactId),
        grey: S.contactRevokedLine,
        pill: S.pillRemoved,
        link: link(S.linkPeople, '/contacts'),
      });
    case 'invite_answered_twice':
      // R1-SEC-03 (04 §3.6; 11 §6 "Invite answered twice"; D-146: the 12 digits, the Contact check).
      return build({
        icon: 'untrusted',
        tone: 'warning',
        sentence: names(S.inviteAnsweredTwice, item.contactId),
        grey: S.inviteAnsweredTwiceLine,
        pill: S.pillAnsweredTwice,
        link: link(S.linkPeople, '/contacts'),
        words: 'invite answered twice contact check 12 digits',
      });
    case 'contact_renamed':
      return build({
        icon: 'users',
        tone: 'neutral',
        sentence: fill(S.contactRenamed, {
          former: { name: item.formerName },
          new: { name: item.newName },
        }),
        grey: S.contactRenamedLine,
        pill: S.pillRenamed,
        link: link(S.linkPeople, '/contacts'),
      });
    case 'contact_connected':
      return build({
        icon: 'user-plus',
        tone: 'success',
        sentence: names(
          // QA2: accepting their invite is its own row (the owner's decision); this one says the
          // connection is made, without repeating "You accepted".
          item.via === 'your_invite' ? S.contactConnectedYours : S.contactConnected,
          item.contactId,
        ),
        grey: S.contactConnectedLine,
        pill: S.pillConnected,
        link: link(S.linkPeople, '/contacts'),
      });
    case 'rules_changed':
      return build({
        icon: 'sliders-horizontal',
        tone: 'neutral',
        sentence: [S.rulesChanged],
        grey: S.rulesChangedLine,
        pill: S.pillRules,
        link: link(S.linkRules, '/settings/rules'),
      });
    case 'id_created':
    case 'id_removed':
    case 'id_paused':
    case 'id_resumed':
    case 'id_renamed': {
      const [text, line, icon] =
        item.kind === 'id_created'
          ? ([S.idCreated, S.idCreatedLine, 'plus'] as const)
          : item.kind === 'id_removed'
            ? ([S.idRemoved, S.idRemovedLine, 'minus'] as const)
            : item.kind === 'id_paused'
              ? ([S.idPaused, S.idPausedLine, 'pause'] as const)
              : item.kind === 'id_resumed'
                ? ([S.idResumed, S.idResumedLine, 'play'] as const)
                : ([
                    item.kind === 'id_renamed' && item.name !== undefined
                      ? S.idRenamed
                      : S.idRenamedUnnamed,
                    S.idRenamedLine,
                    'agent',
                  ] as const);
      const named =
        (item.kind === 'id_renamed' || item.kind === 'id_created') && item.name !== undefined
          ? item.name
          : undefined;
      return build({
        icon,
        tone: 'neutral',
        sentence: fill(
          item.kind === 'id_created' && named !== undefined ? S.idCreatedNamed : text,
          named === undefined ? {} : { name: { name: named } },
        ),
        grey: line,
        pill: S.pillId,
        link: link(S.linkIds, '/agents'),
      });
    }
    case 'app_connected':
    case 'app_disconnected': {
      const app = item.app === undefined ? undefined : APP_NAMES[item.app];
      const connected = item.kind === 'app_connected';
      const text = connected
        ? app === undefined
          ? S.appConnectedUnnamed
          : S.appConnected
        : app === undefined
          ? S.appDisconnectedUnnamed
          : S.appDisconnected;
      return build({
        icon: 'ai-app',
        tone: 'neutral',
        sentence: fill(text, app === undefined ? {} : { app: { file: app } }),
        grey: connected ? S.appConnectedLine : S.appDisconnectedLine,
        pill: S.pillApp,
        link: link(S.linkApps, '/settings/apps'),
      });
    }
    case 'backup_saved':
      return build({
        icon: 'hard-drive',
        tone: 'success',
        sentence: [S.backupSaved],
        grey: S.backupSavedLine,
        pill: S.pillBackup,
        link: link(S.linkBackup, '/settings/backup'),
      });
  }
}

/** Replaces `{action}` inside one plain piece with the action's parts. */
function splitAction(piece: string, action: readonly Part[]): readonly Part[] {
  const [before = '', after = ''] = piece.split('{action}');
  return [...(before === '' ? [] : [before]), ...action, ...(after === '' ? [] : [after])];
}

// ---------------------------------------------------------------------------------------------------
// Counts and filters

export type Filter = 'all' | 'approvals' | 'proofs' | 'people' | 'safety';
export type CountKey = 'approved' | 'rules' | 'blocked' | 'proofs';

export function inCount(item: ActivityItem, key: CountKey): boolean {
  switch (key) {
    case 'approved':
      return item.kind === 'approval_decided' && item.decision === 'approved';
    case 'rules':
      return item.kind === 'approval_decided' && item.decision === 'approved_by_rules';
    case 'blocked':
      return (
        (item.kind === 'approval_decided' && item.decision === 'denied') ||
        item.kind === 'sender_blocked' ||
        item.kind === 'contact_blocked'
      );
    case 'proofs':
      return (
        item.kind === 'proof' &&
        (item.state === 'recorded' || item.state === 'submitted' || item.state === 'received')
      );
  }
}

export const WEEK_SECONDS = 7 * 24 * 3600;

/** QA2: the kinds the Safety filter shows (with denied approvals). */
const SAFETY_KINDS: ReadonlySet<string> = new Set([
  'rules_changed',
  'invite_answered_twice',
  'sender_blocked',
  'contact_blocked',
  'contact_unblocked',
  'contact_checked',
  'backup_saved',
]);

export function inFilter(item: ActivityItem, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'approvals':
      return item.kind === 'approval_decided';
    case 'proofs':
      return item.kind === 'proof';
    case 'safety':
      return (
        SAFETY_KINDS.has(item.kind) ||
        (item.kind === 'approval_decided' && item.decision === 'denied')
      );
    case 'people':
      // QA2: a saved kit, a block, an unblock and a Contact check are Safety, not People & IDs.
      return (
        !SAFETY_KINDS.has(item.kind) &&
        (item.kind.startsWith('contact_') ||
          item.kind.startsWith('id_') ||
          item.kind.startsWith('app_'))
      );
  }
}

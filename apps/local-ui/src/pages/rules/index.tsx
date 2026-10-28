// Rules (M1-11c-a5; d1 Local-rules with DESIGN-ADJ-1 RU-2…RU-6 and LS-1; UX audit 6a–6c; 06 §3;
// 11 §5, §6.2.1; D-118, D-119).
//
// The rules in two groups: "Everyday" (adding proof with its budget, new contacts, accepting terms)
// and a collapsed "More rules" (unknown senders, who can message, files, exports, and the limits for
// accepting terms on their own). Each row shows its current value; edits stay on the page in a
// draft with an unsaved-changes bar. Saving asks the server to prepare the edit (core
// preparePolicyEdit), shows every warning it returned in plain words, and the owner ticks each one;
// only then is the save button live. The save is one owner operation through the server's presence
// gate: the browser never signs (owner.ts). Contact rules and delivery confirmations (RU-1) wait for
// design brief B-5 (M1-11c-a5b); this page does not show them.
//
// Deviation from the d1 screen (D-116 rule 4, UX audit 6a/6c, flagged in the PR): the two groups and
// the unsaved-changes bar in place of one flat list with a top Save button.
import {
  Banner,
  Button,
  Icon,
  Segmented,
  Skeleton,
  SuccessMoment,
  Surface,
  Switch,
  TextField,
} from '@4thtech-io/ui';
import { UnderTheHood } from '../../lazy/hood.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { EARLIER_OWNER_CODE_HINT, PAGE_TITLES } from '../../strings.js';
import {
  RULES_PATH,
  checkDraft,
  dollars,
  draftOf,
  parseReview,
  parseRules,
  reviewPath,
  buyOn as viewBuyOn,
  sellOn as viewSellOn,
  type Draft,
  type Review,
  type RulesView,
} from './data.js';
import { createOwnerClient, type OwnerClient, type PasskeyInfo, type SaveAnswer } from './owner.js';
import {
  PayConfirm,
  createPayConfirmClient,
  type PayConfirmClient,
  type PayConfirmInput,
} from '../../pay-confirm/index.js';
import { RULES_STRINGS as S } from './strings.js';
import { warningText } from './warnings.js';
import './rules.css';

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly version: number; readonly rules: RulesView }
  | { readonly kind: 'not_valid' }
  | { readonly kind: 'not_set_up' }
  | { readonly kind: 'unavailable' };

interface Confirm {
  readonly kind: 'confirm';
  readonly review: Review;
  readonly acks: ReadonlySet<string>;
  readonly keep: boolean;
  readonly passkey: PasskeyInfo | null;
  readonly busy: boolean;
  readonly error?: string;
  /**
   * M1-PAY-CONFIRM-b (04 §2.5.3 table; D-132): the edit changes a spending limit, so it is
   * confirmed on the confirmation sheet with the platform check, not by the ordinary save.
   */
  readonly spending: boolean;
}

type Step = { readonly kind: 'edit' } | { readonly kind: 'preparing' } | Confirm;

interface Notice {
  readonly tone: 'success' | 'warning';
  readonly text: string;
}

export interface RulesPageProps {
  readonly api?: ApiClient;
  readonly owner?: OwnerClient;
  readonly payConfirm?: PayConfirmClient;
}

/** The spending fields of the proofs section (04 §2.5.3 "Which actions"). */
const SPENDING_FIELDS = ['notarize', 'dailyBudgetUSD', 'perActionMaxUSD'] as const;

function Row({
  title,
  help,
  control,
  children,
  tone,
}: {
  title: string;
  help?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  tone?: 'commit';
}): ReactElement {
  return (
    <div className={tone === 'commit' ? 'rl-row is-commit' : 'rl-row'}>
      <div className="rl-row-main">
        <div className="rl-row-text">
          <div className="al-text-body">{title}</div>
          {help === undefined ? null : <div className="al-text-caption al-muted">{help}</div>}
        </div>
        {control === undefined ? null : <div className="rl-row-control">{control}</div>}
      </div>
      {children === undefined ? null : <div className="rl-row-extra">{children}</div>}
    </div>
  );
}

/** The summary's word for a three-way rule. */
const ruleWord = (v: 'allow' | 'approval' | 'deny'): string =>
  v === 'allow' ? S.allowed : v === 'approval' ? S.askMe : S.never;

const unique = (codes: readonly string[]): string[] => [...new Set(codes)];

export function RulesPage({ api, owner, payConfirm }: RulesPageProps = {}): ReactElement {
  const client = useMemo(() => api ?? createApiClient(), [api]);
  const ownerClient = useMemo(() => owner ?? createOwnerClient(), [owner]);
  const payClient = useMemo(() => payConfirm ?? createPayConfirmClient(), [payConfirm]);
  const [sheet, setSheet] = useState<PayConfirmInput | undefined>(undefined);
  const sheetDone = useRef(false);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [moreOpen, setMoreOpen] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'edit' });
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [code, setCode] = useState('');

  const reload = useCallback(async (): Promise<void> => {
    const res = await client.get(RULES_PATH);
    let next: Load;
    if (res.kind === 'ok') next = parseRules(res.data);
    else if (res.kind === 'error' && res.status === 409) next = { kind: 'not_set_up' };
    else next = { kind: 'unavailable' };
    setLoad(next);
    setDraft(next.kind === 'ok' ? draftOf(next.rules) : undefined);
    setStep({ kind: 'edit' });
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const view = load.kind === 'ok' ? load.rules : undefined;
  const checked = useMemo(
    () => (view === undefined || draft === undefined ? undefined : checkDraft(view, draft)),
    [view, draft],
  );

  const edit = (patch: Partial<Draft>): void => {
    setNotice(undefined);
    setDraft((d) => (d === undefined ? d : { ...d, ...patch }));
  };

  /** Prepares the edit on the server and opens the confirm step. */
  const prepare = async (keep?: boolean): Promise<void> => {
    if (load.kind !== 'ok' || checked === undefined) return;
    if (step.kind !== 'confirm') setStep({ kind: 'preparing' });
    const res = await client.get(reviewPath(load.version, checked.patch, keep));
    const review = res.kind === 'ok' ? parseReview(res.data) : undefined;
    if (review === undefined) {
      setStep({ kind: 'edit' });
      setNotice({
        tone: 'warning',
        text:
          res.kind === 'error' && res.status === 409
            ? S.stale
            : res.kind === 'error' && res.status === 400
              ? S.invalidEdit
              : res.kind === 'session_expired'
                ? S.sessionExpired
                : S.failed,
      });
      return;
    }
    const passkey = step.kind === 'confirm' ? step.passkey : await ownerClient.passkey();
    const proofs = checked.patch['proofs'] ?? {};
    setCode('');
    setStep({
      kind: 'confirm',
      review,
      acks: new Set(),
      keep: keep ?? false,
      passkey,
      busy: false,
      spending: SPENDING_FIELDS.some((f) => proofs[f] !== undefined),
    });
  };

  /** M1-PAY-CONFIRM-b: a spending change opens the sheet with the review the owner ticked. */
  const confirmSpending = (confirm: Confirm): void => {
    sheetDone.current = false;
    setSheet({
      flow: 'limits',
      review: confirm.review.review,
      acknowledged: unique(confirm.review.warnings.map((w) => w.code)),
    });
  };
  const onSheetDone = async (): Promise<void> => {
    sheetDone.current = true;
    await reload();
    setNotice({ tone: 'success', text: S.saved });
  };
  const onSheetClose = (): void => {
    setSheet(undefined);
    // The begin took the review: a new one, so the owner can try again.
    if (!sheetDone.current && step.kind === 'confirm') void prepare(step.keep);
  };
  const sheetView =
    sheet === undefined ? null : (
      <PayConfirm
        client={payClient}
        input={sheet}
        onDone={() => void onSheetDone()}
        onClose={onSheetClose}
      />
    );

  const save = async (confirm: Confirm): Promise<void> => {
    setStep({ ...confirm, busy: true });
    const acknowledged = unique(confirm.review.warnings.map((w) => w.code));
    const presence =
      confirm.passkey === null
        ? ({ kind: 'code', code } as const)
        : ({ kind: 'passkey', passkey: confirm.passkey } as const);
    const answer: SaveAnswer = await ownerClient.save(
      RULES_PATH,
      { review: confirm.review.review, acknowledged },
      presence,
    );
    setCode('');
    const stay = (error: string): void => setStep({ ...confirm, busy: false, error });
    const back = (text: string): void => {
      setStep({ kind: 'edit' });
      setNotice({ tone: 'warning', text });
    };
    switch (answer.kind) {
      case 'saved':
        await reload();
        setNotice({ tone: 'success', text: S.saved });
        return;
      case 'wrong_code':
        return stay(S.wrongCode);
      case 'wait':
        return stay(S.wait(answer.seconds));
      case 'busy':
        return stay(S.busy);
      case 'passkey_cancelled':
        return stay(S.passkeyCancelled);
      case 'stale':
        return back(S.stale);
      case 'session_expired':
        return back(S.sessionExpired);
      case 'refused':
        return back(S.refused);
      default:
        return back(S.failed);
    }
  };

  const title = <h1 className="al-text-title-1">{PAGE_TITLES.rules}</h1>;
  const header = (
    <header className="rl-header">
      <div>
        <div className="al-text-label al-muted">{S.eyebrow}</div>
        {title}
      </div>
      <span className="al-text-body-sm al-muted">{S.savingNote}</span>
    </header>
  );

  if (load.kind !== 'ok' || draft === undefined || view === undefined || checked === undefined) {
    const message =
      load.kind === 'loading'
        ? S.loading
        : load.kind === 'not_valid'
          ? S.notValid
          : load.kind === 'not_set_up'
            ? S.notSetUp
            : S.unavailable;
    return (
      <>
        {header}
        {load.kind === 'loading' ? (
          <Skeleton loading label={message} lines={5} />
        ) : (
          <Banner tone={load.kind === 'not_valid' ? 'warning' : 'info'}>{message}</Banner>
        )}
      </>
    );
  }

  const noticeBanner =
    notice === undefined ? null : notice.tone === 'success' ? (
      <SuccessMoment kind="approved" label={notice.text} />
    ) : (
      <Banner tone={notice.tone} compact>
        {notice.text}
      </Banner>
    );

  if (step.kind === 'confirm') {
    return (
      <>
        {header}
        {noticeBanner}
        <ConfirmStep
          confirm={step}
          code={code}
          sellAmount={dollars(draft.sellMinUSD)}
          onCode={setCode}
          onAck={(c, on) => {
            const acks = new Set(step.acks);
            if (on) acks.add(c);
            else acks.delete(c);
            const { error: _error, ...rest } = step;
            void _error;
            setStep({ ...rest, acks });
          }}
          onKeep={(keep) => void prepare(keep)}
          onSave={() => (step.spending ? confirmSpending(step) : void save(step))}
          onBack={() => setStep({ kind: 'edit' })}
        />
        {sheetView}
      </>
    );
  }

  const c = view.commitments;
  const listedNone = c.autoAcceptContacts === 0;
  const amountError = (key: keyof Draft): { error?: string } =>
    checked.invalid.has(key) ? { error: S.invalidAmount } : {};
  const sizeError = (key: keyof Draft): { error?: string } =>
    checked.invalid.has(key) ? { error: S.invalidSize } : {};
  const turningSellOn = draft.sellOn && !viewSellOn(view);
  const dirty = checked.changes > 0 || checked.invalid.size > 0;

  return (
    <>
      {header}
      {noticeBanner}
      <Surface
        level="recessed"
        as="section"
        className="rl-summary"
        aria-labelledby="rules-summary-title"
      >
        <h2 id="rules-summary-title" className="al-text-title-3">
          {S.summaryTitle}
        </h2>
        <p className="al-text-body-sm al-muted">{S.summaryNote}</p>
        <dl className="rl-summary-list al-text-body-sm">
          <div>
            <dt>{S.proofTitle}</dt>
            <dd>{ruleWord(view.proofs.notarize)}</dd>
          </div>
          <div>
            <dt>{S.invitesTitle}</dt>
            <dd>{view.contacts.acceptInvites === 'auto' ? S.allowed : S.askMe}</dd>
          </div>
          <div>
            <dt>{S.termsTitle}</dt>
            <dd>{ruleWord(c.accept)}</dd>
          </div>
        </dl>
      </Surface>
      <section className="rl-group" aria-labelledby="rules-everyday">
        <h2 id="rules-everyday" className="al-text-title-3">
          {S.everyday}
        </h2>
        <Surface className="rl-card">
          <Row
            title={S.proofTitle}
            help={S.proofHelp}
            control={
              <Segmented
                label={S.proofTitle}
                value={draft.notarize}
                onChange={(v) => edit({ notarize: v as Draft['notarize'] })}
                options={[
                  { value: 'allow', label: S.allowed },
                  { value: 'approval', label: S.askMe },
                  { value: 'deny', label: S.never },
                ]}
              />
            }
          >
            {draft.notarize === 'deny' ? (
              <p className="al-text-body-sm al-muted">{S.proofOff}</p>
            ) : (
              <div className="rl-fields">
                <TextField
                  label={S.budget}
                  prefix="$"
                  mono
                  inputMode="decimal"
                  value={draft.dailyBudgetUSD}
                  {...amountError('dailyBudgetUSD')}
                  onChange={(e) => edit({ dailyBudgetUSD: e.currentTarget.value })}
                />
                <TextField
                  label={S.askOver}
                  prefix="$"
                  mono
                  inputMode="decimal"
                  value={draft.perActionMaxUSD}
                  {...amountError('perActionMaxUSD')}
                  onChange={(e) => edit({ perActionMaxUSD: e.currentTarget.value })}
                />
              </div>
            )}
          </Row>
          <Row
            title={S.invitesTitle}
            help={S.invitesHelp}
            control={
              <Segmented
                label={S.invitesTitle}
                value={draft.acceptInvites}
                onChange={(v) => edit({ acceptInvites: v as Draft['acceptInvites'] })}
                options={[
                  { value: 'approval', label: S.askMe, hint: S.recommended },
                  { value: 'auto', label: S.allow },
                ]}
              />
            }
          />
          <Row
            title={S.termsTitle}
            help={S.termsHelp}
            tone="commit"
            control={
              <Segmented
                label={S.termsTitle}
                value={draft.accept}
                onChange={(v) => edit({ accept: v as Draft['accept'] })}
                options={[
                  { value: 'approval', label: S.askEveryTime, hint: S.recommended },
                  { value: 'allow', label: S.allow },
                  { value: 'deny', label: S.never },
                ]}
              />
            }
          />
        </Surface>
      </section>

      <section className="rl-group" aria-labelledby="rules-more-title">
        <h2 id="rules-more-title" className="al-text-title-3">
          <button
            type="button"
            className="rl-toggle"
            aria-expanded={moreOpen ? 'true' : 'false'}
            aria-controls="rules-more"
            onClick={() => setMoreOpen((o) => !o)}
          >
            <Icon name={moreOpen ? 'chevron-down' : 'chevron-right'} size={16} />
            <span>{S.moreRules}</span>
          </button>
        </h2>
        {moreOpen ? (
          <Surface id="rules-more" className="rl-card">
            <Row
              title={S.unknownTitle}
              help={S.unknownHelp}
              control={
                <Segmented
                  label={S.unknownTitle}
                  value={draft.unknownSenders}
                  onChange={(v) => edit({ unknownSenders: v as Draft['unknownSenders'] })}
                  options={[
                    { value: 'queue', label: S.hold, hint: S.recommended },
                    { value: 'drop', label: S.drop },
                  ]}
                />
              }
            />
            <Row
              title={S.whoTitle}
              help={
                view.contacts.allowed === 'paired' ? S.whoPaired : S.whoListed(view.contacts.listed)
              }
            />
            <Row
              title={S.filesTitle}
              help={S.filesSummary(view.files.maxSendSizeMB, view.files.maxReceiveSizeMB)}
            >
              <div className="rl-fields">
                <TextField
                  label={S.sendLabel}
                  mono
                  inputMode="numeric"
                  value={draft.maxSendSizeMB}
                  {...sizeError('maxSendSizeMB')}
                  onChange={(e) => edit({ maxSendSizeMB: e.currentTarget.value })}
                />
                <TextField
                  label={S.receiveLabel}
                  mono
                  inputMode="numeric"
                  value={draft.maxReceiveSizeMB}
                  {...sizeError('maxReceiveSizeMB')}
                  onChange={(e) => edit({ maxReceiveSizeMB: e.currentTarget.value })}
                />
              </div>
            </Row>
            <Row
              title={S.exportsTitle}
              help={S.exportsHelp}
              control={
                <Segmented
                  label={S.exportsTitle}
                  value={draft.allowKeyDisclosure}
                  onChange={(v) => edit({ allowKeyDisclosure: v as Draft['allowKeyDisclosure'] })}
                  options={[
                    { value: 'approval', label: S.askMe },
                    { value: 'deny', label: S.never },
                  ]}
                />
              }
            />
            <Row title={S.limitsTitle} help={S.limitsHelp}>
              <div className="rl-limits">
                <Switch
                  label={S.buyTitle}
                  description={
                    listedNone
                      ? S.noListed
                      : S.buyHelp(dollars(draft.buyMaxUSD) ?? S.someAmount, c.autoAcceptContacts)
                  }
                  checked={draft.buyOn}
                  {...(draft.buyOn !== viewBuyOn(view) ? { note: S.unsaved } : {})}
                  disabled={listedNone && !draft.buyOn}
                  onChange={(on) => edit(on ? { buyOn: true, sellOn: false } : { buyOn: false })}
                />
                {draft.buyOn ? (
                  <TextField
                    label={S.buyMax}
                    prefix="$"
                    mono
                    inputMode="decimal"
                    value={draft.buyMaxUSD}
                    {...amountError('buyMaxUSD')}
                    onChange={(e) => edit({ buyMaxUSD: e.currentTarget.value })}
                  />
                ) : null}
                <Switch
                  label={S.sellTitle}
                  description={
                    listedNone
                      ? S.noListed
                      : draft.sellOn
                        ? S.sellHelpOn(dollars(draft.sellMinUSD) ?? S.someAmount)
                        : S.sellHelpOff
                  }
                  checked={draft.sellOn}
                  {...(draft.sellOn !== viewSellOn(view) ? { note: S.unsaved } : {})}
                  disabled={listedNone && !draft.sellOn}
                  onChange={(on) => edit(on ? { sellOn: true, buyOn: false } : { sellOn: false })}
                />
                {draft.sellOn ? (
                  <TextField
                    label={S.sellMin}
                    prefix="$"
                    mono
                    inputMode="decimal"
                    value={draft.sellMinUSD}
                    {...amountError('sellMinUSD')}
                    onChange={(e) => edit({ sellMinUSD: e.currentTarget.value })}
                  />
                ) : null}
                {/* UX audit 6b: the 06 §3 sell warning only while turning selling on. */}
                {turningSellOn ? (
                  <Banner tone="warning" title={S.sellWarningTitle}>
                    {S.sellWarning(dollars(draft.sellMinUSD) ?? S.someAmount)}
                  </Banner>
                ) : null}
              </div>
            </Row>
          </Surface>
        ) : null}
      </section>

      {dirty ? (
        <div className="rl-unsaved" role="region" aria-label={S.changes(checked.changes)}>
          <span className="al-text-body-sm">{S.changes(checked.changes)}</span>
          <div className="rl-unsaved-actions">
            <Button
              variant="ghost"
              onClick={() => {
                setNotice(undefined);
                setDraft(draftOf(view));
              }}
            >
              {S.discard}
            </Button>
            <Button
              variant="primary"
              icon="approval"
              disabled={
                checked.invalid.size > 0 || checked.changes === 0 || step.kind === 'preparing'
              }
              onClick={() => void prepare()}
            >
              {S.reviewSave}
            </Button>
          </div>
        </div>
      ) : null}
      {step.kind === 'preparing' ? (
        <p className="al-text-body-sm al-muted" role="status">
          {S.preparing}
        </p>
      ) : null}
      <UnderTheHood
        fields={[{ kind: 'count', label: S.hoodVersion, value: String(load.version) }]}
      />
    </>
  );
}

function ConfirmStep({
  confirm,
  code,
  sellAmount,
  onCode,
  onAck,
  onKeep,
  onSave,
  onBack,
}: {
  confirm: Confirm;
  code: string;
  sellAmount: string | undefined;
  onCode: (code: string) => void;
  onAck: (code: string, on: boolean) => void;
  onKeep: (keep: boolean) => void;
  onSave: () => void;
  onBack: () => void;
}): ReactElement {
  const codes = unique(confirm.review.warnings.map((w) => w.code));
  const allAcked = codes.every((c) => confirm.acks.has(c));
  const ready =
    allAcked && !confirm.busy && (confirm.spending || confirm.passkey !== null || code.length > 0);
  return (
    <section className="rl-group rl-confirm" aria-labelledby="rules-confirm">
      <h2 id="rules-confirm" className="al-text-title-3">
        {S.confirmTitle}
      </h2>
      <Surface className="rl-card rl-confirm-body">
        {codes.length === 0 ? (
          <p className="al-text-body">{S.noWarnings}</p>
        ) : (
          <>
            <p className="al-text-body">{S.confirmIntro}</p>
            <ul className="rl-warnings">
              {codes.map((c) => (
                <li key={c}>
                  <label className="al-check rl-warning">
                    <input
                      type="checkbox"
                      checked={confirm.acks.has(c)}
                      onChange={(e) => onAck(c, e.currentTarget.checked)}
                    />
                    <span className="al-text-body">
                      {warningText(c, sellAmount === undefined ? {} : { amount: sellAmount })}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        {confirm.review.askKeepDeliveryReceipts ? (
          <Switch
            label={S.keepTitle}
            description={S.keepText}
            checked={confirm.keep}
            disabled={confirm.busy}
            onChange={onKeep}
          />
        ) : null}
        {confirm.passkey === null && !confirm.spending ? (
          <TextField
            label={S.codeLabel}
            hint={`${S.codeHint} ${EARLIER_OWNER_CODE_HINT}`}
            type="password"
            autoComplete="off"
            mono
            value={code}
            onChange={(e) => onCode(e.currentTarget.value)}
          />
        ) : null}
        {confirm.error === undefined ? null : (
          <p className="al-text-body-sm rl-error" role="alert">
            {confirm.error}
          </p>
        )}
        <div className="rl-confirm-actions">
          <Button variant="ghost" onClick={onBack} disabled={confirm.busy}>
            {S.back}
          </Button>
          <Button
            variant="primary"
            {...(confirm.passkey === null || confirm.spending ? {} : { icon: 'approval' })}
            disabled={!ready}
            onClick={onSave}
          >
            {confirm.spending
              ? S.continueToConfirm
              : confirm.passkey === null
                ? S.saveCode
                : S.save}
          </Button>
        </div>
        {confirm.busy ? (
          <p className="al-text-body-sm al-muted" role="status">
            {S.saving}
          </p>
        ) : null}
      </Surface>
    </section>
  );
}

// Add credits by QR (Gnosis test network now) and Withdraw credits (M1-11c-a4c; D-122, D-123;
// topup-ux.md 3c; 11 §5.6; 12 §4.4; 04 §2.5).
//
// - The default view stays plain (UX north star): "Add credits" and "Withdraw credits" buttons only.
//   The agent's address, the QR code, the coin and the network appear only inside Add credits, which
//   the owner opens, because the sender's app asks for them (topup-ux.md 3c; D-117 B).
// - The QR code ships only with crediting: Add credits exists only where the server offers the
//   agent's address and a way to turn received funds into credits (the Gnosis test network).
// - Turning funds into credits and withdrawing are owner operations: a confirm screen with the amount
//   and where it goes from and to, then the owner code, sent once as the request body to the
//   server's presence gate. The owner code is never kept after the request or put in a URL.
// - Withdrawals go to the agent's own account only (the recipient grant is a later card).
import { EARLIER_OWNER_CODE_HINT } from '../../strings.js';
import { Button, TextField } from '@4thtech-io/ui';
import { useState, type FormEvent, type ReactElement } from 'react';
import type { ApiClient, OwnerApiResult } from '../../api/client.js';
import { TOP_UP_PATH, WITHDRAW_PATH, isPositive, type Money, type TopUpNetwork } from './data.js';
import { QrCode } from './qr.js';
import {
  NETWORK_NAMES,
  PROOFS_STRINGS as S,
  addAmount,
  comingSoon,
  readyToAdd,
  withdrawAmount,
} from './strings.js';

export type AddressNetwork = Extract<TopUpNetwork, { method: 'address' }>;
type Ready = Extract<TopUpNetwork, { available: true }>;

export interface Move {
  readonly kind: 'deposit' | 'withdraw';
  readonly money: Money;
  readonly net: Ready;
}

/** The owner's next step after a move, as one fixed line. */
function outcomeLine(res: OwnerApiResult): { text: string; done: boolean } {
  switch (res.kind) {
    case 'ok':
      return res.status === 202 ? { text: S.pending, done: true } : { text: S.done, done: true };
    case 'presence_rejected':
    case 'presence_required':
      return { text: S.wrongCode, done: false };
    case 'wait':
      return { text: S.wait, done: false };
    case 'answer': {
      const error =
        typeof res.data === 'object' && res.data !== null
          ? (res.data as { error?: unknown }).error
          : undefined;
      if (error === 'amount_changed') return { text: S.amountChanged, done: true };
      if (error === 'no_funds_for_fee') return { text: S.noFundsForFee, done: true };
      return { text: S.moveFailed, done: true };
    }
    default:
      return { text: S.moveFailed, done: false };
  }
}

export function AddCreditsPanel({
  net,
  soon,
  onTurn,
  onCheckAgain,
}: {
  readonly net: AddressNetwork;
  readonly soon: readonly string[];
  readonly onTurn: (move: Move) => void;
  readonly onCheckAgain: () => void;
}): ReactElement {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const name = NETWORK_NAMES[net.network];
  const copyAddress = (): void => {
    const clip = (globalThis.navigator as Navigator | undefined)?.clipboard;
    if (clip === undefined) {
      setCopy('failed');
      return;
    }
    void clip.writeText(net.address).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    );
  };
  return (
    <section className="al-credits pf-topup" aria-label={S.addCreditsTitle}>
      <h2 className="al-text-title-3">{S.addCreditsTitle}</h2>
      <p className="al-text-body-sm">{S.addCreditsIntro}</p>
      <dl className="pf-facts al-text-body-sm">
        <dt className="al-muted">{S.networkLabel}</dt>
        <dd className="al-text-body">{name}</dd>
        <dt className="al-muted">{S.coinLabel}</dt>
        <dd>{S.coin}</dd>
      </dl>
      <QrCode value={net.address} label={S.qrLabel} exposeValue />
      <div className="al-text-caption al-muted">{S.addressLabel}</div>
      <code className="pf-address al-text-code">{net.address}</code>
      <Button size="sm" onClick={copyAddress}>
        {S.copyAddress}
      </Button>
      {copy === 'idle' ? null : (
        <p className="al-text-caption" role="status">
          {copy === 'copied' ? S.copied : S.copyFailed}
        </p>
      )}
      <p className="al-text-caption al-muted">{S.privacy}</p>
      {net.available ? (
        isPositive(net.addable.amount) ? (
          <>
            <p className="al-text-body-sm">{readyToAdd(net.addable.usd)}</p>
            <Button
              variant="primary"
              onClick={() => onTurn({ kind: 'deposit', money: net.addable, net })}
            >
              {S.turnIntoCredits}
            </Button>
          </>
        ) : (
          <>
            <p className="al-text-body-sm al-muted">{S.nothingYet}</p>
            <Button size="sm" onClick={onCheckAgain}>
              {S.checkAgain}
            </Button>
          </>
        )
      ) : (
        <>
          <p className="al-text-body-sm al-muted">{S.notReadable}</p>
          <Button size="sm" onClick={onCheckAgain}>
            {S.checkAgain}
          </Button>
        </>
      )}
      {soon.map((n) => (
        <p key={n} className="al-text-caption al-muted">
          {comingSoon(n)}
        </p>
      ))}
    </section>
  );
}

export function ConfirmMove({
  api,
  move,
  onClose,
  onDone,
}: {
  readonly api: ApiClient;
  readonly move: Move;
  readonly onClose: () => void;
  readonly onDone: (line: string) => void;
}): ReactElement {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | undefined>(undefined);
  const name = NETWORK_NAMES[move.net.network];
  const deposit = move.kind === 'deposit';

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (busy || code.length === 0) return;
    setBusy(true);
    setLine(undefined);
    const input = { network: move.net.network, amount: move.money.amount };
    const sent = code;
    // The owner code lives only in this request; the field is cleared whatever happens.
    setCode('');
    void api.owner(deposit ? TOP_UP_PATH : WITHDRAW_PATH, input, sent).then((res) => {
      setBusy(false);
      const out = outcomeLine(res);
      if (out.done) onDone(out.text);
      else setLine(out.text);
    });
  };

  return (
    <section className="al-credits pf-confirm" aria-label={S.confirmTitle}>
      <h2 className="al-text-title-3">
        {deposit ? addAmount(move.money.usd) : withdrawAmount(move.money.usd)}
      </h2>
      <dl className="pf-facts al-text-body-sm">
        <dt className="al-muted">{S.amountLabel}</dt>
        <dd className="al-text-body">{move.money.usd}</dd>
        <dt className="al-muted">{S.fromLabel}</dt>
        <dd>{deposit ? S.fromReceived : S.fromCredits}</dd>
        <dt className="al-muted">{S.toLabel}</dt>
        <dd>
          {deposit ? (
            S.toCredits
          ) : (
            <>
              {S.toOwnAccount}
              <code className="pf-address al-text-code">{move.net.address}</code>
            </>
          )}
        </dd>
        <dt className="al-muted">{S.networkLabel}</dt>
        <dd>{name}</dd>
      </dl>
      <p className="al-text-caption al-muted">{deposit ? S.reserveNote : S.withdrawNote}</p>
      <form className="pf-confirm-form" onSubmit={submit}>
        <TextField
          label={S.ownerCode}
          hint={EARLIER_OWNER_CODE_HINT}
          type="password"
          autoComplete="off"
          mono
          value={code}
          onChange={(e) => setCode(e.currentTarget.value)}
        />
        {line === undefined ? null : (
          <p className="al-text-body-sm" role="alert">
            {line}
          </p>
        )}
        <div className="pf-confirm-actions">
          <Button type="submit" variant="primary" disabled={busy || code.length === 0}>
            {busy ? S.working : S.confirm}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {S.cancel}
          </Button>
        </div>
      </form>
    </section>
  );
}

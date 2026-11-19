// NET-DIAGRAM: the owner's three-column picture on Advanced › Message network (wireframe frame B,
// option 1): this ID → servers → contacts. It shows how a message travels; the server cards below
// stay the primary, accessible content, so the picture itself is one described image.
//
// - Wide: one SVG (viewBox scales; geometry is attributes, never inline style: CSP style-src 'self').
//   Narrow (600 px and under, or a narrow card): the same facts as a stacked list, no sideways scroll.
// - Contacts' names and hosts are inbound content (I-5): only ever React text children (escaped),
//   never HTML, never a link; the host is the already-checked plain DNS text from data.ts.
// - Health is a dot that differs by shape as well as colour (DOT_SHAPE, the same system as the cards).
// - Nothing animates (no travelling pulse), so reduced motion needs no special case.
import { useId, type ReactElement } from 'react';
import { formatMs, type NetworkAnswer, type NetworkServer, type ServerHealth } from './data.js';
import { NETWORK_STRINGS as S } from './strings.js';
import './diagram.css';

/** Colour is never the only signal: each state has its own dot shape (see network.css). */
export const DOT_SHAPE: Readonly<Record<ServerHealth, string>> = {
  ready: 'is-connected',
  slow: 'is-half',
  unreachable: 'is-not-running',
  blocked: 'is-square',
  unknown: 'is-checking',
};

/** The most contacts drawn; the rest become "+ N more contacts". */
export const MAX_DIAGRAM_CONTACTS = 5;
const MAX_HOST_CHARS = 17;
const MAX_NAME_CHARS = 13;

const ROW = 62;
const NODE_H = 48;
const CONTACT_H = 44;
const CONTACT_PITCH = 56;
const TOP = 30;
const ID_X = 20;
const ID_W = 150;
const SRV_X = 290;
const SRV_W = 160;
const CON_X = 560;
const CON_W = 150;

export interface DiagramContact {
  readonly ref: string;
  readonly name: string;
  /** Indexes into the servers column that this contact shares with us. */
  readonly via: readonly number[];
}

export interface DiagramModel {
  readonly servers: readonly NetworkServer[];
  readonly contacts: readonly DiagramContact[];
  /** Contacts that share a server with us but are not drawn. */
  readonly more: number;
  /** Everyone who shares a server (for "Reaches N contacts"). */
  readonly reach: number;
}

/** The pure model: who is drawn and which servers each one shares. No names → "A contact". */
export function buildDiagram(
  answer: NetworkAnswer,
  names: ReadonlyMap<string, string> | undefined,
): DiagramModel {
  const servers = answer.servers;
  const rows = answer.contactHosts;
  if (rows === undefined) return { servers, contacts: [], more: 0, reach: 0 };
  const sharing = rows
    .map((c) => ({
      ref: c.ref,
      name: names?.get(c.ref) ?? S.someoneUnknown,
      via: servers.flatMap((s, i) => (c.hosts.includes(s.host) ? [i] : [])),
    }))
    .filter((c) => c.via.length > 0)
    .sort((a, b) => b.via.length - a.via.length || a.name.localeCompare(b.name));
  const contacts = sharing.slice(0, MAX_DIAGRAM_CONTACTS);
  const reach = Math.max(answer.contacts.sharing, sharing.length);
  return { servers, contacts, more: Math.max(0, reach - contacts.length), reach };
}

/** Plain text cut to a length with an ellipsis (the full text stays in the title). */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

const initial = (name: string): string => (Array.from(name.trim())[0] ?? '?').toUpperCase();
const latency = (s: NetworkServer): string | undefined => {
  const ms = s.roundTripMs ?? s.connectMs;
  return ms === null ? undefined : formatMs(ms);
};
const roleWord = (s: NetworkServer): string =>
  s.kind === 'legacy' || !s.sends ? S.diagramReadOnly : S.diagramSendsReads;
const lineClass = (s: NetworkServer): string =>
  s.kind === 'legacy'
    ? 'is-old'
    : s.state === 'ready'
      ? 'is-ok'
      : s.state === 'slow'
        ? 'is-slow'
        : s.state === 'unknown'
          ? 'is-unknown'
          : 'is-down';
/** The second line of a server node: role, then the time when working or the state word when not. */
function subLine(s: NetworkServer): string {
  const role = roleWord(s);
  const ms = latency(s);
  if (s.state === 'ready') return ms === undefined ? role : `${role} · ${ms}`;
  const word = S.health[s.state].toLowerCase();
  // Not working: the state word replaces the role so the line always fits the node.
  if (s.state === 'slow' && ms !== undefined) return `${word} · ${ms}`;
  return word;
}

/** The text alternative: every server with its role and state, then who shares them. */
export function describeDiagram(model: DiagramModel): string {
  const facts = model.servers.map((s) =>
    S.diagramServerFact(s.host, roleWord(s), S.health[s.state].toLowerCase(), latency(s)),
  );
  const people =
    model.contacts.length === 0
      ? ''
      : ` ${S.diagramContactsFact(
          model.contacts.map((c) => c.name),
          model.more,
        )}`;
  return `${S.diagramSummary(model.servers.length)} ${facts.join('. ')}.${people}`;
}

function SvgDot({
  state,
  cx,
  cy,
}: {
  readonly state: ServerHealth;
  readonly cx: number;
  readonly cy: number;
}): ReactElement {
  const at = (dx: number, dy: number): string => `${String(cx + dx)} ${String(cy + dy)}`;
  switch (state) {
    case 'ready':
      return <circle className="nwd-dot-fill" cx={cx} cy={cy} r={5} />;
    case 'slow':
      return (
        <g>
          <circle
            className="nwd-dot-ring is-warn"
            fill="none"
            strokeWidth={2}
            cx={cx}
            cy={cy}
            r={4.5}
          />
          <path
            className="nwd-dot-fill is-warn"
            d={`M${at(0, -4.5)} A4.5 4.5 0 0 0 ${at(0, 4.5)} Z`}
          />
        </g>
      );
    case 'unreachable':
      return (
        <g>
          <circle
            className="nwd-dot-ring is-warn"
            fill="none"
            strokeWidth={2}
            cx={cx}
            cy={cy}
            r={4.5}
          />
          <path
            className="nwd-dot-slash"
            strokeWidth={2}
            d={`M${at(-3.5, -3.5)} L${at(3.5, 3.5)}`}
          />
        </g>
      );
    case 'blocked':
      return (
        <rect
          className="nwd-dot-fill is-warn"
          x={cx - 4.5}
          y={cy - 4.5}
          width={9}
          height={9}
          rx={1.5}
        />
      );
    case 'unknown':
      return (
        <circle className="nwd-dot-ring" fill="none" strokeWidth={2} cx={cx} cy={cy} r={4.5} />
      );
  }
}

const curve = (x1: number, y1: number, x2: number, y2: number): string => {
  const mid = x1 + (x2 - x1) / 2;
  return `M${String(x1)} ${String(y1)} C ${String(mid)} ${String(y1)}, ${String(mid)} ${String(y2)}, ${String(x2)} ${String(y2)}`;
};

function Wide({
  model,
  label,
}: {
  readonly model: DiagramModel;
  readonly label: string;
}): ReactElement {
  const { servers, contacts, more } = model;
  const hasContacts = contacts.length > 0;
  const srvH = servers.length * ROW - (ROW - NODE_H);
  const conH = contacts.length * CONTACT_PITCH + (more > 0 ? 24 : 0);
  const body = Math.max(srvH, conH, 76);
  const height = TOP + body + 4;
  const width = hasContacts ? 720 : 470;
  const srvTop = TOP + (body - srvH) / 2;
  const srvY = (i: number): number => srvTop + i * ROW + NODE_H / 2;
  const conTop = TOP + (body - conH) / 2;
  const conY = (i: number): number => conTop + i * CONTACT_PITCH + CONTACT_H / 2;
  const idY = TOP + body / 2;
  const agent = S.diagramAgent(label);
  return (
    <svg
      className="nwd-wide"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      width={width}
      height={height}
      fontSize={11}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <text className="nwd-h" fontSize={10} x={ID_X} y={10}>
        {S.diagramHeadThisId}
      </text>
      <text className="nwd-h" fontSize={10} x={SRV_X} y={10}>
        {S.diagramHeadServers}
      </text>
      {hasContacts ? (
        <text className="nwd-h" fontSize={10} x={CON_X} y={10}>
          {S.diagramHeadContacts}
        </text>
      ) : null}
      {servers.map((s, i) => (
        <path
          key={`l-${s.host}`}
          className={`nwd-ln ${lineClass(s)}`}
          fill="none"
          strokeWidth={2}
          d={curve(ID_X + ID_W, idY, SRV_X, srvY(i))}
        />
      ))}
      {contacts.map((c, ci) =>
        c.via.map((si) => (
          <path
            key={`c-${c.ref}-${String(si)}`}
            className="nwd-ln is-contact"
            fill="none"
            d={curve(SRV_X + SRV_W, srvY(si), CON_X, conY(ci))}
          />
        )),
      )}
      <rect className="nwd-node is-id" x={ID_X} y={idY - 38} width={ID_W} height={76} rx={10} />
      <circle className="nwd-av is-id" cx={ID_X + 26} cy={idY - 2} r={13} />
      <text className="nwd-av-t is-id" fontSize={12} x={ID_X + 26} y={idY + 2} textAnchor="middle">
        {initial(label)}
      </text>
      <text className="nwd-t" fontSize={13} x={ID_X + 48} y={idY - 6}>
        {clip(agent, 15)}
        <title>{agent}</title>
      </text>
      <text className="nwd-s" x={ID_X + 48} y={idY + 10}>
        {S.diagramThisComputer}
      </text>
      {servers.map((s, i) => {
        const top = srvY(i) - NODE_H / 2;
        return (
          <g key={s.host} data-node-state={s.state}>
            <rect
              className={`nwd-node${s.kind === 'legacy' ? ' is-old' : ''}`}
              x={SRV_X}
              y={top}
              width={SRV_W}
              height={NODE_H}
              rx={8}
            />
            <SvgDot state={s.state} cx={SRV_X + 16} cy={top + 16} />
            <text className="nwd-t is-code" fontSize={12} x={SRV_X + 28} y={top + 20}>
              {clip(s.host, MAX_HOST_CHARS)}
              <title>{s.host}</title>
            </text>
            <text className="nwd-s" x={SRV_X + 16} y={top + 38}>
              {subLine(s)}
            </text>
          </g>
        );
      })}
      {contacts.map((c, i) => {
        const cy = conY(i);
        return (
          <g key={c.ref}>
            <rect
              className="nwd-node"
              x={CON_X}
              y={cy - CONTACT_H / 2}
              width={CON_W}
              height={CONTACT_H}
              rx={8}
            />
            <circle className="nwd-av" cx={CON_X + 20} cy={cy} r={11} />
            <text className="nwd-av-t" fontSize={11} x={CON_X + 20} y={cy + 4} textAnchor="middle">
              {initial(c.name)}
            </text>
            <text className="nwd-t" fontSize={13} x={CON_X + 38} y={cy + 4}>
              {clip(c.name, MAX_NAME_CHARS)}
              <title>{c.name}</title>
            </text>
          </g>
        );
      })}
      {more > 0 ? (
        <text className="nwd-s" x={CON_X} y={conTop + contacts.length * CONTACT_PITCH + 6}>
          {S.diagramMore(more)}
        </text>
      ) : null}
    </svg>
  );
}

function Stack({
  model,
  label,
}: {
  readonly model: DiagramModel;
  readonly label: string;
}): ReactElement {
  const { servers, contacts, more, reach } = model;
  return (
    <div className="nwd-stack">
      <div className="nwd-nd is-id">
        <span className="al-avatar nwd-chip-av is-id">{initial(label)}</span>
        <span className="nwd-nd-name">{S.diagramAgent(label)}</span>
        <span className="nwd-nd-r al-text-body-sm">{S.diagramThisComputer}</span>
      </div>
      {servers.map((s) => (
        <div key={s.host} className="nwd-stack-item">
          <div className={`nwd-conn ${lineClass(s)}`} />
          <div
            className={`nwd-nd${s.kind === 'legacy' ? ' is-old' : ''}`}
            data-node-state={s.state}
          >
            <span className={`al-dot nw-dot ${DOT_SHAPE[s.state]}`} />
            <span className="nwd-nd-name al-text-code" title={s.host}>
              {s.host}
            </span>
            <span className="nwd-nd-r al-text-body-sm">
              {s.state === 'ready' ? (latency(s) ?? S.health.ready) : S.health[s.state]}
            </span>
          </div>
        </div>
      ))}
      {contacts.length === 0 ? null : (
        <>
          <div className="nwd-cap al-text-label al-muted">{S.reaches(reach)}</div>
          <div className="nwd-nd nwd-people">
            {contacts.map((c) => (
              <span key={c.ref} className="nwd-person" title={c.name}>
                <span className="al-avatar nwd-chip-av">{initial(c.name)}</span>
                <span className="nwd-nd-name">{c.name}</span>
              </span>
            ))}
            {more > 0 ? (
              <span className="nwd-nd-r al-text-body-sm">{S.diagramMoreShort(more)}</span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function Legend({ showContact }: { readonly showContact: boolean }): ReactElement {
  return (
    <ul className="nwd-legend al-text-body-sm al-muted">
      <li>
        <i className="nwd-key" />
        {S.legendSends}
      </li>
      <li>
        <i className="nwd-key is-old" />
        {S.legendOld}
      </li>
      {showContact ? (
        <li>
          <i className="nwd-key is-contact" />
          {S.legendContact}
        </li>
      ) : null}
      <li>
        <span className={`al-dot nw-dot ${DOT_SHAPE.ready}`} />
        {S.legendWorking}
      </li>
      <li>
        <span className={`al-dot nw-dot ${DOT_SHAPE.slow}`} />
        {S.legendSlow}
      </li>
      <li>
        <span className={`al-dot nw-dot ${DOT_SHAPE.unreachable}`} />
        {S.legendDown}
      </li>
    </ul>
  );
}

export interface NetworkDiagramProps {
  readonly answer: NetworkAnswer;
  readonly names: ReadonlyMap<string, string> | undefined;
  /** This ID's label ("Tali"); undefined → "Your agent". */
  readonly agentLabel: string | undefined;
}

/** The whole card. Renders nothing when there is no server to draw. */
export function NetworkDiagram({
  answer,
  names,
  agentLabel,
}: NetworkDiagramProps): ReactElement | null {
  const describedBy = useId();
  if (answer.servers.length === 0) return null;
  const model = buildDiagram(answer, names);
  const label = agentLabel ?? '';
  return (
    <div className="nw-card nwd" data-diagram="three-column">
      <div
        className="nwd-pic"
        role="img"
        aria-label={S.diagramSummary(model.servers.length)}
        aria-describedby={describedBy}
      >
        <Wide model={model} label={label} />
        <Stack model={model} label={label} />
      </div>
      <p id={describedBy} hidden>
        {describeDiagram(model)}
      </p>
      <Legend showContact={model.contacts.length > 0} />
    </div>
  );
}

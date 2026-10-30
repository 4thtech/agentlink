// W4-SHELL (owner Decision 44 B1; b11 §34.2, §34.7): an agent's letter icon, until an icon set
// exists. The agent's initial in a coloured circle; the colour is one of a fixed palette of design
// token pairs, picked by the agent's stable key (its folder name), so a rename keeps it. The icon is
// decoration (aria-hidden): the agent's label is always next to it as text. The label is the owner's
// own plain text, rendered as text only (I-5).
import type { ReactElement } from 'react';
import { cx } from './util.js';

/** The palette, in order. Each tone maps to a token pair in components.css (never a raw colour). */
export const AGENT_ICON_TONES = ['accent', 'info', 'proof', 'teal', 'amber', 'neutral'] as const;
export type AgentIconTone = (typeof AGENT_ICON_TONES)[number];

/** The first whole character of the label (a grapheme where the platform can split them), upper case. */
export function agentInitial(label: string): string {
  const text = label.trim();
  if (text === '') return '?';
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter === undefined) return ([...text][0] ?? '?').toUpperCase();
  const segments = new Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
  for (const { segment } of segments) return segment.toUpperCase();
  return '?';
}

/** FNV-1a over the key's UTF-16 units: small, stable across runs and platforms. */
export function agentIconTone(key: string): AgentIconTone {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return AGENT_ICON_TONES[hash % AGENT_ICON_TONES.length] as AgentIconTone;
}

/**
 * W4-SHELL-V2: the live dot in the icon's corner (prototype v23): filled for Working and Ready, a
 * ring for Not running and Paused, a dashed ring for Not set up. Decoration only: the status is
 * always said in words next to the icon (never colour alone).
 */
export const AGENT_DOT_STATES = ['working', 'ready', 'idle', 'off', 'paused', 'none'] as const;
export type AgentDotState = (typeof AGENT_DOT_STATES)[number];

export interface AgentIconProps {
  /** The agent's label: its first letter is drawn. */
  label: string;
  /** The agent's stable key (its folder name): it picks the colour. Defaults to the label. */
  seed?: string;
  /** `md` 24 px (rows), `lg` 32 px (the agent chip and its menu). */
  size?: 'md' | 'lg';
  /** W4-SHELL-V2: the live dot in the corner; none when undefined. */
  dot?: AgentDotState;
  className?: string;
}

export function AgentIcon({
  label,
  seed,
  size = 'md',
  dot,
  className,
}: AgentIconProps): ReactElement {
  return (
    <span
      className={cx(
        'al-agent-icon',
        `is-${agentIconTone(seed ?? label)}`,
        size === 'lg' && 'is-lg',
        className,
      )}
      aria-hidden="true"
    >
      {agentInitial(label)}
      {dot === undefined ? null : <span className={cx('al-agent-icon-dot', `is-${dot}`)} />}
    </span>
  );
}

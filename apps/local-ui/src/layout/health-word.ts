// N2: the one vocabulary for the app's connection state. The status bar, the ID chip in the top
// bar, the status strip, Home's Network tile and the offline notice all read this one table, so a
// state has one set of words everywhere (b11 §5). Copy is unchanged from what each surface said
// before; only where it lives has changed.
import type { LiveDotState } from '@4thtech-io/ui';
import type { LiveState } from '../api/live.js';
import { SHELL_STRINGS as S } from '../strings.js';
import type { ConnectionState } from './connection.js';

export interface HealthWord {
  /** The status bar's dot class (`is-<cls>`). */
  readonly cls: string;
  /** The status bar's words. */
  readonly bar: string;
  /** The top bar's chip: the dot and, when it is not the dot's own word, the label. */
  readonly chip: { readonly state: LiveDotState; readonly label?: string };
  /** The status strip's line for AgentLink itself. */
  readonly strip: { readonly value: string; readonly state: LiveState };
  /** Home's Network tile. */
  readonly network: { readonly dot: LiveDotState; readonly word: string };
}

export const HEALTH_WORDS: Readonly<Record<ConnectionState, HealthWord>> = {
  unknown: {
    cls: 'checking',
    bar: 'Checking…',
    chip: { state: 'checking' },
    strip: { value: 'checking', state: 'off' },
    network: { dot: 'not-running', word: 'Not connected' },
  },
  checking: {
    cls: 'checking',
    bar: S.networkChecking,
    chip: { state: 'checking' },
    strip: { value: 'running, checking the connection', state: 'off' },
    network: { dot: 'reconnecting', word: 'Reconnecting…' },
  },
  connected: {
    cls: 'connected',
    bar: 'Connected',
    chip: { state: 'connected' },
    strip: { value: 'running', state: 'ready' },
    network: { dot: 'connected', word: 'Connected' },
  },
  // REL051-CF2 (R1-CLASS-02): the agent runs but none of its relays can be reached from here.
  unreachable: {
    cls: 'unreachable',
    bar: S.networkUnreachable,
    chip: { state: 'reconnecting', label: S.networkUnreachableChip },
    strip: { value: "running, can't reach the network", state: 'off' },
    network: { dot: 'reconnecting', word: 'Reconnecting…' },
  },
  // The browser lost its connection: the same shape as "not running", in the status bar's words.
  offline: {
    cls: 'disconnected',
    bar: 'Not connected',
    chip: { state: 'not-running', label: S.offlineChip },
    strip: { value: 'not connected', state: 'off' },
    network: { dot: 'not-running', word: 'Offline' },
  },
  paused: {
    cls: 'paused',
    bar: 'Paused',
    chip: { state: 'paused' },
    strip: { value: 'paused', state: 'paused' },
    network: { dot: 'connected', word: 'Connected' },
  },
  not_running: {
    cls: 'not-running',
    bar: 'Not running',
    chip: { state: 'not-running' },
    strip: { value: 'not running', state: 'off' },
    network: { dot: 'not-running', word: 'Not connected' },
  },
  needs_setup: {
    cls: 'needs-setup',
    bar: 'Needs setup',
    chip: { state: 'needs-setup' },
    strip: { value: 'needs setup', state: 'none' },
    network: { dot: 'not-running', word: 'Not connected' },
  },
};

/** The words for one connection state. */
export function healthWord(state: ConnectionState): HealthWord {
  return HEALTH_WORDS[state] ?? HEALTH_WORDS.unknown;
}

/** The states in which the message network cannot be reached from this computer. */
export function isNetworkDown(state: ConnectionState): boolean {
  return state === 'offline' || state === 'unreachable';
}

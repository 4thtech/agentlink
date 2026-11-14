// W4-WIZARD: what Get started remembers between its steps. Each step is its own route, so the page
// mounts again on every step; this module keeps the person's choices in memory for the life of the
// page (never in storage). It holds no secret: the master code stays in the connect step's own state
// and leaves the page before the next step opens.
import type { DetectedApp } from '../first-run/apps-api.js';
import type { SendFolderOutcome } from '../first-run/setup-api.js';

/** What the connect step did: the agent and the AI app it connected (or tried to, E1). */
export interface WizardOutcome {
  readonly label: string;
  readonly app?: { readonly id: string; readonly name: string; readonly connected: boolean };
  /** W4-WIRE-2: Add agent's new agent (its folder name), for "Open {name}" on Connected. */
  readonly agent?: string;
  /** FILES-ONB-1: what first run's one gesture did to the Send folder (`not_confirmed` is said). */
  readonly sendFolder?: SendFolderOutcome;
}

export interface WizardMemory {
  /** The AI apps the look found (undefined: not looked yet). */
  readonly apps?: readonly DetectedApp[] | 'unavailable' | undefined;
  /** The picked app's id. */
  readonly choice?: string;
  /** The agent's name, once the person edited it. */
  readonly name?: string;
  readonly outcome?: WizardOutcome;
  /** W4-WIRE-2: this run is Add agent (`?add=agent`); a new Add agent starts with nothing kept. */
  readonly adding?: boolean;
  /** W4-WIRE-2: Add agent's "Name your agent" step was passed with the name above. */
  readonly named?: boolean;
  /** FILES-ONB-1: this run is Connect another AI app (no Files step; four steps). */
  readonly connectOnly?: boolean;
  /**
   * FILES-ONB-1 (08 §1 "Connect step"): the Connect card's "Change" was pressed. Only a wish: the
   * Files step opens its folder choice; nothing changes before (or because of) the gesture.
   */
  readonly chooseFolder?: boolean;
}

let memory: WizardMemory = {};
/** "Skip to Home" was pressed, or Get started was shown once in this page's life. */
let autoShown = false;

export function wizardMemory(): WizardMemory {
  return memory;
}

export function rememberWizard(patch: Partial<WizardMemory>): void {
  memory = { ...memory, ...patch };
}

/**
 * W4-WIRE-2 (IR-W4-WIRE-2X-1): Add agent left before its end (Skip to Home, a link, Back): what it
 * kept goes, so the next Add agent starts at "Name your agent". The look for AI apps is kept.
 */
export function forgetAbandonedAdd(): void {
  if (memory.adding !== true) return;
  const apps = memory.apps;
  memory = apps === undefined ? {} : { apps };
}

/** REL051-R2C (R2-UI-01): Connected reads the real state (the outcome is not known here). */
export function forgetOutcome(): void {
  const next: { -readonly [K in keyof WizardMemory]: WizardMemory[K] } = { ...memory };
  delete next.outcome;
  memory = next;
}

/** Forgets the choices (a new run of Get started, and tests). */
export function resetWizard(): void {
  memory = {};
}

/** Whether Get started already opened by itself (or was skipped) in this page's life. */
export function wasAutoShown(): boolean {
  return autoShown;
}

/** Marks Get started as opened by itself or skipped; the app then stays where the person goes. */
export function markAutoShown(): void {
  autoShown = true;
}

/** Tests only: a fresh page. */
export function resetAutoShown(): void {
  autoShown = false;
}

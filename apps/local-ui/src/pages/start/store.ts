// W4-WIZARD: what Get started remembers between its steps. Each step is its own route, so the page
// mounts again on every step; this module keeps the person's choices in memory for the life of the
// page (never in storage). It holds no secret: the backup code stays in the connect step's own state
// and leaves the page before the next step opens.
import type { DetectedApp } from '../first-run/apps-api.js';

/** What the connect step did: the agent and the AI app it connected (or tried to, E1). */
export interface WizardOutcome {
  readonly label: string;
  readonly app?: { readonly id: string; readonly name: string; readonly connected: boolean };
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

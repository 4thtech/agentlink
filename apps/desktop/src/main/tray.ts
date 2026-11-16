// The tray / menu-bar icon. WP-D2 made the minimal one (Open, Try again, Quit; a tooltip with a fixed
// word for the core's state and numbers only, never a name or message text). TRAY-ENGINE (0.5.9,
// D-155) adds the brand-mark frames: with `options.frames` the icon follows tray-engine.ts (state,
// unread ring, approvals, pulses, the connecting loop), honours reduced motion, uses macOS template
// images and the Windows light or dark taskbar set (following nativeTheme). With `actions.click` the
// left click calls it (the popover) and the right click pops the menu Open AgentLink / Quit.
import type { HostState } from '../shared/protocol.js';
import type {
  Menu,
  MenuItemOptions,
  NativeImage,
  NativeImageModule,
  Tray,
} from './electron-api.js';
import {
  TrayEngine,
  type TrayFrameRef,
  type TrayIndicator,
  type TrayPulse,
  type TrayTimers,
} from './tray-engine.js';
import type { TaskbarTheme, TrayFrames, TrayImage } from './tray-frames.js';

/**
 * The built-in tray image (a ring with a dot; 36×36 px black on transparent, shown at 18 pt with
 * scale factor 2). Used when the packaged icon file is missing or unreadable, so the menu-bar /
 * tray item ALWAYS exists (the only way back to the window after it is closed).
 */
export const BUILTIN_TRAY_PNG: Uint8Array = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAA+UlEQVR42u1YwQ3DIAy8ERjBIzBKRmKDjMAoGYFRGIH2waOKMMFJUK9qLDmPBKPD3GET4LE/sQXACmADUHa+1W/LbBDu/QgAcgOE5rnGuBkZsQBpAbstY/ECkL3H2WBSHROqx/puCqh4wAvpxMoB3+IZzhRFQWKYRxQlFgunnLKyePPW51H1BSUzV62VqTASmBsrkRsAiTK3mTtHq/AfKvMnst/l0toIkA7XtNLhOlnaj18t+5yMnBjhXLLwc1RZfuBU9gbFDQMKBi5cif1dQF/fMjpS08me7mCkKx2UxZWu/aBr0ChbWMomn/IaRHlRpLxKU/5seIzCXiDEpiwp4JgJAAAAAElFTkSuQmCC',
    'base64',
  ),
);

/**
 * The tray image: the icon file when it loads, else the built-in one. On macOS it is a template
 * image (the menu bar tints it for light and dark).
 */
export function trayImage(
  nativeImage: NativeImageModule,
  iconPath: string,
  platform: string,
): NativeImage {
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createFromBuffer(BUILTIN_TRAY_PNG, { scaleFactor: 2 });
  if (platform === 'darwin') image.setTemplateImage(true);
  return image;
}

export const TRAY_COPY = {
  open: 'Open AgentLink',
  retry: 'Try again',
  quit: 'Quit AgentLink',
  base: 'AgentLink',
} as const;

const STATE_WORDS: Record<HostState | 'failed', string> = {
  starting: 'Starting',
  running: 'Running',
  closing: 'Closing',
  failed: 'Not running',
};

/** The tooltip: "AgentLink: <state>", plus "· <n> waiting" when approvals wait. Numbers only. */
export function trayTooltip(state: HostState | 'failed', approvals: number): string {
  const waiting = Number.isSafeInteger(approvals) && approvals > 0 ? ` · ${approvals} waiting` : '';
  return `${TRAY_COPY.base}: ${STATE_WORDS[state]}${waiting}`;
}

export interface TrayActions {
  readonly open: () => void;
  /** Starts the core again after it could not start; the menu has "Try again" only when given. */
  readonly retry?: () => void;
  readonly quit: () => void;
  /** The left click (TRAY-SHELL: the popover). Without it the left click opens the window. */
  readonly click?: () => void;
}

export interface TrayBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The Electron Tray subset; the methods TRAY-SHELL adds to electron-api.ts are optional here. */
export interface TrayHandle extends Tray {
  setImage?(image: TrayImage): void;
  popUpContextMenu?(menu?: Menu): void;
  getBounds?(): TrayBounds;
  on(event: 'click' | 'right-click', listener: () => void): void;
}

export interface TrayElectron {
  readonly Tray: new (icon: string | NativeImage) => TrayHandle;
  readonly Menu: { buildFromTemplate(template: MenuItemOptions[]): Menu };
}

/** What the tray reads from the OS: the taskbar colour and the animation settings. */
export interface TraySystem {
  readonly nativeTheme?: {
    readonly shouldUseDarkColorsForSystemIntegratedUI?: boolean;
    on?(event: 'updated', listener: () => void): unknown;
    removeListener?(event: 'updated', listener: () => void): unknown;
  };
  readonly systemPreferences?: {
    getAnimationSettings?(): {
      readonly shouldRenderRichAnimation?: boolean;
      readonly prefersReducedMotion?: boolean;
    };
  };
}

export interface AppTrayOptions {
  /** The frames (tray-frames.ts loadTrayFrames); null or absent keeps the single image. */
  readonly frames?: TrayFrames | null;
  readonly system?: TraySystem;
  readonly timers?: TrayTimers;
  /** process.platform (informational; the frames carry their own platform). */
  readonly platform?: string;
  /** The app's own motion setting (`motion: off` -> false). Default on. */
  readonly appMotion?: boolean;
  /** The starting indicator (default: connecting). */
  readonly initial?: Partial<TrayIndicator>;
}

/** Whether the OS asks for reduced motion (macOS and Windows; unknown = motion allowed). */
export function systemReducedMotion(system: TraySystem | undefined): boolean {
  try {
    const s = system?.systemPreferences?.getAnimationSettings?.();
    return s?.prefersReducedMotion === true || s?.shouldRenderRichAnimation === false;
  } catch {
    return false;
  }
}

/** The Windows taskbar colour (unknown = dark, the Windows 10 default). */
export function taskbarTheme(system: TraySystem | undefined): TaskbarTheme {
  return system?.nativeTheme?.shouldUseDarkColorsForSystemIntegratedUI === false ? 'light' : 'dark';
}

export class AppTray {
  readonly #tray: TrayHandle;
  readonly #system: TraySystem | undefined;
  readonly #frames: TrayFrames | null;
  readonly #engine: TrayEngine | null = null;
  readonly #onTheme: () => void;
  #appMotion: boolean;
  #theme: TaskbarTheme;
  #destroyed = false;

  constructor(
    electron: TrayElectron,
    icon: string | NativeImage,
    actions: TrayActions,
    options: AppTrayOptions = {},
  ) {
    this.#tray = new electron.Tray(icon);
    this.#system = options.system;
    this.#appMotion = options.appMotion !== false;
    this.#theme = taskbarTheme(this.#system);
    this.#tray.setToolTip(trayTooltip('starting', 0));
    const items: MenuItemOptions[] = [{ label: TRAY_COPY.open, click: actions.open }];
    if (actions.retry !== undefined) items.push({ label: TRAY_COPY.retry, click: actions.retry });
    items.push({ type: 'separator' }, { label: TRAY_COPY.quit, click: actions.quit });
    const menu = electron.Menu.buildFromTemplate(items);
    const click = actions.click;
    const tray = this.#tray;
    if (click !== undefined && tray.popUpContextMenu !== undefined) {
      // A context menu set on the tray takes the left click on macOS; pop it on right click instead.
      tray.on('click', click);
      tray.on('right-click', () => tray.popUpContextMenu?.(menu));
    } else {
      tray.setContextMenu(menu);
      tray.on('click', click ?? actions.open);
    }
    this.#onTheme = () => this.refreshSystem();
    const frames = options.frames ?? null;
    this.#frames = frames !== null && tray.setImage !== undefined ? frames : null;
    if (this.#frames !== null) {
      this.#engine = new TrayEngine({
        sequences: this.#frames.sequences,
        ...(options.timers === undefined ? {} : { timers: options.timers }),
        reducedMotion: this.#reduced(),
        ...(options.initial === undefined ? {} : { initial: options.initial }),
        render: (ref) => this.#show(ref),
      });
      this.#system?.nativeTheme?.on?.('updated', this.#onTheme);
    }
  }

  /** The tooltip (numbers only). */
  update(state: HostState | 'failed', approvals: number): void {
    if (this.#destroyed) return;
    this.#tray.setToolTip(trayTooltip(state, approvals));
  }

  /** The icon's state, unread ring and approvals variant (no-op without frames). */
  setIndicator(next: Partial<TrayIndicator>): void {
    if (this.#destroyed) return;
    this.#engine?.set(next);
  }

  /** A one-shot animation: msg-in, msg-out or approval (coalesced; none under reduced motion). */
  pulse(kind: TrayPulse): void {
    if (this.#destroyed) return;
    this.#engine?.pulse(kind);
  }

  /** The popover was opened: the hollow ring goes. */
  clearUnread(): void {
    if (this.#destroyed) return;
    this.#engine?.clearUnread();
  }

  /** The app's motion setting (false = `motion: off`, static icon only). */
  setAppMotion(enabled: boolean): void {
    if (this.#destroyed) return;
    this.#appMotion = enabled !== false;
    this.#engine?.setReducedMotion(this.#reduced());
  }

  /** Reads the taskbar colour and the animation settings again (also on nativeTheme `updated`). */
  refreshSystem(): void {
    if (this.#destroyed || this.#engine === null) return;
    this.#engine.setReducedMotion(this.#reduced());
    const theme = taskbarTheme(this.#system);
    if (theme === this.#theme) return;
    this.#theme = theme;
    const ref = this.#engine.frame;
    if (ref !== null && this.#frames?.isMac === false) this.#show(ref);
  }

  /** Where the icon is on screen (the popover anchors to it); null when unknown. */
  getBounds(): TrayBounds | null {
    return this.#tray.getBounds?.() ?? null;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#engine?.dispose();
    this.#system?.nativeTheme?.removeListener?.('updated', this.#onTheme);
    this.#tray.destroy();
  }

  #reduced(): boolean {
    return !this.#appMotion || systemReducedMotion(this.#system);
  }

  #show(ref: TrayFrameRef): void {
    if (this.#destroyed || this.#frames === null) return;
    this.#tray.setImage?.(this.#frames.image(ref.id, ref.settle, this.#theme));
  }
}

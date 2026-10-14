// M1-8c: the CLI prompt seam for owner steps (04 §2.5, §2.8; 07 §9.2, §9.3). The owner code or
// owner passphrase is read only from an interactive terminal, without echo, as bytes. No environment
// variable, file, argument or piped stdin can supply it: a non-TTY input or output is refused before
// anything is read, and `AGENTLINK_OWNER_*` variables are never read (D-54, 07 §9.2).
//
// "Interactive only" is a UX guard, not a security boundary (04 §2.8): a same-user process can fake a
// terminal. It keeps the owner secret out of the agent's normal flow; it does not stop a tampered
// installation or a fake prompt (04 §2.5, G-1, D-67).
import { wipe } from '@agentlink/crypto';
import { NodeKeyStoreError } from './errors.js';

/** What owner flows need from a terminal. Tests script it; production uses ttyOwnerTerminal. */
export interface OwnerTerminal {
  /** Writes fixed copy. The only secret ever written is a newly generated code, once (07 §9.3). */
  write(text: string): void;
  /** Reads one line without echo, as bytes. The caller wipes the result. */
  readSecret(label: string): Promise<Uint8Array>;
  /** Asks a visible yes/no question; anything but y or yes is no. */
  confirm(question: string): Promise<boolean>;
  /** Clears the screen and the scrollback after a generated code was shown (04 §2.8). */
  clearScreen(): void;
}

/** The parts of a TTY read stream the prompt uses (`process.stdin`). */
export interface TtyInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  off(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** The parts of a TTY write stream the prompt uses (`process.stdout`). */
export interface TtyOutput {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

/** Longest accepted line in bytes; longer input is refused, never truncated. */
const MAX_INPUT_BYTES = 1024;

const promptUnavailable = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'owner_prompt_unavailable',
    'Owner steps ask for your owner code in an interactive terminal. Run this command yourself, in a terminal window you opened; your AI cannot do it for you.',
  );

const promptCancelled = (): NodeKeyStoreError =>
  new NodeKeyStoreError('owner_prompt_cancelled', 'Cancelled. Nothing was changed.');

const tooLong = (): NodeKeyStoreError =>
  new NodeKeyStoreError('owner_secret_refused', 'That entry is too long. Nothing was changed.');

/**
 * Reads one line in raw mode. Enter ends it; Ctrl-C and Ctrl-D cancel; Backspace removes the last
 * character; other control bytes and escape sequences (arrow keys, bracketed paste markers) are
 * skipped. Every chunk the stream hands over is zeroed after its bytes are copied.
 */
function readLine(input: TtyInput, output: TtyOutput, echo: boolean): Promise<Uint8Array> {
  const buffer = new Uint8Array(MAX_INPUT_BYTES);
  let length = 0;
  let escape: 'none' | 'start' | 'csi' = 'none';
  return new Promise<Uint8Array>((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      input.off('data', onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write('\n');
      if (error !== undefined) {
        wipe(buffer);
        reject(error);
        return;
      }
      const line = buffer.slice(0, length);
      wipe(buffer);
      resolve(line);
    };
    const onData = (chunk: Uint8Array | string): void => {
      // The stream has no encoding set, so chunks are Buffers; a string is copied to bytes.
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      try {
        for (const byte of bytes) {
          if (escape === 'start') {
            escape = byte === 0x5b ? 'csi' : 'none';
            continue;
          }
          if (escape === 'csi') {
            if (byte >= 0x40 && byte <= 0x7e) escape = 'none';
            continue;
          }
          if (byte === 0x0d || byte === 0x0a) {
            finish();
            return;
          }
          if (byte === 0x03 || byte === 0x04) {
            finish(promptCancelled());
            return;
          }
          if (byte === 0x1b) {
            escape = 'start';
            continue;
          }
          if (byte === 0x7f || byte === 0x08) {
            // Remove one UTF-8 character: its continuation bytes, then its lead byte.
            while (length > 0 && ((buffer[length - 1] ?? 0) & 0xc0) === 0x80) length -= 1;
            if (length > 0) {
              length -= 1;
              if (echo) output.write('\b \b');
            }
            buffer.fill(0, length);
            continue;
          }
          if (byte < 0x20) continue;
          if (length >= MAX_INPUT_BYTES) {
            finish(tooLong());
            return;
          }
          buffer[length] = byte;
          length += 1;
          if (echo && byte < 0x80) output.write(String.fromCharCode(byte));
        }
      } finally {
        wipe(bytes);
      }
    };
    input.on('data', onData);
    input.setRawMode?.(true);
    input.resume();
  });
}

export interface TtyStreams {
  readonly input?: TtyInput;
  readonly output?: TtyOutput;
}

/**
 * The owner prompt on the process's own terminal. Refused (`owner_prompt_unavailable`) unless both
 * input and output are TTYs and the input supports raw mode, so a pipe, a redirected file or the MCP
 * stdio channel never supplies or receives an owner secret.
 */
export function ttyOwnerTerminal(streams: TtyStreams = {}): OwnerTerminal {
  const input: TtyInput = streams.input ?? process.stdin;
  const output: TtyOutput = streams.output ?? process.stdout;
  if (input.isTTY !== true || typeof input.setRawMode !== 'function' || output.isTTY !== true) {
    throw promptUnavailable();
  }
  // One read at a time: overlapping reads would split one line between two prompts.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };
  return Object.freeze({
    write(text: string): void {
      output.write(text.endsWith('\n') ? text : `${text}\n`);
    },
    readSecret(label: string): Promise<Uint8Array> {
      return serial(() => {
        output.write(`${label} `);
        return readLine(input, output, false);
      });
    },
    confirm(question: string): Promise<boolean> {
      return serial(async () => {
        output.write(`${question} `);
        const answer = await readLine(input, output, true);
        const text = new TextDecoder().decode(answer).trim().toLowerCase();
        wipe(answer);
        return text === 'y' || text === 'yes';
      });
    },
    clearScreen(): void {
      // Erase the screen and the scrollback, then home the cursor (04 §2.8 "shown once").
      output.write('\u001b[2J\u001b[3J\u001b[H');
    },
  });
}

/**
 * Environment markers of AI apps that run shell commands (04 §2.8). While one is set, the owner
 * step is refused. A UX guard against an AI running it by accident, not a security boundary; M1-8f
 * maintains the full list.
 */
export const HARNESS_MARKERS: readonly string[] = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'GEMINI_CLI',
]);

/** Throws `harness_detected` when any HARNESS_MARKERS variable is set (non-empty). */
export function assertNoHarnessMarker(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  for (const name of HARNESS_MARKERS) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      throw new NodeKeyStoreError(
        'harness_detected',
        'This looks like a terminal your AI app controls. Run `agentlink owner init` yourself, in a terminal window you opened, so your AI never sees your owner code.',
      );
    }
  }
}

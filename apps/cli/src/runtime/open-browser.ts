// Opens a link in the user's default browser (M1-26-e, `agentlink credits --topup`, 06 §8).
//
// The link is handed to the platform's opener as one argument with no shell (`execFile`), so nothing in it can
// be interpreted as a command. Only an `https://` link is ever opened. The opener's output is
// ignored and nothing about the link is logged or returned (the link carries the agent address and
// an amount, 08 §1). Resolves false when no opener exists or it fails; never throws.
import { execFile } from 'node:child_process';
import process from 'node:process';

export function openerFor(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } | undefined {
  if (!url.startsWith('https://')) return undefined;
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return { command: 'xdg-open', args: [url] };
    default:
      return undefined;
  }
}

export function openInBrowser(url: string): Promise<boolean> {
  const opener = openerFor(process.platform, url);
  if (opener === undefined) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      // `execFile` runs the program with the link as one argument and no shell. The opener returns
      // as soon as it has handed the link over; its output is discarded.
      execFile(opener.command, opener.args, { windowsHide: true, timeout: 5_000 }, (error) =>
        resolve(error === null),
      );
    } catch {
      resolve(false);
    }
  });
}

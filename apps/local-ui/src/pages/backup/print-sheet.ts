// WP-R4 (§6.3): the one-page sheet with the recovery code. Built in memory and printed from a blank
// window: no download, no file, no URL, and the document is closed after printing. The code goes only
// into the new window's DOM text (never into an attribute, a URL or storage).
import { BACKUP_STRINGS as S } from './strings.js';

export interface SheetFacts {
  readonly code: string;
  readonly file: string;
  readonly date: string;
}

type Opener = (url: string, target: string, features: string) => Window | null;

/** True when the print window opened. `open` is injectable for tests. */
export function printSheet(
  facts: SheetFacts,
  open: Opener = (u, t, f) => window.open(u, t, f),
): boolean {
  const win = open('', '_blank', 'width=720,height=900');
  if (win === null) return false;
  const doc = win.document;
  doc.title = S.sheetTitle;
  const style = doc.createElement('style');
  style.textContent =
    'body{font:16px/1.5 system-ui,sans-serif;margin:48px;color:#111}h1{font-size:24px}' +
    '.code{font:700 26px/1.4 ui-monospace,monospace;letter-spacing:.08em;margin:8px 0 24px}' +
    'dt{color:#555;font-size:13px;margin-top:12px}dd{margin:0}';
  doc.head.append(style);
  const h1 = doc.createElement('h1');
  h1.textContent = S.sheetTitle;
  const dl = doc.createElement('dl');
  const add = (term: string, value: string, cls?: string): void => {
    const dt = doc.createElement('dt');
    dt.textContent = term;
    const dd = doc.createElement('dd');
    if (cls !== undefined) dd.className = cls;
    dd.textContent = value;
    dl.append(dt, dd);
  };
  add(S.sheetCode, facts.code, 'code');
  add(S.sheetDate, facts.date);
  add(S.sheetFile, facts.file);
  const ol = doc.createElement('ol');
  for (const step of S.sheetSteps) {
    const li = doc.createElement('li');
    li.textContent = step;
    ol.append(li);
  }
  const keep = doc.createElement('p');
  keep.textContent = S.sheetKeep;
  doc.body.append(h1, dl, ol, keep);
  win.focus();
  win.print();
  win.close();
  return true;
}

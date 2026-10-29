// U3-h: the one-time "Tidy up" note (b11 §29.7). The spec stores "hide for good" with the agents on
// the computer; no route for that exists yet (U3-c lists, switches). Until one does, this keeps the
// two facts (dismissed, Agents page opened) in this browser only, in a try/catch, and the note then
// shows again in another browser. Nothing is removed or hidden automatically.
const DISMISSED = 'agentlink:tidy-dismissed';
const OPENED = 'agentlink:agents-opened';

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function write(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* no storage: the note simply shows again */
  }
}

export const tidyDismissed = (): boolean => read(DISMISSED);
export const dismissTidy = (): void => write(DISMISSED);
export const agentsOpened = (): boolean => read(OPENED);
export const markAgentsOpened = (): void => write(OPENED);

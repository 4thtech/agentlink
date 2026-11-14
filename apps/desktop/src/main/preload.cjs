// FILES-FOLDER-PICKER (D-161): the window's one preload. Sandboxed, context-isolated: it exposes
// exactly one function to the page, `window.agentlinkDesktop.chooseFolder({purpose, current?})`,
// which resolves ONE absolute folder path the person picked in the native dialog, or null.
// - Only on a fresh user activation (a real click or key press; a script can't make one).
// - One dialog at a time. Only `purpose` ('send' | 'inbox') and a short `current` path are sent.
// - Never rejects, never returns anything but a string or null.
// The main process checks the caller again (folder-picker.ts) and the page still runs the full
// server review and the owner's confirm: the path grants nothing by itself.
'use strict';
/* global require */

// A sandboxed preload is a CommonJS script: `require('electron')` is its only way in.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL = 'agentlink:choose-folder';
const MAX_PATH_CHARS = 4096;
let open = false;

function activated() {
  try {
    const activation = globalThis.navigator && globalThis.navigator.userActivation;
    return Boolean(activation && activation.isActive === true);
  } catch {
    return false;
  }
}

function chooseFolder(request) {
  if (open || !activated()) return Promise.resolve(null);
  const purpose = request !== null && typeof request === 'object' ? request.purpose : undefined;
  if (purpose !== 'send' && purpose !== 'inbox') return Promise.resolve(null);
  const current = request.current;
  const message =
    typeof current === 'string' && current.length > 0 && current.length <= MAX_PATH_CHARS
      ? { purpose, current }
      : { purpose };
  open = true;
  return ipcRenderer
    .invoke(CHANNEL, message)
    .then(
      (picked) => (typeof picked === 'string' && picked.length > 0 ? picked : null),
      () => null,
    )
    .finally(() => {
      open = false;
    });
}

contextBridge.exposeInMainWorld('agentlinkDesktop', Object.freeze({ chooseFolder }));
